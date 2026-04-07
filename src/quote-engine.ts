/**
 * Quote Engine — translates 1CS quotes into x402 PaymentRequirements.
 *
 * This module is the  translation layer between the NEAR Intents
 * 1Click Swap API and the x402 payment protocol. It:
 *
 * 1. Calls `POST /v0/quote` with `swapType: EXACT_OUTPUT`
 * 2. Maps the 1CS response into an x402 `PaymentRequirements` object
 * 3. Persists a new `SwapState` (phase = QUOTED) in the store
 * 4. Returns both for the middleware to build the 402 response
 *
 */

import type { GatewayConfig } from "./config.js";
import type { QuoteResponse } from "./types.js";
import {
  OneClickService,
  OpenAPI,
  OneClickApiError,
  QuoteRequest,
} from "./types.js";
import type {
  PaymentRequirementsRecord,
  QuoteResponseRecord,
  SwapState,
  StateStore,
  AssetTransferMethod,
} from "./types.js";
import {
  QuoteUnavailableError,
  AuthenticationError,
  ServiceUnavailableError,
  DeadlineTooShortError,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════

/** Result of a successful quote-to-requirements build. */
export interface BuildPaymentRequirementsResult {
  /** The x402 PaymentRequirements to include in the 402 response. */
  requirements: PaymentRequirementsRecord;
  /** The SwapState that was persisted to the store (phase = QUOTED). */
  state: SwapState;
}

/**
 * Function signature for requesting a 1CS quote.
 *
 * In production this delegates to `OneClickService.getQuote`; in tests
 * it can be replaced with a stub to avoid real HTTP calls.
 */
export type QuoteFn = (
  request: Parameters<typeof OneClickService.getQuote>[0],
) => Promise<QuoteResponse>;

/** Default production implementation — calls the real 1CS SDK. */
export const defaultQuoteFn: QuoteFn = (request) =>
  OneClickService.getQuote(request);

/**
 * Build an x402 `PaymentRequirements` object by requesting a 1CS quote.
 *
 * Configures the 1CS SDK, calls `/v0/quote` with EXACT_OUTPUT, maps the
 * response to x402 fields, persists the new SwapState, and returns both.
 *
 * @param cfg          Validated gateway configuration.
 * @param store        State persistence layer.
 * @param _resourceUrl The URL of the protected resource (reserved for logging/tracing).
 * @param quoteFn      Injectable quote function (defaults to real 1CS SDK call).
 *
 * @throws {QuoteUnavailableError}   1CS returned 400 (bad asset pair, etc.)
 * @throws {AuthenticationError}     1CS returned 401 (JWT expired/invalid)
 * @throws {ServiceUnavailableError} 1CS returned 5xx or network error
 * @throws {DeadlineTooShortError}   Quote deadline leaves < quoteExpiryBufferSec
 */
export async function buildPaymentRequirements(
  cfg: GatewayConfig,
  store: StateStore,
  _resourceUrl: string,
  quoteFn: QuoteFn = defaultQuoteFn,
): Promise<BuildPaymentRequirementsResult> {
  // ── 1. Configure the 1CS SDK ──────────────────────────────────────
  configureOneClickSdk(cfg);

  // ── 2. Build the quote request ────────────────────────────────────
  const deadline = buildQuoteDeadline(cfg);
  const quoteRequest = buildQuoteRequest(cfg, deadline);

  // ── 3. Call 1CS /v0/quote ─────────────────────────────────────────
  const quoteResponse = await requestQuote(quoteRequest, quoteFn);

  // ── 4. Validate the response ──────────────────────────────────────
  const depositAddress = quoteResponse.quote.depositAddress;
  if (!depositAddress) {
    throw new QuoteUnavailableError(
      "1CS quote response missing depositAddress",
    );
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(depositAddress)) {
    throw new QuoteUnavailableError(
      `1CS quote returned invalid depositAddress: "${depositAddress}"`,
    );
  }

  // Validate amountIn is present and meaningful
  const amountIn = quoteResponse.quote.amountIn;
  if (!amountIn || amountIn === "0") {
    throw new QuoteUnavailableError(
      `1CS quote returned invalid amountIn: "${amountIn ?? "undefined"}"`,
    );
  }

  validateDeadline(quoteResponse, cfg);

  // ── 5. Map to x402 PaymentRequirements ────────────────────────────
  const requirements = mapToPaymentRequirements(quoteResponse, cfg);

  // ── 6. Persist SwapState ──────────────────────────────────────────
  const now = Date.now();
  const state: SwapState = {
    depositAddress,
    quoteResponse: toQuoteResponseRecord(quoteResponse),
    paymentRequirements: requirements,
    phase: "QUOTED",
    createdAt: now,
    updatedAt: now,
  };

  await store.create(depositAddress, state);

  return { requirements, state };
}

// ═══════════════════════════════════════════════════════════════════════
// Internal helpers (exported for unit testing where noted)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Configure the global 1CS SDK settings (base URL + JWT).
 *
 * The SDK uses a mutable singleton (`OpenAPI`) for config, so we set it
 * before each call. This is safe in a single-process gateway.
 */
export function configureOneClickSdk(cfg: GatewayConfig): void {
  OpenAPI.BASE = cfg.oneClickBaseUrl;
  OpenAPI.TOKEN = cfg.oneClickJwt;
}

/**
 * Compute an ISO-8601 deadline for the 1CS quote.
 *
 * We use the configured `maxPollTimeMs` plus a generous buffer so the
 * deposit address stays active long enough for the full settlement flow.
 * The deadline is the point after which 1CS will refund unmatched deposits.
 */
export function buildQuoteDeadline(cfg: GatewayConfig): string {
  // Give enough time for: buyer signing + on-chain tx + polling
  // Use maxPollTimeMs as the primary budget, add 2 minutes for signing + broadcast
  const deadlineMs = Date.now() + cfg.maxPollTimeMs + 120_000;
  return new Date(deadlineMs).toISOString();
}

/**
 * Construct the 1CS QuoteRequest.
 *
 * Key design decisions:
 * - `swapType: EXACT_OUTPUT` — the merchant specifies what they want to receive
 * - `dry: false` — we need a real deposit address
 * - `refundTo: gatewayRefundAddress` — Option A from research plan §7 (D2):
 *   at quote time the buyer is unknown, so refunds go to the gateway which
 *   routes them back to the buyer's address (known after verification)
 * - `depositType: ORIGIN_CHAIN` — the buyer deposits on the EVM origin chain
 * - `recipientType: DESTINATION_CHAIN` — merchant receives on the destination chain
 */
export function buildQuoteRequest(
  cfg: GatewayConfig,
  deadline: string,
): Parameters<typeof OneClickService.getQuote>[0] {
  return {
    dry: false,
    swapType: QuoteRequest.swapType.EXACT_OUTPUT,
    slippageTolerance: 50, // 0.5% — reasonable default for stablecoins
    originAsset: cfg.originAssetIn,
    depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
    destinationAsset: cfg.merchantAssetOut,
    amount: cfg.merchantAmountOut,
    refundTo: cfg.gatewayRefundAddress,
    refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
    recipient: cfg.merchantRecipient,
    recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
    deadline,
  };
}

/**
 * Call the 1CS `/v0/quote` endpoint, mapping SDK errors to gateway errors.
 */
async function requestQuote(
  quoteRequest: Parameters<typeof OneClickService.getQuote>[0],
  quoteFn: QuoteFn,
): Promise<QuoteResponse> {
  try {
    return await quoteFn(quoteRequest);
  } catch (err: unknown) {
    if (err instanceof OneClickApiError) {
      switch (err.status) {
        case 400:
          throw new QuoteUnavailableError(
            `1CS quote rejected (400): ${extractErrorMessage(err)}`,
          );
        case 401:
          throw new AuthenticationError(
            `1CS authentication failed (401): ${extractErrorMessage(err)}`,
          );
        default:
          if (err.status >= 500) {
            throw new ServiceUnavailableError(
              `1CS service error (${err.status}): ${extractErrorMessage(err)}`,
            );
          }
          throw new QuoteUnavailableError(
            `1CS unexpected error (${err.status}): ${extractErrorMessage(err)}`,
          );
      }
    }
    // Network error or other non-HTTP failure
    throw new ServiceUnavailableError(
      `1CS unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Validate that the quote deadline leaves enough time for the full flow.
 *
 * The 1CS quote includes a `deadline` field — if fewer than
 * `quoteExpiryBufferSec` seconds remain, we reject the quote.
 */
export function validateDeadline(quoteResponse: QuoteResponse, cfg: GatewayConfig): void {
  const quoteDeadline = quoteResponse.quote.deadline;
  if (!quoteDeadline) {
    // No deadline means the quote doesn't expire (unlikely for non-dry).
    return;
  }

  const deadlineMs = new Date(quoteDeadline).getTime();
  const remainingSec = (deadlineMs - Date.now()) / 1_000;

  if (remainingSec < cfg.quoteExpiryBufferSec) {
    throw new DeadlineTooShortError(
      `1CS quote deadline too short: ${remainingSec.toFixed(0)}s remaining, ` +
        `need at least ${cfg.quoteExpiryBufferSec}s`,
    );
  }
}

/**
 * Map a 1CS QuoteResponse to an x402 PaymentRequirements record.
 *
 * Field mapping (from research plan §4):
 *
 * | x402 field          | Source                    | Derivation                                      |
 * |---------------------|---------------------------|-------------------------------------------------|
 * | scheme              | static                    | "exact" — standard EVM exact scheme              |
 * | network             | cfg.originNetwork         | CAIP-2 chain ID (e.g. "eip155:8453")             |
 * | asset               | cfg.originTokenAddress    | ERC-20 contract address on origin chain          |
 * | amount              | quote.amountIn            | SDK's amountIn = docs' maxAmountIn (upper bound) |
 * | payTo               | quote.depositAddress      | 1CS deposit address (the critical trick)         |
 * | maxTimeoutSeconds   | quote.deadline - now       | seconds until deadline, minus safety buffer      |
 * | extra.name          | cfg.tokenName             | EIP-712 domain name (e.g. "USD Coin")            |
 * | extra.version       | cfg.tokenVersion          | EIP-712 domain version (e.g. "2")                |
 * | extra.assetTransferMethod | cfg.tokenSupportsEip3009 | "eip3009" if supported, else "permit2"    |
 */
export function mapToPaymentRequirements(
  quoteResponse: QuoteResponse,
  cfg: GatewayConfig,
): PaymentRequirementsRecord {
  const quote = quoteResponse.quote;
  const depositAddress = quote.depositAddress!;

  // Calculate maxTimeoutSeconds from the quote deadline
  const maxTimeoutSeconds = computeMaxTimeoutSeconds(quote.deadline, cfg.quoteExpiryBufferSec);

  // Determine asset transfer method from config
  const assetTransferMethod: AssetTransferMethod = cfg.tokenSupportsEip3009
    ? "eip3009"
    : "permit2";

  return {
    scheme: "exact",
    network: cfg.originNetwork,
    asset: cfg.originTokenAddress,
    // For EXACT_OUTPUT quotes, the 1CS docs describe the response as having
    // "two fields minAmountIn and maxAmountIn". However, the SDK type names
    // the upper bound `amountIn` (not `maxAmountIn`). The lower bound is
    // `minAmountIn`. We use `amountIn` (the upper bound / maxAmountIn) as
    // the x402 payment amount so the buyer's signed authorization covers
    // the worst-case price. If the actual execution price is better, 1CS
    // refunds the difference to the refundTo address.
    //
    // @see https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote
    amount: quote.amountIn,
    // The fundamental trick: payTo is the 1CS deposit address, not the merchant.
    payTo: depositAddress,
    maxTimeoutSeconds,
    extra: {
      name: cfg.tokenName,
      version: cfg.tokenVersion,
      assetTransferMethod,
    },
  };
}

/**
 * Compute `maxTimeoutSeconds` from a 1CS deadline string.
 *
 * Returns the number of seconds between now and the deadline, minus the
 * safety buffer. Falls back to a generous 10-minute timeout if no
 * deadline is provided.
 */
export function computeMaxTimeoutSeconds(
  deadline: string | undefined,
  bufferSec: number,
): number {
  if (!deadline) {
    return 600; // 10-minute fallback
  }
  const deadlineMs = new Date(deadline).getTime();
  const remainingSec = Math.floor((deadlineMs - Date.now()) / 1_000);
  // Subtract buffer so the buyer's signed auth expires before the deposit address does
  return Math.max(remainingSec - bufferSec, 60); // floor at 60s minimum
}

/**
 * Convert an SDK `QuoteResponse` to our serialization-safe `QuoteResponseRecord`.
 */
export function toQuoteResponseRecord(qr: QuoteResponse): QuoteResponseRecord {
  return {
    correlationId: qr.correlationId,
    timestamp: qr.timestamp,
    signature: qr.signature,
    // Store the full quoteRequest as a generic record for serialization
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    quoteRequest: qr.quoteRequest as unknown as Record<string, unknown>,
    quote: {
      depositAddress: qr.quote.depositAddress,
      depositMemo: qr.quote.depositMemo,
      amountIn: qr.quote.amountIn,
      amountInFormatted: qr.quote.amountInFormatted,
      amountInUsd: qr.quote.amountInUsd,
      minAmountIn: qr.quote.minAmountIn,
      amountOut: qr.quote.amountOut,
      amountOutFormatted: qr.quote.amountOutFormatted,
      amountOutUsd: qr.quote.amountOutUsd,
      minAmountOut: qr.quote.minAmountOut,
      deadline: qr.quote.deadline,
      timeWhenInactive: qr.quote.timeWhenInactive,
      timeEstimate: qr.quote.timeEstimate,
      refundFee: qr.quote.refundFee,
    },
  };
}

/**
 * Extract a human-readable error message from a 1CS ApiError body.
 */
function extractErrorMessage(err: InstanceType<typeof OneClickApiError>): string {
  if (err.body && typeof err.body === "object" && "message" in err.body) {
    return String((err.body as { message: unknown }).message);
  }
  return err.statusText || err.message;
}
