/**
 * Settler — broadcasts the on-chain transfer and shepherds the 1CS swap to completion.
 *
 * This module handles Step 1.4 of the implementation roadmap. After the verifier
 * confirms the buyer's payment signature (phase = VERIFIED), the settler:
 *
 * 1. **Broadcasts** the buyer's signed authorization on-chain (EIP-3009 or Permit2)
 * 2. **Notifies** the 1CS API of the deposit transaction (`POST /v0/deposit/submit`)
 * 3. **Polls** the 1CS status endpoint until a terminal status is reached
 * 4. **Builds** the x402 `SettleResponse` (PAYMENT-RESPONSE header) from the result
 *
 * Design decisions (from settler-implementation-plan.docx, all "recommended"):
 * - D-S1: Dynamic gas estimation via `estimateGas()` + 20% buffer
 * - D-S2: 1 block confirmation for v1 (targeting L2s like Base)
 * - D-S3: Pre-check nonce via `authorizationState` before broadcasting
 * - D-S4: FAILED/REFUNDED → SwapFailedError(502), manual refund in Phase 3
 * - D-S5: Injectable deps (BroadcastFn, DepositNotifyFn, StatusPollFn)
 * - D-S6: Happy-path only for v1; state store sufficient for Phase 3 recovery
 *
 * @module settler
 * @see Research plan §5 — Settler module
 * @see Implementation roadmap Step 1.4
 */

import { ethers } from "ethers";
import type { GatewayConfig } from "./config.js";
import { configureOneClickSdk } from "./quote-engine.js";
import type {
  StateStore,
  SwapState,
  PaymentPayloadRecord,
  SettlementResponseRecord,
  CrossChainSettlementExtra,
  OneClickStatus,
  RefundInfo,
} from "./types.js";
import {
  OneClickService,
  TERMINAL_STATUSES,
  SwapFailedError,
  SwapTimeoutError,
  InsufficientGasError,
  GatewayError,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════════════
// Per-call timeout utility
// ═══════════════════════════════════════════════════════════════════════

/** Default per-call timeout for broadcast operations (30s). */
const BROADCAST_TIMEOUT_MS = 30_000;

/** Default per-call timeout for individual poll calls (15s). */
const POLL_CALL_TIMEOUT_MS = 15_000;

/**
 * Wrap a promise with a per-call timeout.
 * Rejects with a descriptive error if the operation exceeds the deadline.
 */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
import {
  isEIP3009Payload,
  isPermit2Payload,
  eip3009ABI,
  x402ExactPermit2ProxyABI,
  x402ExactPermit2ProxyAddress,
} from "@x402/evm";
import type {
  ExactEIP3009Payload,
  ExactPermit2Payload,
  ExactEvmPayloadV2,
} from "@x402/evm";

// ═══════════════════════════════════════════════════════════════════════
// Injectable dependency types
// ═══════════════════════════════════════════════════════════════════════

/**
 * Broadcasts a signed transaction and returns the confirmed receipt.
 *
 * In production, backed by an ethers.js `Wallet` connected to a provider.
 * In tests, replaced with a stub returning a mock receipt.
 */
export interface BroadcastFn {
  /**
   * Broadcast an EIP-3009 transferWithAuthorization.
   *
   * @param tokenAddress ERC-20 contract address.
   * @param auth         Authorization parameters from the payload.
   * @param signature    The buyer's EIP-712 signature.
   * @param gasOptions   Gas estimation overrides.
   * @returns The confirmed transaction hash.
   */
  broadcastEIP3009(
    tokenAddress: string,
    auth: ExactEIP3009Payload["authorization"],
    signature: string,
    gasOptions?: GasOptions,
  ): Promise<BroadcastResult>;

  /**
   * Broadcast a Permit2 settle call via the x402ExactPermit2Proxy.
   *
   * @param permit2Auth  Permit2 authorization from the payload.
   * @param signature    The buyer's EIP-712 signature.
   * @param gasOptions   Gas estimation overrides.
   * @returns The confirmed transaction hash.
   */
  broadcastPermit2(
    permit2Auth: ExactPermit2Payload["permit2Authorization"],
    signature: string,
    gasOptions?: GasOptions,
  ): Promise<BroadcastResult>;

  /**
   * Check if an EIP-3009 authorization nonce has already been used.
   *
   * @param tokenAddress ERC-20 contract address.
   * @param authorizer   The signer's address.
   * @param nonce        The authorization nonce (bytes32).
   * @returns true if the nonce is already consumed.
   */
  checkAuthorizationState(
    tokenAddress: string,
    authorizer: string,
    nonce: string,
  ): Promise<boolean>;

  /**
   * Get the facilitator wallet's native token balance (for gas checks).
   */
  getFacilitatorBalance(): Promise<bigint>;
}

/**
 * Notifies the 1CS API that a deposit transaction has been broadcast.
 *
 * In production, calls `OneClickService.submitDepositTx`.
 * In tests, replaced with a stub.
 */
export type DepositNotifyFn = (
  txHash: string,
  depositAddress: string,
) => Promise<DepositNotifyResult>;

/**
 * Polls the 1CS status endpoint for a single deposit address.
 *
 * In production, calls `OneClickService.getExecutionStatus`.
 * In tests, replaced with a stub.
 */
export type StatusPollFn = (
  depositAddress: string,
) => Promise<StatusPollResult>;

// ═══════════════════════════════════════════════════════════════════════
// Supporting types
// ═══════════════════════════════════════════════════════════════════════

export interface GasOptions {
  /** Gas limit override (skips estimateGas). */
  gasLimit?: bigint;
  /** Buffer multiplier for estimated gas (e.g. 1.2 for +20%). */
  gasBufferMultiplier?: number;
}

export interface BroadcastResult {
  txHash: string;
  blockNumber: number;
  gasUsed: bigint;
}

export interface DepositNotifyResult {
  status: string;
  correlationId?: string;
}

export interface StatusPollResult {
  status: OneClickStatus;
  swapDetails?: {
    originChainTxHashes?: Array<{ hash: string; explorerUrl: string }>;
    destinationChainTxHashes?: Array<{ hash: string; explorerUrl: string }>;
    refundedAmount?: string;
    amountIn?: string;
    amountOut?: string;
  };
}

export interface SettlerOptions {
  /**
   * Minimum gas balance (in wei) the facilitator needs to broadcast.
   * @default 1_000_000_000_000_000n (0.001 ETH)
   */
  minGasBalance?: bigint;

  /**
   * Gas buffer multiplier for `estimateGas()`.
   * @default 1.2 (+20%)
   */
  gasBufferMultiplier?: number;

  /**
   * Number of block confirmations to wait after broadcast.
   * @default 1 (suitable for L2s like Base)
   */
  confirmations?: number;
}

// ═══════════════════════════════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════════════════════════════

/**
 * Settle a verified payment by broadcasting the on-chain tx,
 * notifying 1CS, polling for completion, and building the response.
 *
 * This is the main entry point for the settler module. It expects the
 * swap state to be in `VERIFIED` phase (set by the verifier).
 *
 * @param depositAddress  The 1CS deposit address (primary key in the store).
 * @param store           State persistence layer.
 * @param broadcastFn     Injectable broadcaster.
 * @param depositNotifyFn Injectable 1CS deposit notification.
 * @param statusPollFn    Injectable 1CS status poller.
 * @param cfg             Validated gateway configuration.
 * @param options         Optional settler configuration.
 *
 * @returns SettlementResponseRecord for the PAYMENT-RESPONSE header.
 *
 * @throws {SwapFailedError}       1CS swap reached FAILED or REFUNDED.
 * @throws {SwapTimeoutError}      Polling exceeded maxPollTimeMs.
 * @throws {InsufficientGasError}  Facilitator wallet lacks gas funds.
 * @throws {GatewayError}          Other settlement failures.
 */
export async function settlePayment(
  depositAddress: string,
  store: StateStore,
  broadcastFn: BroadcastFn,
  depositNotifyFn: DepositNotifyFn,
  statusPollFn: StatusPollFn,
  cfg: GatewayConfig,
  options: SettlerOptions = {},
): Promise<SettlementResponseRecord> {
  // ── 1. Load and validate state ────────────────────────────────────
  const state = await store.get(depositAddress);
  if (!state) {
    throw new GatewayError(
      `No swap state found for deposit address: ${depositAddress}`,
      "STATE_NOT_FOUND",
      500,
    );
  }

  if (state.phase !== "VERIFIED") {
    // If already settled, return cached response
    if (state.phase === "SETTLED" && state.settlementResponse) {
      return state.settlementResponse;
    }
    throw new GatewayError(
      `Cannot settle swap in phase ${state.phase}; expected VERIFIED`,
      "INVALID_PHASE",
      500,
    );
  }

  if (!state.paymentPayload || !state.signerAddress) {
    throw new GatewayError(
      "Swap state is missing paymentPayload or signerAddress",
      "INCOMPLETE_STATE",
      500,
    );
  }

  // ── 2. Check facilitator gas balance ──────────────────────────────
  const minGas = options.minGasBalance ?? 1_000_000_000_000_000n; // 0.001 ETH
  try {
    const balance = await broadcastFn.getFacilitatorBalance();
    if (balance < minGas) {
      throw new InsufficientGasError(
        `Facilitator gas balance too low: ${balance.toString()} wei, need at least ${minGas.toString()} wei`,
      );
    }
  } catch (err) {
    if (err instanceof InsufficientGasError) throw err;
    // Non-fatal: if we can't check balance, proceed optimistically
  }

  // ── 3. Broadcast the on-chain transaction ─────────────────────────
  let broadcastResult: BroadcastResult;
  try {
    await store.update(depositAddress, { phase: "BROADCASTING" });

    broadcastResult = await withTimeout(
      broadcastTransaction(
        state.paymentPayload,
        state.paymentRequirements.asset,
        broadcastFn,
        options,
      ),
      BROADCAST_TIMEOUT_MS,
      "Broadcast",
    );

    await store.update(depositAddress, {
      phase: "BROADCAST",
      originTxHash: broadcastResult.txHash,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await failSwap(store, depositAddress, `Broadcast failed: ${errorMsg}`);
    throw err instanceof GatewayError
      ? err
      : new GatewayError(`Broadcast failed: ${errorMsg}`, "BROADCAST_FAILED", 502);
  }

  // ── 4. Notify 1CS of the deposit ──────────────────────────────────
  try {
    configureOneClickSdk(cfg);
    await depositNotifyFn(broadcastResult.txHash, depositAddress);
  } catch {
    // Non-fatal: 1CS may detect the deposit on its own via chain monitoring.
    // We log and continue to polling.
  }

  // ── 5. Poll 1CS for terminal status ───────────────────────────────
  let pollResult: StatusPollResult;
  try {
    await store.update(depositAddress, { phase: "POLLING" });

    pollResult = await pollUntilTerminal(
      depositAddress,
      statusPollFn,
      store,
      cfg,
    );
  } catch (err) {
    if (err instanceof SwapTimeoutError || err instanceof SwapFailedError) {
      const errorMsg = err.message;
      await failSwap(store, depositAddress, errorMsg);
      throw err;
    }
    const errorMsg = err instanceof Error ? err.message : String(err);
    await failSwap(store, depositAddress, `Polling failed: ${errorMsg}`);
    throw new GatewayError(`Polling failed: ${errorMsg}`, "POLL_FAILED", 502);
  }

  // ── 6. Build the settlement response ──────────────────────────────
  const response = buildSettlementResponse(
    state,
    broadcastResult,
    pollResult,
    cfg,
  );

  // ── 7. Finalize state ─────────────────────────────────────────────
  await store.update(depositAddress, {
    phase: "SETTLED",
    settlementResponse: response,
    oneClickStatus: pollResult.status,
    settledAt: Date.now(),
  });

  return response;
}

// ═══════════════════════════════════════════════════════════════════════
// Sub-step A: Broadcast
// ═══════════════════════════════════════════════════════════════════════

/**
 * Route the broadcast to the correct method based on payload type.
 */
async function broadcastTransaction(
  paymentPayload: PaymentPayloadRecord,
  tokenAddress: string,
  broadcastFn: BroadcastFn,
  options: SettlerOptions,
): Promise<BroadcastResult> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const payload: ExactEvmPayloadV2 = paymentPayload.payload as unknown as ExactEvmPayloadV2;
  const gasOptions: GasOptions = {
    gasBufferMultiplier: options.gasBufferMultiplier ?? 1.2,
  };

  if (isEIP3009Payload(payload)) {
    return broadcastEIP3009(payload, tokenAddress, broadcastFn, gasOptions);
  } else if (isPermit2Payload(payload)) {
    return broadcastPermit2(payload, broadcastFn, gasOptions);
  } else {
    throw new GatewayError(
      "Cannot broadcast: unrecognized payload format",
      "UNKNOWN_PAYLOAD",
      500,
    );
  }
}

/**
 * Broadcast an EIP-3009 transferWithAuthorization.
 *
 * D-S3: Pre-checks `authorizationState` to detect already-used nonces
 * before wasting gas on a transaction that would revert.
 */
async function broadcastEIP3009(
  payload: ExactEIP3009Payload,
  tokenAddress: string,
  broadcastFn: BroadcastFn,
  gasOptions: GasOptions,
): Promise<BroadcastResult> {
  const auth = payload.authorization;
  const signature = payload.signature ?? extractSignatureFromAuth(auth);

  if (!signature) {
    throw new GatewayError(
      "No signature found in EIP-3009 payload for broadcast",
      "MISSING_SIGNATURE",
      500,
    );
  }

  // D-S3: Pre-check nonce to avoid broadcasting a doomed tx
  try {
    const nonceUsed = await broadcastFn.checkAuthorizationState(
      tokenAddress,
      auth.from,
      auth.nonce,
    );
    if (nonceUsed) {
      throw new GatewayError(
        `EIP-3009 authorization nonce already used: ${auth.nonce}`,
        "NONCE_ALREADY_USED",
        409,
      );
    }
  } catch (err) {
    if (err instanceof GatewayError) throw err;
    // Non-fatal: if we can't check nonce state, proceed optimistically
  }

  return broadcastFn.broadcastEIP3009(
    tokenAddress,
    auth,
    signature,
    gasOptions,
  );
}

/**
 * Broadcast a Permit2 settle call via the x402ExactPermit2Proxy.
 */
async function broadcastPermit2(
  payload: ExactPermit2Payload,
  broadcastFn: BroadcastFn,
  gasOptions: GasOptions,
): Promise<BroadcastResult> {
  return broadcastFn.broadcastPermit2(
    payload.permit2Authorization,
    payload.signature,
    gasOptions,
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Sub-step C: Poll
// ═══════════════════════════════════════════════════════════════════════

/**
 * Poll the 1CS status endpoint with exponential backoff until a terminal
 * status is reached or the maximum polling time is exceeded.
 *
 * Uses `cfg.pollIntervalBaseMs`, `cfg.pollIntervalMaxMs`, and
 * `cfg.maxPollTimeMs` for timing.
 *
 * @throws {SwapTimeoutError} if polling exceeds maxPollTimeMs.
 * @throws {SwapFailedError}  if 1CS reports FAILED or REFUNDED.
 */
export async function pollUntilTerminal(
  depositAddress: string,
  statusPollFn: StatusPollFn,
  store: StateStore,
  cfg: GatewayConfig,
): Promise<StatusPollResult> {
  const startTime = Date.now();
  let interval = cfg.pollIntervalBaseMs;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Check timeout
    const elapsed = Date.now() - startTime;
    if (elapsed >= cfg.maxPollTimeMs) {
      throw new SwapTimeoutError(
        `1CS status polling timed out after ${Math.round(elapsed / 1000)}s ` +
          `(limit: ${Math.round(cfg.maxPollTimeMs / 1000)}s)`,
      );
    }

    // Wait before polling (except on first iteration)
    await sleep(interval);

    // Poll (with per-call timeout to prevent a single hung request from blocking the loop)
    let result: StatusPollResult;
    try {
      result = await withTimeout(
        statusPollFn(depositAddress),
        POLL_CALL_TIMEOUT_MS,
        "Status poll",
      );
    } catch (err) {
      // Non-fatal poll error — retry on next interval
      interval = Math.min(interval * 2, cfg.pollIntervalMaxMs);
      continue;
    }

    // Update stored status for observability
    await store.update(depositAddress, {
      oneClickStatus: result.status,
    });

    // Check for terminal status
    if (TERMINAL_STATUSES.has(result.status)) {
      if (result.status === "SUCCESS") {
        return result;
      }

      // FAILED or REFUNDED
      const refundInfo: RefundInfo | undefined = result.swapDetails?.refundedAmount
        ? {
            buyerAddress: "", // Will be filled from state by caller
            amount: result.swapDetails.refundedAmount,
            reason: `1CS swap ${result.status}`,
          }
        : undefined;

      throw new SwapFailedError(
        `1CS swap reached terminal status: ${result.status}`,
        result.status,
        refundInfo,
      );
    }

    // Exponential backoff (capped)
    interval = Math.min(interval * 2, cfg.pollIntervalMaxMs);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Sub-step D: Build response
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build the x402 `SettlementResponseRecord` from the broadcast and poll results.
 *
 * This is returned in the `PAYMENT-RESPONSE` header as a JSON-encoded string.
 * Includes cross-chain settlement metadata in the `extra` field.
 */
export function buildSettlementResponse(
  state: SwapState,
  broadcastResult: BroadcastResult,
  pollResult: StatusPollResult,
  cfg: GatewayConfig,
): SettlementResponseRecord {
  const extra: CrossChainSettlementExtra = {
    settlementType: "crosschain-1cs",
    destinationTxHashes: pollResult.swapDetails?.destinationChainTxHashes,
    destinationChain: extractDestinationChain(cfg.merchantAssetOut),
    destinationAmount: pollResult.swapDetails?.amountOut,
    destinationAsset: cfg.merchantAssetOut,
    swapStatus: pollResult.status,
    correlationId: state.quoteResponse.correlationId,
  };

  return {
    success: true,
    payer: state.signerAddress,
    transaction: broadcastResult.txHash,
    network: cfg.originNetwork,
    amount: state.paymentRequirements.amount,
    extra,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Production dependency factories
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a production {@link BroadcastFn} from an ethers.js `Wallet`.
 *
 * The wallet must be connected to a provider for the origin chain.
 * D-S1: Uses dynamic `estimateGas()` + configurable buffer multiplier.
 * D-S2: Waits for 1 block confirmation.
 */
export function createBroadcastFn(
  wallet: ethers.Wallet,
  confirmations: number = 1,
): BroadcastFn {
  return {
    async broadcastEIP3009(
      tokenAddress: string,
      auth: ExactEIP3009Payload["authorization"],
      signature: string,
      gasOptions?: GasOptions,
    ): Promise<BroadcastResult> {
      const contract = new ethers.Contract(
        tokenAddress,
        eip3009ABI,
        wallet,
      );

      // Split ECDSA signature into v, r, s components
      const sig = ethers.Signature.from(signature);

      // D-S1: Dynamic gas estimation + buffer
      const gasLimit = gasOptions?.gasLimit ?? await estimateGasWithBuffer(
        contract,
        "transferWithAuthorization",
        [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, sig.v, sig.r, sig.s],
        gasOptions?.gasBufferMultiplier ?? 1.2,
      );

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const tx = await contract.getFunction("transferWithAuthorization")(
        auth.from,
        auth.to,
        auth.value,
        auth.validAfter,
        auth.validBefore,
        auth.nonce,
        sig.v,
        sig.r,
        sig.s,
        { gasLimit },
      );

      // D-S2: Wait for confirmation
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      const receipt = await tx.wait(confirmations);

      return {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        txHash: receipt.hash,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        blockNumber: receipt.blockNumber,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        gasUsed: receipt.gasUsed,
      };
    },

    async broadcastPermit2(
      permit2Auth: ExactPermit2Payload["permit2Authorization"],
      signature: string,
      gasOptions?: GasOptions,
    ): Promise<BroadcastResult> {
      const proxy = new ethers.Contract(
        x402ExactPermit2ProxyAddress,
        x402ExactPermit2ProxyABI,
        wallet,
      );

      // Build the permit struct for the proxy.settle() call
      const permit = {
        permitted: {
          token: permit2Auth.permitted.token,
          amount: permit2Auth.permitted.amount,
        },
        nonce: permit2Auth.nonce,
        deadline: permit2Auth.deadline,
      };

      const owner = permit2Auth.from;
      const witness = {
        to: permit2Auth.witness.to,
        validAfter: permit2Auth.witness.validAfter,
      };

      // D-S1: Dynamic gas estimation + buffer
      const gasLimit = gasOptions?.gasLimit ?? await estimateGasWithBuffer(
        proxy,
        "settle",
        [permit, owner, witness, signature],
        gasOptions?.gasBufferMultiplier ?? 1.2,
      );

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const tx = await proxy.getFunction("settle")(
        permit,
        owner,
        witness,
        signature,
        { gasLimit },
      );

      // D-S2: Wait for confirmation
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      const receipt = await tx.wait(confirmations);

      return {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        txHash: receipt.hash,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        blockNumber: receipt.blockNumber,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        gasUsed: receipt.gasUsed,
      };
    },

    async checkAuthorizationState(
      tokenAddress: string,
      authorizer: string,
      nonce: string,
    ): Promise<boolean> {
      const contract = new ethers.Contract(
        tokenAddress,
        eip3009ABI,
        wallet.provider,
      );
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const result = await contract.getFunction("authorizationState")(authorizer, nonce);
      return Boolean(result);
    },

    async getFacilitatorBalance(): Promise<bigint> {
      if (!wallet.provider) {
        throw new Error("Wallet has no provider");
      }
      return wallet.provider.getBalance(wallet.address);
    },
  };
}

/**
 * Create a production {@link DepositNotifyFn}.
 *
 * Wraps `OneClickService.submitDepositTx`.
 */
export function createDepositNotifyFn(): DepositNotifyFn {
  return async (txHash: string, depositAddress: string): Promise<DepositNotifyResult> => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const response = await OneClickService.submitDepositTx({
      txHash,
      depositAddress,
    });
    return {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      status: response.status,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      correlationId: response.correlationId,
    };
  };
}

/**
 * Create a production {@link StatusPollFn}.
 *
 * Wraps `OneClickService.getExecutionStatus`.
 */
export function createStatusPollFn(): StatusPollFn {
  return async (depositAddress: string): Promise<StatusPollResult> => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const response = await OneClickService.getExecutionStatus(depositAddress);
    return {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      status: response.status as OneClickStatus,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
      swapDetails: response.swapDetails
        ? {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
            originChainTxHashes: response.swapDetails.originChainTxHashes,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
            destinationChainTxHashes: response.swapDetails.destinationChainTxHashes,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
            refundedAmount: response.swapDetails.refundedAmount,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
            amountIn: response.swapDetails.amountIn,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
            amountOut: response.swapDetails.amountOut,
          }
        : undefined,
    };
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

/**
 * Estimate gas for a contract call and apply a buffer multiplier.
 *
 * D-S1: Dynamic `estimateGas()` + 20% buffer (default).
 */
async function estimateGasWithBuffer(
  contract: ethers.Contract,
  method: string,
  args: unknown[],
  bufferMultiplier: number,
): Promise<bigint> {
  try {
    const estimated = await contract.getFunction(method).estimateGas(...args);
    // Apply buffer: multiply by bufferMultiplier (e.g. 1.2 → +20%)
    return (estimated * BigInt(Math.round(bufferMultiplier * 100))) / 100n;
  } catch {
    // Fallback: use a generous default for ERC-20 interactions
    return 200_000n;
  }
}

/**
 * Transition a swap to FAILED state with an error message.
 */
async function failSwap(
  store: StateStore,
  depositAddress: string,
  error: string,
): Promise<void> {
  try {
    await store.update(depositAddress, {
      phase: "FAILED",
      error,
      settledAt: Date.now(),
    });
  } catch {
    // If we can't update the store, we still want to throw the original error
  }
}

/**
 * Extract the destination chain from a 1CS asset ID.
 *
 * Handles both short-form and NEP-141 canonical formats:
 *   - "near:nUSDC"              → "near"
 *   - "nep141:usdc.near"        → "near"  (inferred from `.near` suffix)
 *   - "nep141:base-0x833...omft.near" → "near"
 *   - "eip155:8453"             → "eip155:8453"
 *
 * For `nep141:` prefixed assets, the chain is inferred from the account name
 * (NEAR accounts end with `.near`). Falls back to the prefix before `:`.
 */
export function extractDestinationChain(assetId: string): string {
  const colonIndex = assetId.indexOf(":");
  if (colonIndex <= 0) return assetId;

  const prefix = assetId.substring(0, colonIndex);
  const rest = assetId.substring(colonIndex + 1);

  // NEP-141 format: "nep141:<token-account>"
  // The chain is inferred from the NEAR account suffix
  if (prefix === "nep141") {
    if (rest.endsWith(".near")) return "near";
    if (rest.endsWith(".testnet")) return "near-testnet";
    // Fallback: assume NEAR for any nep141 asset
    return "near";
  }

  return prefix;
}

/**
 * Try to extract a signature from an EIP-3009 authorization when the
 * top-level `signature` field is not present.
 */
function extractSignatureFromAuth(
  auth: ExactEIP3009Payload["authorization"],
): string | undefined {
  const authAny = auth as Record<string, unknown>;
  if (typeof authAny.signature === "string" && authAny.signature.startsWith("0x")) {
    return authAny.signature;
  }
  return undefined;
}

/**
 * Promise-based sleep for polling intervals.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Expose sleep for test injection
export { sleep as _sleep };
