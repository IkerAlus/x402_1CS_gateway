/**
 * Tests for the Settler module.
 *
 * Uses injectable BroadcastFn, DepositNotifyFn, and StatusPollFn to avoid
 * real on-chain interactions and 1CS API calls. All dependencies are stubs
 * that return configurable values, following the same pattern established
 * in quote-engine.test.ts and verifier.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  settlePayment,
  pollUntilTerminal,
  buildSettlementResponse,
  extractDestinationChain,
  type BroadcastFn,
  type BroadcastResult,
  type DepositNotifyFn,
  type DepositNotifyResult,
  type StatusPollFn,
  type StatusPollResult,
  type SettlerOptions,
  type GasOptions,
} from "./settler.js";
import { InMemoryStateStore } from "./store.js";
import type {
  SwapState,
  PaymentPayloadRecord,
  PaymentRequirementsRecord,
  QuoteResponseRecord,
  SettlementResponseRecord,
  OneClickStatus,
} from "./types.js";
import {
  SwapFailedError,
  SwapTimeoutError,
  InsufficientGasError,
  GatewayError,
} from "./types.js";
import type { GatewayConfig } from "./config.js";
import type {
  ExactEIP3009Payload,
  ExactPermit2Payload,
} from "@x402/evm";
import { x402ExactPermit2ProxyAddress } from "@x402/evm";

// ═══════════════════════════════════════════════════════════════════════
// Test constants & helpers
// ═══════════════════════════════════════════════════════════════════════

const TEST_CHAIN_ID = 8453;
const TEST_NETWORK = "eip155:8453";
const TEST_TOKEN_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TEST_DEPOSIT_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const TEST_SIGNER_ADDRESS = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TEST_TX_HASH = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

function testConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    oneClickJwt: "test-jwt",
    oneClickBaseUrl: "https://1click.test",
    merchantRecipient: "merchant.near",
    merchantAssetOut: "near:nUSDC",
    merchantAmountOut: "10000000",
    originNetwork: TEST_NETWORK,
    originAssetIn: "base:USDC",
    originTokenAddress: TEST_TOKEN_ADDRESS,
    originRpcUrls: ["https://rpc.test"],
    facilitatorPrivateKey: "0x" + "ab".repeat(32),
    gatewayRefundAddress: "0x" + "cd".repeat(20),
    maxPollTimeMs: 300_000,
    pollIntervalBaseMs: 2_000,
    pollIntervalMaxMs: 30_000,
    quoteExpiryBufferSec: 30,
    tokenName: "USD Coin",
    tokenVersion: "2",
    tokenSupportsEip3009: true,
    ...overrides,
  };
}

function makeRequirements(
  overrides: Partial<PaymentRequirementsRecord> = {},
): PaymentRequirementsRecord {
  return {
    scheme: "exact",
    network: TEST_NETWORK,
    asset: TEST_TOKEN_ADDRESS,
    amount: "10500000",
    payTo: TEST_DEPOSIT_ADDRESS,
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
    ...overrides,
  };
}

function makeQuoteResponse(
  overrides: Partial<QuoteResponseRecord> = {},
): QuoteResponseRecord {
  return {
    correlationId: "corr-123",
    timestamp: new Date().toISOString(),
    signature: "sig-abc",
    quoteRequest: {},
    quote: {
      depositAddress: TEST_DEPOSIT_ADDRESS,
      amountIn: "10500000",
      amountInFormatted: "10.50",
      amountInUsd: "10.50",
      minAmountIn: "10400000",
      amountOut: "10000000",
      amountOutFormatted: "10.00",
      amountOutUsd: "10.00",
      minAmountOut: "9900000",
      deadline: new Date(Date.now() + 600_000).toISOString(),
      timeEstimate: 30,
    },
    ...overrides,
  };
}

function makeEIP3009Payload(): PaymentPayloadRecord {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    x402Version: 1,
    accepted: makeRequirements(),
    payload: {
      signature: "0x" + "ab".repeat(65),
      authorization: {
        from: TEST_SIGNER_ADDRESS,
        to: TEST_DEPOSIT_ADDRESS,
        value: "10500000",
        validAfter: "0",
        validBefore: String(nowSec + 300),
        nonce: "0x" + "11".repeat(32),
      },
    } satisfies ExactEIP3009Payload as unknown as Record<string, unknown>,
  };
}

function makePermit2Payload(): PaymentPayloadRecord {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    x402Version: 1,
    accepted: makeRequirements({
      extra: { name: "USD Coin", version: "2", assetTransferMethod: "permit2" },
    }),
    payload: {
      signature: "0x" + "cd".repeat(65),
      permit2Authorization: {
        from: TEST_SIGNER_ADDRESS,
        permitted: {
          token: TEST_TOKEN_ADDRESS,
          amount: "10500000",
        },
        spender: x402ExactPermit2ProxyAddress,
        nonce: "12345",
        deadline: String(nowSec + 300),
        witness: {
          to: TEST_DEPOSIT_ADDRESS,
          validAfter: "0",
        },
      },
    } satisfies ExactPermit2Payload as unknown as Record<string, unknown>,
  };
}

function makeVerifiedState(
  payloadOverride?: PaymentPayloadRecord,
): SwapState {
  return {
    depositAddress: TEST_DEPOSIT_ADDRESS,
    quoteResponse: makeQuoteResponse(),
    paymentRequirements: makeRequirements(),
    paymentPayload: payloadOverride ?? makeEIP3009Payload(),
    signerAddress: TEST_SIGNER_ADDRESS,
    phase: "VERIFIED",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ── Mock dependency factories ───────────────────────────────────────

function mockBroadcastFn(
  overrides: Partial<BroadcastFn> = {},
): BroadcastFn {
  return {
    broadcastEIP3009: vi.fn().mockResolvedValue({
      txHash: TEST_TX_HASH,
      blockNumber: 12345678,
      gasUsed: 65000n,
    } satisfies BroadcastResult),
    broadcastPermit2: vi.fn().mockResolvedValue({
      txHash: TEST_TX_HASH,
      blockNumber: 12345678,
      gasUsed: 85000n,
    } satisfies BroadcastResult),
    checkAuthorizationState: vi.fn().mockResolvedValue(false),
    getFacilitatorBalance: vi.fn().mockResolvedValue(
      1_000_000_000_000_000_000n, // 1 ETH
    ),
    ...overrides,
  };
}

function mockDepositNotifyFn(
  result?: DepositNotifyResult,
): DepositNotifyFn {
  return vi.fn().mockResolvedValue(
    result ?? { status: "KNOWN_DEPOSIT_TX", correlationId: "corr-123" },
  );
}

function mockStatusPollFn(
  results?: StatusPollResult[],
): StatusPollFn {
  if (!results) {
    return vi.fn().mockResolvedValue({
      status: "SUCCESS" as OneClickStatus,
      swapDetails: {
        originChainTxHashes: [{ hash: TEST_TX_HASH, explorerUrl: "https://basescan.org/tx/" + TEST_TX_HASH }],
        destinationChainTxHashes: [{ hash: "dest-hash", explorerUrl: "https://nearblocks.io/tx/dest-hash" }],
        amountIn: "10500000",
        amountOut: "10000000",
      },
    } satisfies StatusPollResult);
  }
  // Return results in sequence
  const fn = vi.fn();
  for (const r of results) {
    fn.mockResolvedValueOnce(r);
  }
  return fn;
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe("settler", () => {
  let store: InMemoryStateStore;
  let cfg: GatewayConfig;

  beforeEach(() => {
    store = new InMemoryStateStore();
    // Use short poll intervals for test speed
    cfg = testConfig({
      pollIntervalBaseMs: 1,
      pollIntervalMaxMs: 5,
      maxPollTimeMs: 5000,
    });
  });

  // ── settlePayment: happy path ─────────────────────────────────────

  describe("settlePayment — happy path (EIP-3009)", () => {
    it("should settle an EIP-3009 payment end-to-end", async () => {
      const state = makeVerifiedState();
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const broadcast = mockBroadcastFn();
      const notify = mockDepositNotifyFn();
      const poll = mockStatusPollFn();

      const response = await settlePayment(
        TEST_DEPOSIT_ADDRESS,
        store,
        broadcast,
        notify,
        poll,
        cfg,
      );

      // Verify response shape
      expect(response.success).toBe(true);
      expect(response.transaction).toBe(TEST_TX_HASH);
      expect(response.network).toBe(TEST_NETWORK);
      expect(response.payer).toBe(TEST_SIGNER_ADDRESS);
      expect(response.extra?.settlementType).toBe("crosschain-1cs");
      expect(response.extra?.swapStatus).toBe("SUCCESS");
      expect(response.extra?.correlationId).toBe("corr-123");

      // Verify state transitions
      const finalState = await store.get(TEST_DEPOSIT_ADDRESS);
      expect(finalState!.phase).toBe("SETTLED");
      expect(finalState!.originTxHash).toBe(TEST_TX_HASH);
      expect(finalState!.oneClickStatus).toBe("SUCCESS");
      expect(finalState!.settlementResponse).toBeDefined();
      expect(finalState!.settledAt).toBeGreaterThan(0);

      // Verify dependencies were called
      expect(broadcast.broadcastEIP3009).toHaveBeenCalledOnce();
      expect(broadcast.checkAuthorizationState).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledWith(TEST_TX_HASH, TEST_DEPOSIT_ADDRESS);
      expect(poll).toHaveBeenCalledWith(TEST_DEPOSIT_ADDRESS);
    });
  });

  describe("settlePayment — happy path (Permit2)", () => {
    it("should settle a Permit2 payment end-to-end", async () => {
      const state = makeVerifiedState(makePermit2Payload());
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const broadcast = mockBroadcastFn();
      const notify = mockDepositNotifyFn();
      const poll = mockStatusPollFn();

      const response = await settlePayment(
        TEST_DEPOSIT_ADDRESS,
        store,
        broadcast,
        notify,
        poll,
        cfg,
      );

      expect(response.success).toBe(true);
      expect(response.transaction).toBe(TEST_TX_HASH);
      expect(broadcast.broadcastPermit2).toHaveBeenCalledOnce();
      expect(broadcast.broadcastEIP3009).not.toHaveBeenCalled();
      // Permit2 doesn't use checkAuthorizationState
      expect(broadcast.checkAuthorizationState).not.toHaveBeenCalled();
    });
  });

  // ── settlePayment: state validation ───────────────────────────────

  describe("settlePayment — state validation", () => {
    it("should throw if no state found", async () => {
      const broadcast = mockBroadcastFn();
      const notify = mockDepositNotifyFn();
      const poll = mockStatusPollFn();

      await expect(
        settlePayment("0xnonexistent", store, broadcast, notify, poll, cfg),
      ).rejects.toThrow("No swap state found");
    });

    it("should throw if state is not in VERIFIED phase", async () => {
      const state = makeVerifiedState();
      state.phase = "QUOTED";
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const broadcast = mockBroadcastFn();
      const notify = mockDepositNotifyFn();
      const poll = mockStatusPollFn();

      await expect(
        settlePayment(TEST_DEPOSIT_ADDRESS, store, broadcast, notify, poll, cfg),
      ).rejects.toThrow("Cannot settle swap in phase QUOTED");
    });

    it("should return cached response if already SETTLED", async () => {
      const cachedResponse: SettlementResponseRecord = {
        success: true,
        payer: TEST_SIGNER_ADDRESS,
        transaction: TEST_TX_HASH,
        network: TEST_NETWORK,
        amount: "10500000",
      };
      const state = makeVerifiedState();
      state.phase = "SETTLED" as any;
      state.settlementResponse = cachedResponse;
      // Need to create directly since InMemoryStateStore doesn't validate on create
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const broadcast = mockBroadcastFn();
      const notify = mockDepositNotifyFn();
      const poll = mockStatusPollFn();

      const response = await settlePayment(
        TEST_DEPOSIT_ADDRESS,
        store,
        broadcast,
        notify,
        poll,
        cfg,
      );

      expect(response).toEqual(cachedResponse);
      // No broadcast should have been attempted
      expect(broadcast.broadcastEIP3009).not.toHaveBeenCalled();
    });

    it("should throw if paymentPayload is missing", async () => {
      const state = makeVerifiedState();
      delete state.paymentPayload;
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const broadcast = mockBroadcastFn();
      const notify = mockDepositNotifyFn();
      const poll = mockStatusPollFn();

      await expect(
        settlePayment(TEST_DEPOSIT_ADDRESS, store, broadcast, notify, poll, cfg),
      ).rejects.toThrow("missing paymentPayload or signerAddress");
    });
  });

  // ── settlePayment: gas checks ─────────────────────────────────────

  describe("settlePayment — gas checks", () => {
    it("should throw InsufficientGasError when balance is too low", async () => {
      const state = makeVerifiedState();
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const broadcast = mockBroadcastFn({
        getFacilitatorBalance: vi.fn().mockResolvedValue(100n), // Way too low
      });
      const notify = mockDepositNotifyFn();
      const poll = mockStatusPollFn();

      await expect(
        settlePayment(TEST_DEPOSIT_ADDRESS, store, broadcast, notify, poll, cfg),
      ).rejects.toThrow(InsufficientGasError);
    });

    it("should proceed if balance check fails (non-fatal)", async () => {
      const state = makeVerifiedState();
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const broadcast = mockBroadcastFn({
        getFacilitatorBalance: vi.fn().mockRejectedValue(new Error("RPC error")),
      });
      const notify = mockDepositNotifyFn();
      const poll = mockStatusPollFn();

      const response = await settlePayment(
        TEST_DEPOSIT_ADDRESS,
        store,
        broadcast,
        notify,
        poll,
        cfg,
      );

      expect(response.success).toBe(true);
    });

    it("should respect custom minGasBalance option", async () => {
      const state = makeVerifiedState();
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const broadcast = mockBroadcastFn({
        getFacilitatorBalance: vi.fn().mockResolvedValue(500n),
      });
      const notify = mockDepositNotifyFn();
      const poll = mockStatusPollFn();

      // With a very low threshold, 500 wei should be enough
      const response = await settlePayment(
        TEST_DEPOSIT_ADDRESS,
        store,
        broadcast,
        notify,
        poll,
        cfg,
        { minGasBalance: 100n },
      );

      expect(response.success).toBe(true);
    });
  });

  // ── settlePayment: nonce pre-check (D-S3) ────────────────────────

  describe("settlePayment — nonce pre-check (D-S3)", () => {
    it("should fail if EIP-3009 nonce is already used", async () => {
      const state = makeVerifiedState();
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const broadcast = mockBroadcastFn({
        checkAuthorizationState: vi.fn().mockResolvedValue(true), // Nonce used
      });
      const notify = mockDepositNotifyFn();
      const poll = mockStatusPollFn();

      await expect(
        settlePayment(TEST_DEPOSIT_ADDRESS, store, broadcast, notify, poll, cfg),
      ).rejects.toThrow("nonce already used");

      // State should be FAILED
      const finalState = await store.get(TEST_DEPOSIT_ADDRESS);
      expect(finalState!.phase).toBe("FAILED");
    });

    it("should proceed if nonce check fails (non-fatal)", async () => {
      const state = makeVerifiedState();
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const broadcast = mockBroadcastFn({
        checkAuthorizationState: vi.fn().mockRejectedValue(new Error("RPC down")),
      });
      const notify = mockDepositNotifyFn();
      const poll = mockStatusPollFn();

      const response = await settlePayment(
        TEST_DEPOSIT_ADDRESS,
        store,
        broadcast,
        notify,
        poll,
        cfg,
      );

      expect(response.success).toBe(true);
    });
  });

  // ── settlePayment: broadcast failures ─────────────────────────────

  describe("settlePayment — broadcast failures", () => {
    it("should fail swap and throw on broadcast error", async () => {
      const state = makeVerifiedState();
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const broadcast = mockBroadcastFn({
        broadcastEIP3009: vi.fn().mockRejectedValue(
          new Error("transaction reverted"),
        ),
      });
      const notify = mockDepositNotifyFn();
      const poll = mockStatusPollFn();

      await expect(
        settlePayment(TEST_DEPOSIT_ADDRESS, store, broadcast, notify, poll, cfg),
      ).rejects.toThrow("Broadcast failed");

      const finalState = await store.get(TEST_DEPOSIT_ADDRESS);
      expect(finalState!.phase).toBe("FAILED");
      expect(finalState!.error).toContain("Broadcast failed");
    });
  });

  // ── settlePayment: 1CS notification ───────────────────────────────

  describe("settlePayment — 1CS notification", () => {
    it("should continue if deposit notification fails (non-fatal)", async () => {
      const state = makeVerifiedState();
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const broadcast = mockBroadcastFn();
      const notify = vi.fn().mockRejectedValue(new Error("1CS unreachable"));
      const poll = mockStatusPollFn();

      const response = await settlePayment(
        TEST_DEPOSIT_ADDRESS,
        store,
        broadcast,
        notify,
        poll,
        cfg,
      );

      // Should still succeed — 1CS detects deposits via chain monitoring
      expect(response.success).toBe(true);
    });
  });

  // ── settlePayment: swap failure (D-S4) ────────────────────────────

  describe("settlePayment — swap failure (D-S4)", () => {
    it("should throw SwapFailedError when 1CS reports FAILED", async () => {
      const state = makeVerifiedState();
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const broadcast = mockBroadcastFn();
      const notify = mockDepositNotifyFn();
      const poll = mockStatusPollFn([
        { status: "PROCESSING" },
        { status: "FAILED", swapDetails: { refundedAmount: "10500000" } },
      ]);

      await expect(
        settlePayment(TEST_DEPOSIT_ADDRESS, store, broadcast, notify, poll, cfg, {
          // Use very short polling for tests
        }),
      ).rejects.toThrow(SwapFailedError);

      const finalState = await store.get(TEST_DEPOSIT_ADDRESS);
      expect(finalState!.phase).toBe("FAILED");
    });

    it("should throw SwapFailedError when 1CS reports REFUNDED", async () => {
      const state = makeVerifiedState();
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const broadcast = mockBroadcastFn();
      const notify = mockDepositNotifyFn();
      const poll = mockStatusPollFn([
        { status: "REFUNDED", swapDetails: { refundedAmount: "10500000" } },
      ]);

      await expect(
        settlePayment(TEST_DEPOSIT_ADDRESS, store, broadcast, notify, poll, cfg),
      ).rejects.toThrow(SwapFailedError);
    });
  });

  // ── settlePayment: timeout ────────────────────────────────────────

  describe("settlePayment — timeout", () => {
    it("should throw SwapTimeoutError when polling exceeds maxPollTimeMs", async () => {
      const state = makeVerifiedState();
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const broadcast = mockBroadcastFn();
      const notify = mockDepositNotifyFn();
      // Always return non-terminal status
      const poll = vi.fn().mockResolvedValue({
        status: "PROCESSING" as OneClickStatus,
      });

      // Use very short timeout for the test
      const shortCfg = testConfig({
        maxPollTimeMs: 50,
        pollIntervalBaseMs: 10,
        pollIntervalMaxMs: 20,
      });

      await expect(
        settlePayment(
          TEST_DEPOSIT_ADDRESS,
          store,
          broadcast,
          notify,
          poll,
          shortCfg,
        ),
      ).rejects.toThrow(SwapTimeoutError);

      const finalState = await store.get(TEST_DEPOSIT_ADDRESS);
      expect(finalState!.phase).toBe("FAILED");
    });
  });

  // ── settlePayment: phase transitions ──────────────────────────────

  describe("settlePayment — phase transitions", () => {
    it("should transition through VERIFIED → BROADCASTING → BROADCAST → POLLING → SETTLED", async () => {
      const state = makeVerifiedState();
      await store.create(TEST_DEPOSIT_ADDRESS, state);

      const phases: string[] = [];
      const originalUpdate = store.update.bind(store);
      store.update = async (addr, patch) => {
        if (patch.phase) phases.push(patch.phase);
        return originalUpdate(addr, patch);
      };

      const broadcast = mockBroadcastFn();
      const notify = mockDepositNotifyFn();
      const poll = mockStatusPollFn();

      await settlePayment(
        TEST_DEPOSIT_ADDRESS,
        store,
        broadcast,
        notify,
        poll,
        cfg,
      );

      expect(phases).toEqual([
        "BROADCASTING",
        "BROADCAST",
        "POLLING",
        "SETTLED",
      ]);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// pollUntilTerminal
// ═══════════════════════════════════════════════════════════════════════

describe("pollUntilTerminal", () => {
  let store: InMemoryStateStore;

  beforeEach(() => {
    store = new InMemoryStateStore();
  });

  it("should return immediately on SUCCESS", async () => {
    const state = makeVerifiedState();
    state.phase = "POLLING" as any;
    await store.create(TEST_DEPOSIT_ADDRESS, state);

    const cfg = testConfig({ pollIntervalBaseMs: 1, pollIntervalMaxMs: 5, maxPollTimeMs: 1000 });
    const poll = mockStatusPollFn([
      {
        status: "SUCCESS",
        swapDetails: {
          destinationChainTxHashes: [{ hash: "dest", explorerUrl: "url" }],
          amountOut: "10000000",
        },
      },
    ]);

    const result = await pollUntilTerminal(TEST_DEPOSIT_ADDRESS, poll, store, cfg);
    expect(result.status).toBe("SUCCESS");
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("should poll multiple times until terminal", async () => {
    const state = makeVerifiedState();
    state.phase = "POLLING" as any;
    await store.create(TEST_DEPOSIT_ADDRESS, state);

    const cfg = testConfig({ pollIntervalBaseMs: 1, pollIntervalMaxMs: 5, maxPollTimeMs: 5000 });
    const poll = mockStatusPollFn([
      { status: "PENDING_DEPOSIT" },
      { status: "KNOWN_DEPOSIT_TX" },
      { status: "PROCESSING" },
      { status: "SUCCESS", swapDetails: { amountOut: "10000000" } },
    ]);

    const result = await pollUntilTerminal(TEST_DEPOSIT_ADDRESS, poll, store, cfg);
    expect(result.status).toBe("SUCCESS");
    expect(poll).toHaveBeenCalledTimes(4);
  });

  it("should throw SwapFailedError on FAILED status", async () => {
    const state = makeVerifiedState();
    state.phase = "POLLING" as any;
    await store.create(TEST_DEPOSIT_ADDRESS, state);

    const cfg = testConfig({ pollIntervalBaseMs: 1, pollIntervalMaxMs: 5, maxPollTimeMs: 5000 });
    const poll = mockStatusPollFn([
      { status: "PROCESSING" },
      { status: "FAILED" },
    ]);

    await expect(
      pollUntilTerminal(TEST_DEPOSIT_ADDRESS, poll, store, cfg),
    ).rejects.toThrow(SwapFailedError);
  });

  it("should throw SwapTimeoutError when exceeding maxPollTimeMs", async () => {
    const state = makeVerifiedState();
    state.phase = "POLLING" as any;
    await store.create(TEST_DEPOSIT_ADDRESS, state);

    const cfg = testConfig({ pollIntervalBaseMs: 1, pollIntervalMaxMs: 2, maxPollTimeMs: 15 });
    const poll = vi.fn().mockResolvedValue({ status: "PROCESSING" });

    await expect(
      pollUntilTerminal(TEST_DEPOSIT_ADDRESS, poll, store, cfg),
    ).rejects.toThrow(SwapTimeoutError);
  });

  it("should retry on poll errors", async () => {
    const state = makeVerifiedState();
    state.phase = "POLLING" as any;
    await store.create(TEST_DEPOSIT_ADDRESS, state);

    const cfg = testConfig({ pollIntervalBaseMs: 1, pollIntervalMaxMs: 5, maxPollTimeMs: 5000 });
    const poll = vi.fn()
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockResolvedValueOnce({ status: "SUCCESS", swapDetails: { amountOut: "10000000" } });

    const result = await pollUntilTerminal(TEST_DEPOSIT_ADDRESS, poll, store, cfg);
    expect(result.status).toBe("SUCCESS");
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it("should include refund info in SwapFailedError for REFUNDED status", async () => {
    const state = makeVerifiedState();
    state.phase = "POLLING" as any;
    await store.create(TEST_DEPOSIT_ADDRESS, state);

    const cfg = testConfig({ pollIntervalBaseMs: 1, pollIntervalMaxMs: 5, maxPollTimeMs: 5000 });
    const poll = mockStatusPollFn([
      { status: "REFUNDED", swapDetails: { refundedAmount: "10500000" } },
    ]);

    try {
      await pollUntilTerminal(TEST_DEPOSIT_ADDRESS, poll, store, cfg);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SwapFailedError);
      const swapErr = err as SwapFailedError;
      expect(swapErr.swapStatus).toBe("REFUNDED");
      expect(swapErr.refundInfo?.amount).toBe("10500000");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// buildSettlementResponse
// ═══════════════════════════════════════════════════════════════════════

describe("buildSettlementResponse", () => {
  it("should build a complete settlement response", () => {
    const state = makeVerifiedState();
    const broadcastResult: BroadcastResult = {
      txHash: TEST_TX_HASH,
      blockNumber: 12345678,
      gasUsed: 65000n,
    };
    const pollResult: StatusPollResult = {
      status: "SUCCESS",
      swapDetails: {
        originChainTxHashes: [{ hash: TEST_TX_HASH, explorerUrl: "https://basescan.org/tx/" + TEST_TX_HASH }],
        destinationChainTxHashes: [{ hash: "dest-hash", explorerUrl: "https://nearblocks.io/tx/dest-hash" }],
        amountOut: "10000000",
      },
    };
    const cfg = testConfig();

    const response = buildSettlementResponse(state, broadcastResult, pollResult, cfg);

    expect(response.success).toBe(true);
    expect(response.payer).toBe(TEST_SIGNER_ADDRESS);
    expect(response.transaction).toBe(TEST_TX_HASH);
    expect(response.network).toBe(TEST_NETWORK);
    expect(response.amount).toBe("10500000");
    expect(response.extra).toBeDefined();
    expect(response.extra!.settlementType).toBe("crosschain-1cs");
    expect(response.extra!.swapStatus).toBe("SUCCESS");
    expect(response.extra!.destinationChain).toBe("near");
    expect(response.extra!.destinationAsset).toBe("near:nUSDC");
    expect(response.extra!.destinationAmount).toBe("10000000");
    expect(response.extra!.correlationId).toBe("corr-123");
    expect(response.extra!.destinationTxHashes).toEqual([
      { hash: "dest-hash", explorerUrl: "https://nearblocks.io/tx/dest-hash" },
    ]);
  });

  it("should handle missing swap details gracefully", () => {
    const state = makeVerifiedState();
    const broadcastResult: BroadcastResult = {
      txHash: TEST_TX_HASH,
      blockNumber: 12345678,
      gasUsed: 65000n,
    };
    const pollResult: StatusPollResult = {
      status: "SUCCESS",
    };
    const cfg = testConfig();

    const response = buildSettlementResponse(state, broadcastResult, pollResult, cfg);

    expect(response.success).toBe(true);
    expect(response.extra?.destinationTxHashes).toBeUndefined();
    expect(response.extra?.destinationAmount).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// extractDestinationChain
// ═══════════════════════════════════════════════════════════════════════

describe("extractDestinationChain", () => {
  it("should extract chain from short-form 1CS asset ID", () => {
    expect(extractDestinationChain("near:nUSDC")).toBe("near");
    expect(extractDestinationChain("ethereum:USDT")).toBe("ethereum");
    expect(extractDestinationChain("base:USDC")).toBe("base");
  });

  it("should return full string if no colon", () => {
    expect(extractDestinationChain("near")).toBe("near");
  });

  it("should extract EVM chain from NEP-141 OMFT-bridged asset IDs", () => {
    // Arbitrum USDC
    expect(extractDestinationChain(
      "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    )).toBe("eip155:42161");
    // Ethereum USDC
    expect(extractDestinationChain(
      "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
    )).toBe("eip155:1");
    // Base USDC
    expect(extractDestinationChain(
      "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    )).toBe("eip155:8453");
    // Optimism
    expect(extractDestinationChain(
      "nep141:op-0x0b2c639c533813f4aa9d7837caf62653d097ff85.omft.near",
    )).toBe("eip155:10");
    // Polygon
    expect(extractDestinationChain(
      "nep141:polygon-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359.omft.near",
    )).toBe("eip155:137");
  });

  it("should return 'near' for native NEAR NEP-141 assets", () => {
    // Native NEAR USDC (hex token account ID)
    expect(extractDestinationChain(
      "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    )).toBe("near");
    // Named NEAR token account
    expect(extractDestinationChain("nep141:usdc.near")).toBe("near");
    expect(extractDestinationChain("nep141:wrap.near")).toBe("near");
  });

  it("should return 'near-testnet' for testnet NEP-141 assets", () => {
    expect(extractDestinationChain("nep141:usdc.testnet")).toBe("near-testnet");
  });

  it("should pass through CAIP-2 identifiers", () => {
    expect(extractDestinationChain("eip155:8453")).toBe("eip155");
    expect(extractDestinationChain("eip155:1")).toBe("eip155");
  });
});
