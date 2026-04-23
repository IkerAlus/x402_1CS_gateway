import { describe, it, expect } from "vitest";
import {
  buildPaymentRequirements,
  configureOneClickSdk,
  buildQuoteRequest,
  buildQuoteDeadline,
  mapToPaymentRequirements,
  computeMaxTimeoutSeconds,
  validateDeadline,
  toQuoteResponseRecord,
  diagnoseQuoteRequest,
} from "./quote-engine.js";
import type { QuoteFn } from "./quote-engine.js";
import {
  QuoteUnavailableError,
  AuthenticationError,
  ServiceUnavailableError,
  DeadlineTooShortError,
  OneClickApiError,
  OpenAPI,
} from "../types.js";
import type { QuoteResponse } from "../types.js";
import type { GatewayConfig } from "../infra/config.js";
import type { SwapState, StateStore } from "../types.js";

// ═══════════════════════════════════════════════════════════════════════
// Test fixtures
// ═══════════════════════════════════════════════════════════════════════

/** Minimal valid gateway config for testing. */
function testConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  return {
    oneClickJwt: "test-jwt-token",
    oneClickBaseUrl: "https://1click.chaindefuser.com",
    merchantRecipient: "merchant.near",
    merchantAssetOut: "near:nUSDC",
    merchantAmountOut: "1000000",
    originNetwork: "eip155:8453",
    originAssetIn: "nep141:base-0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    originTokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    originRpcUrls: ["https://mainnet.base.org"],
    facilitatorPrivateKey: "0xdeadbeef",
    gatewayRefundAddress: "0x1234567890abcdef1234567890abcdef12345678",
    maxPollTimeMs: 300_000,
    pollIntervalBaseMs: 2_000,
    pollIntervalMaxMs: 30_000,
    quoteExpiryBufferSec: 30,
    tokenName: "USDC",
    tokenVersion: "2",
    tokenSupportsEip3009: true,
    ...overrides,
  };
}

/** A mock 1CS QuoteResponse with a deadline 10 minutes in the future. */
function mockQuoteResponse(overrides?: Partial<QuoteResponse["quote"]>): QuoteResponse {
  const deadline = new Date(Date.now() + 600_000).toISOString();
  return {
    correlationId: "corr-123",
    timestamp: new Date().toISOString(),
    signature: "mock-signature",
    quoteRequest: {
      dry: false,
      swapType: "EXACT_OUTPUT" as const,
      amount: "1000000",
      originAsset: "nep141:base-0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      destinationAsset: "near:nUSDC",
      recipient: "merchant.near",
      refundTo: "0x1234567890abcdef1234567890abcdef12345678",
      slippageTolerance: 50,
      depositType: "ORIGIN_CHAIN" as const,
      refundType: "ORIGIN_CHAIN" as const,
      recipientType: "DESTINATION_CHAIN" as const,
      deadline,
    },
    quote: {
      depositAddress: "0xDEADBEEF1234567890abcdef1234567890abcdef",
      amountIn: "1050000",
      amountInFormatted: "1.05",
      amountInUsd: "1.05",
      minAmountIn: "1000000",
      amountOut: "1000000",
      amountOutFormatted: "1.00",
      amountOutUsd: "1.00",
      minAmountOut: "990000",
      deadline,
      timeWhenInactive: new Date(Date.now() + 500_000).toISOString(),
      timeEstimate: 30,
      ...overrides,
    },
  };
}

/** Create a mock QuoteFn that returns a fixed response. */
function mockQuoteFn(response: QuoteResponse): QuoteFn {
  return async () => response;
}

/** Create a mock QuoteFn that captures the request and returns a fixed response. */
function capturingQuoteFn(response: QuoteResponse) {
  let captured: Parameters<QuoteFn>[0] | undefined;
  const fn: QuoteFn = async (req) => {
    captured = req;
    return response;
  };
  return { fn, getCaptured: () => captured };
}

/** Create a mock QuoteFn that throws a 1CS ApiError. */
function failingQuoteFn(status: number, body?: unknown): QuoteFn {
  return async () => {
    throw new OneClickApiError(
      { method: "POST", url: "/v0/quote" },
      { url: "/v0/quote", ok: false, status, statusText: `Error ${status}`, body: body ?? {} },
      `Request failed with status ${status}`,
    );
  };
}

/** Create a mock QuoteFn that throws a network error. */
function networkErrorQuoteFn(message: string): QuoteFn {
  return async () => {
    throw new Error(message);
  };
}

/** In-memory mock StateStore. */
function createMockStore(): StateStore & { states: Map<string, SwapState> } {
  const states = new Map<string, SwapState>();
  return {
    states,
    async create(depositAddress: string, state: SwapState) {
      states.set(depositAddress, state);
    },
    async get(depositAddress: string) {
      return states.get(depositAddress) ?? null;
    },
    async update(depositAddress: string, patch: Partial<SwapState>) {
      const existing = states.get(depositAddress);
      if (existing) {
        states.set(depositAddress, { ...existing, ...patch });
      }
    },
    async listExpired() {
      return [];
    },
    async delete(depositAddress: string) {
      states.delete(depositAddress);
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Integration tests — buildPaymentRequirements
// ═══════════════════════════════════════════════════════════════════════

describe("buildPaymentRequirements", () => {
  it("returns correct PaymentRequirements from a successful 1CS quote", async () => {
    const quoteResp = mockQuoteResponse();
    const cfg = testConfig();
    const store = createMockStore();

    const result = await buildPaymentRequirements(
      cfg, store, "/api/resource", mockQuoteFn(quoteResp),
    );

    const req = result.requirements;
    expect(req.scheme).toBe("exact");
    expect(req.network).toBe("eip155:8453");
    expect(req.asset).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(req.amount).toBe("1050000"); // amountIn from the quote
    expect(req.payTo).toBe("0xDEADBEEF1234567890abcdef1234567890abcdef");
    expect(req.maxTimeoutSeconds).toBeGreaterThan(0);
    // Scheme-signing fields (name/version/assetTransferMethod) stay intact.
    // The informational `crossChain` sibling is covered in its own test
    // block below, so we use `toMatchObject` here rather than `toEqual`
    // to allow the extra key without weakening the invariant.
    expect(req.extra).toMatchObject({
      name: "USDC",
      version: "2",
      assetTransferMethod: "eip3009",
    });
  });

  it("persists a SwapState with phase QUOTED in the store", async () => {
    const quoteResp = mockQuoteResponse();
    const cfg = testConfig();
    const store = createMockStore();

    const result = await buildPaymentRequirements(
      cfg, store, "/api/resource", mockQuoteFn(quoteResp),
    );

    const depositAddr = result.state.depositAddress;
    expect(store.states.has(depositAddr)).toBe(true);

    const persisted = store.states.get(depositAddr)!;
    expect(persisted.phase).toBe("QUOTED");
    expect(persisted.depositAddress).toBe("0xDEADBEEF1234567890abcdef1234567890abcdef");
    expect(persisted.quoteResponse.correlationId).toBe("corr-123");
    expect(persisted.paymentRequirements.scheme).toBe("exact");
    expect(persisted.createdAt).toBeGreaterThan(0);
    expect(persisted.updatedAt).toBe(persisted.createdAt);
  });

  it("uses permit2 when tokenSupportsEip3009 is false", async () => {
    const quoteResp = mockQuoteResponse();
    const cfg = testConfig({ tokenSupportsEip3009: false });
    const store = createMockStore();

    const result = await buildPaymentRequirements(
      cfg, store, "/api/resource", mockQuoteFn(quoteResp),
    );

    expect(result.requirements.extra).toEqual(
      expect.objectContaining({ assetTransferMethod: "permit2" }),
    );
  });

  it("sends correct fields in the 1CS quote request", async () => {
    const quoteResp = mockQuoteResponse();
    const { fn, getCaptured } = capturingQuoteFn(quoteResp);
    const cfg = testConfig();
    const store = createMockStore();

    await buildPaymentRequirements(cfg, store, "/api/resource", fn);

    const req = getCaptured()!;
    expect(req).toBeDefined();
    expect(req.dry).toBe(false);
    expect(req.swapType).toBe("EXACT_OUTPUT");
    expect(req.originAsset).toBe("nep141:base-0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(req.destinationAsset).toBe("near:nUSDC");
    expect(req.amount).toBe("1000000");
    expect(req.recipient).toBe("merchant.near");
    expect(req.refundTo).toBe("0x1234567890abcdef1234567890abcdef12345678");
    expect(req.depositType).toBe("ORIGIN_CHAIN");
    expect(req.refundType).toBe("ORIGIN_CHAIN");
    expect(req.recipientType).toBe("DESTINATION_CHAIN");
    expect(req.deadline).toBeDefined();
  });

  // ── Error handling ─────────────────────────────────────────────────

  it("throws QuoteUnavailableError on 1CS 400 response", async () => {
    const cfg = testConfig();
    const store = createMockStore();

    await expect(
      buildPaymentRequirements(
        cfg, store, "/api/resource",
        failingQuoteFn(400, { message: "unsupported asset pair" }),
      ),
    ).rejects.toThrow(QuoteUnavailableError);
  });

  it("throws AuthenticationError on 1CS 401 response", async () => {
    const cfg = testConfig();
    const store = createMockStore();

    await expect(
      buildPaymentRequirements(
        cfg, store, "/api/resource",
        failingQuoteFn(401, { message: "JWT expired" }),
      ),
    ).rejects.toThrow(AuthenticationError);
  });

  it("throws ServiceUnavailableError on 1CS 503 response", async () => {
    const cfg = testConfig();
    const store = createMockStore();

    await expect(
      buildPaymentRequirements(
        cfg, store, "/api/resource",
        failingQuoteFn(503, { message: "service down" }),
      ),
    ).rejects.toThrow(ServiceUnavailableError);
  });

  it("throws ServiceUnavailableError on network failure", async () => {
    const cfg = testConfig();
    const store = createMockStore();

    await expect(
      buildPaymentRequirements(
        cfg, store, "/api/resource",
        networkErrorQuoteFn("ECONNREFUSED"),
      ),
    ).rejects.toThrow(ServiceUnavailableError);
  });

  it("throws DeadlineTooShortError when quote deadline is too tight", async () => {
    const deadline = new Date(Date.now() + 10_000).toISOString(); // 10s
    const quoteResp = mockQuoteResponse({ deadline });
    const cfg = testConfig({ quoteExpiryBufferSec: 30 });
    const store = createMockStore();

    await expect(
      buildPaymentRequirements(cfg, store, "/api/resource", mockQuoteFn(quoteResp)),
    ).rejects.toThrow(DeadlineTooShortError);
  });

  it("throws QuoteUnavailableError when depositAddress is missing", async () => {
    const quoteResp = mockQuoteResponse({ depositAddress: undefined });
    const cfg = testConfig();
    const store = createMockStore();

    await expect(
      buildPaymentRequirements(cfg, store, "/api/resource", mockQuoteFn(quoteResp)),
    ).rejects.toThrow(QuoteUnavailableError);
  });

  it("does not persist state when quote fails", async () => {
    const cfg = testConfig();
    const store = createMockStore();

    await expect(
      buildPaymentRequirements(
        cfg, store, "/api/resource",
        failingQuoteFn(400, { message: "bad" }),
      ),
    ).rejects.toThrow();

    expect(store.states.size).toBe(0);
  });

  it("does not persist state when deadline validation fails", async () => {
    const deadline = new Date(Date.now() + 5_000).toISOString();
    const quoteResp = mockQuoteResponse({ deadline });
    const cfg = testConfig({ quoteExpiryBufferSec: 30 });
    const store = createMockStore();

    await expect(
      buildPaymentRequirements(cfg, store, "/api/resource", mockQuoteFn(quoteResp)),
    ).rejects.toThrow(DeadlineTooShortError);

    expect(store.states.size).toBe(0);
  });

  it("includes error message from 1CS body in thrown error", async () => {
    const cfg = testConfig();
    const store = createMockStore();

    await expect(
      buildPaymentRequirements(
        cfg, store, "/api/resource",
        failingQuoteFn(400, { message: "unsupported asset pair: FOO/BAR" }),
      ),
    ).rejects.toThrow(/unsupported asset pair/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Unit tests — individual helpers
// ═══════════════════════════════════════════════════════════════════════

describe("configureOneClickSdk", () => {
  it("sets OpenAPI.BASE and OpenAPI.TOKEN from config", () => {
    const cfg = testConfig({
      oneClickBaseUrl: "https://custom.api.example.com",
      oneClickJwt: "custom-jwt",
    });

    configureOneClickSdk(cfg);

    expect(OpenAPI.BASE).toBe("https://custom.api.example.com");
    expect(OpenAPI.TOKEN).toBe("custom-jwt");
  });
});

describe("buildQuoteRequest", () => {
  it("constructs a correct EXACT_OUTPUT request", () => {
    const cfg = testConfig();
    const deadline = "2026-04-01T00:00:00Z";
    const req = buildQuoteRequest(cfg, deadline);

    expect(req.dry).toBe(false);
    expect(req.swapType).toBe("EXACT_OUTPUT");
    expect(req.slippageTolerance).toBe(50);
    expect(req.originAsset).toBe(cfg.originAssetIn);
    expect(req.depositType).toBe("ORIGIN_CHAIN");
    expect(req.destinationAsset).toBe(cfg.merchantAssetOut);
    expect(req.amount).toBe(cfg.merchantAmountOut);
    expect(req.refundTo).toBe(cfg.gatewayRefundAddress);
    expect(req.refundType).toBe("ORIGIN_CHAIN");
    expect(req.recipient).toBe(cfg.merchantRecipient);
    expect(req.recipientType).toBe("DESTINATION_CHAIN");
    expect(req.deadline).toBe(deadline);
  });
});

describe("buildQuoteDeadline", () => {
  it("returns an ISO timestamp maxPollTimeMs + 120s in the future", () => {
    const cfg = testConfig({ maxPollTimeMs: 300_000 });
    const deadline = buildQuoteDeadline(cfg);
    const deadlineMs = new Date(deadline).getTime();
    const expectedMs = Date.now() + 300_000 + 120_000;

    // Allow 1 second tolerance for test execution time
    expect(deadlineMs).toBeGreaterThan(expectedMs - 1000);
    expect(deadlineMs).toBeLessThan(expectedMs + 1000);
  });
});

describe("computeMaxTimeoutSeconds", () => {
  it("returns seconds until deadline minus buffer", () => {
    const deadline = new Date(Date.now() + 600_000).toISOString(); // 10 min
    const result = computeMaxTimeoutSeconds(deadline, 30);

    expect(result).toBeGreaterThanOrEqual(560);
    expect(result).toBeLessThanOrEqual(575);
  });

  it("floors at 60s minimum", () => {
    const deadline = new Date(Date.now() + 80_000).toISOString(); // 80s
    const result = computeMaxTimeoutSeconds(deadline, 30);

    // raw = ~80 - 30 = ~50 → clamped to 60
    expect(result).toBe(60);
  });

  it("returns 600s fallback when no deadline", () => {
    expect(computeMaxTimeoutSeconds(undefined, 30)).toBe(600);
  });
});

describe("validateDeadline", () => {
  it("does not throw when deadline is far enough away", () => {
    const quoteResp = mockQuoteResponse();
    const cfg = testConfig({ quoteExpiryBufferSec: 30 });

    expect(() => validateDeadline(quoteResp, cfg)).not.toThrow();
  });

  it("throws DeadlineTooShortError when deadline is too close", () => {
    const deadline = new Date(Date.now() + 10_000).toISOString();
    const quoteResp = mockQuoteResponse({ deadline });
    const cfg = testConfig({ quoteExpiryBufferSec: 30 });

    expect(() => validateDeadline(quoteResp, cfg)).toThrow(DeadlineTooShortError);
  });

  it("does not throw when quote has no deadline", () => {
    const quoteResp = mockQuoteResponse({ deadline: undefined });
    const cfg = testConfig({ quoteExpiryBufferSec: 30 });

    expect(() => validateDeadline(quoteResp, cfg)).not.toThrow();
  });
});

describe("mapToPaymentRequirements", () => {
  it("maps all fields correctly", () => {
    const quoteResp = mockQuoteResponse();
    const cfg = testConfig();
    const req = mapToPaymentRequirements(quoteResp, cfg);

    expect(req.scheme).toBe("exact");
    expect(req.network).toBe("eip155:8453");
    expect(req.asset).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(req.amount).toBe("1050000");
    expect(req.payTo).toBe("0xDEADBEEF1234567890abcdef1234567890abcdef");
    expect(req.maxTimeoutSeconds).toBeGreaterThan(0);
    // Scheme-signing fields stay intact; see the dedicated
    // `extra.crossChain` block below for the informational sibling.
    expect(req.extra).toMatchObject({
      name: "USDC",
      version: "2",
      assetTransferMethod: "eip3009",
    });
  });

  it("uses permit2 when tokenSupportsEip3009 is false", () => {
    const quoteResp = mockQuoteResponse();
    const cfg = testConfig({ tokenSupportsEip3009: false });
    const req = mapToPaymentRequirements(quoteResp, cfg);

    expect(req.extra).toEqual(
      expect.objectContaining({ assetTransferMethod: "permit2" }),
    );
  });

  it("uses custom token name and version from config", () => {
    const quoteResp = mockQuoteResponse();
    const cfg = testConfig({ tokenName: "DAI", tokenVersion: "1" });
    const req = mapToPaymentRequirements(quoteResp, cfg);

    expect(req.extra).toEqual(
      expect.objectContaining({ name: "DAI", version: "1" }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// extra.crossChain — informational 1CS quote metadata
// ═══════════════════════════════════════════════════════════════════════

describe("mapToPaymentRequirements — extra.crossChain block", () => {
  it("sets protocol discriminator to \"1cs\"", () => {
    const req = mapToPaymentRequirements(mockQuoteResponse(), testConfig());
    const cross = (req.extra.crossChain as Record<string, unknown>);
    expect(cross).toBeDefined();
    expect(cross.protocol).toBe("1cs");
  });

  it("copies quoteId from QuoteResponse.correlationId (not quote.*)", () => {
    const quoteResp = mockQuoteResponse();
    // sanity: the mock fixture uses a known correlationId
    expect(quoteResp.correlationId).toBe("corr-123");

    const req = mapToPaymentRequirements(quoteResp, testConfig());
    const cross = req.extra.crossChain as Record<string, unknown>;
    expect(cross.quoteId).toBe("corr-123");
  });

  it("populates destination + refund fields from cfg and quote", () => {
    const cfg = testConfig({
      merchantRecipient: "merchant.near",
      merchantAssetOut: "nep141:usdc.near",
      gatewayRefundAddress: "0x1234567890abcdef1234567890abcdef12345678",
    });
    const req = mapToPaymentRequirements(mockQuoteResponse(), cfg);
    const cross = req.extra.crossChain as Record<string, unknown>;

    // Straight from cfg
    expect(cross.destinationRecipient).toBe("merchant.near");
    expect(cross.destinationAsset).toBe("nep141:usdc.near");
    expect(cross.refundTo).toBe("0x1234567890abcdef1234567890abcdef12345678");

    // Straight from quote (same values as the mock fixture)
    expect(cross.amountOut).toBe("1000000");
    expect(cross.amountOutFormatted).toBe("1.00");
    expect(cross.amountOutUsd).toBe("1.00");
    expect(cross.amountInUsd).toBe("1.05");
  });

  it("includes optional refundFee / depositMemo only when the quote provides them", () => {
    // Quote with neither set
    const clean = mapToPaymentRequirements(mockQuoteResponse(), testConfig());
    const cleanCross = clean.extra.crossChain as Record<string, unknown>;
    expect(cleanCross).not.toHaveProperty("refundFee");
    expect(cleanCross).not.toHaveProperty("depositMemo");

    // Quote with both set — ensure they round-trip into the block
    const richQuote = mockQuoteResponse({
      refundFee: "250",
      depositMemo: "stellar-memo-abc",
    });
    const rich = mapToPaymentRequirements(richQuote, testConfig());
    const richCross = rich.extra.crossChain as Record<string, unknown>;
    expect(richCross.refundFee).toBe("250");
    expect(richCross.depositMemo).toBe("stellar-memo-abc");
  });

  it("does not mutate or replace the EVM scheme-signing keys (name / version / assetTransferMethod)", () => {
    // Introducing `crossChain` must NOT affect the sibling signing keys.
    // This is the EVM-exact-scheme compatibility invariant.
    const cfg = testConfig({ tokenName: "USD Coin", tokenVersion: "2" });
    const req = mapToPaymentRequirements(mockQuoteResponse(), cfg);

    expect(req.extra.name).toBe("USD Coin");
    expect(req.extra.version).toBe("2");
    expect(req.extra.assetTransferMethod).toBe("eip3009");
    // And crossChain lives alongside, not in place of, the above.
    expect(req.extra.crossChain).toBeDefined();
  });
});

describe("toQuoteResponseRecord", () => {
  it("produces a serialization-safe record", () => {
    const quoteResp = mockQuoteResponse();
    const record = toQuoteResponseRecord(quoteResp);

    expect(record.correlationId).toBe("corr-123");
    expect(record.signature).toBe("mock-signature");
    expect(record.quote.depositAddress).toBe("0xDEADBEEF1234567890abcdef1234567890abcdef");
    expect(record.quote.amountIn).toBe("1050000");
    expect(record.quote.amountOut).toBe("1000000");
    expect(record.quote.timeEstimate).toBe(30);
    expect(record.quoteRequest).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// diagnoseQuoteRequest — recipient / asset format hints
// ═══════════════════════════════════════════════════════════════════════

describe("diagnoseQuoteRequest", () => {
  it("returns empty for a clean NEAR→NEAR config", () => {
    expect(
      diagnoseQuoteRequest({
        originAsset: "nep141:base-0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913.omft.near",
        destinationAsset: "nep141:usdt.tether-token.near",
        recipient: "merchantx402.near",
        amount: "10000",
        refundTo: "0x1234567890abcdef1234567890abcdef12345678",
      }),
    ).toEqual([]);
  });

  it("returns empty for a clean EVM-bridge destination", () => {
    expect(
      diagnoseQuoteRequest({
        originAsset: "nep141:base-0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913.omft.near",
        destinationAsset: "nep141:arb-0xaf88d065e77c8cC2239327C5EDb3A432268e5831.omft.near",
        recipient: "0x1234567890abcdef1234567890abcdef12345678",
        amount: "10000",
        refundTo: "0x1234567890abcdef1234567890abcdef12345678",
      }),
    ).toEqual([]);
  });

  it("flags a .nea typo as invalid NEAR account", () => {
    const hints = diagnoseQuoteRequest({
      destinationAsset: "nep141:usdt.tether-token.near",
      recipient: "merchantx402.nea",
    });
    expect(hints.length).toBeGreaterThanOrEqual(1);
    expect(hints.join("\n").toLowerCase()).toContain("valid near account");
    expect(hints.join("\n")).toContain("merchantx402.nea");
  });

  it("flags an EVM address as recipient for a NEAR-native destination", () => {
    const hints = diagnoseQuoteRequest({
      destinationAsset: "nep141:usdt.tether-token.near",
      recipient: "0x1234567890abcdef1234567890abcdef12345678",
    });
    expect(hints.join("\n").toLowerCase()).toContain("evm address");
    expect(hints.join("\n").toLowerCase()).toContain("near");
  });

  it("flags whitespace in any field (leading space, inline #)", () => {
    const hints = diagnoseQuoteRequest({
      recipient: " merchantx402.near",
      destinationAsset: "nep141:usdt.tether-token.near #nep141:gnosis-0xabc.omft.near",
    });
    const joined = hints.join("\n");
    expect(joined).toContain("whitespace");
    // Both fields flagged
    expect(joined).toContain("recipient");
    expect(joined).toContain("destinationAsset");
  });

  it("flags a NEAR account for an EVM-bridged destination", () => {
    const hints = diagnoseQuoteRequest({
      destinationAsset: "nep141:arb-0xaf88d065e77c8cC2239327C5EDb3A432268e5831.omft.near",
      recipient: "some.near",
    });
    expect(hints.join("\n").toLowerCase()).toContain("evm address");
    expect(hints.join("\n")).toContain("arb");
  });

  it("flags an unknown chain prefix", () => {
    const hints = diagnoseQuoteRequest({
      destinationAsset: "nep141:foobar-0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef.omft.near",
      recipient: "whatever",
    });
    expect(hints.join("\n").toLowerCase()).toContain("not in the known chain list");
    expect(hints.join("\n")).toContain("foobar");
  });

  it("flags EVM address for Stellar destination", () => {
    const hints = diagnoseQuoteRequest({
      destinationAsset: "nep141:stellar-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN.omft.near",
      recipient: "0x1234567890abcdef1234567890abcdef12345678",
    });
    expect(hints.join("\n").toLowerCase()).toContain("evm address");
    expect(hints.join("\n")).toContain("stellar");
  });

  it("accepts a 64-char hex NEAR implicit account", () => {
    const hints = diagnoseQuoteRequest({
      destinationAsset: "nep141:usdt.tether-token.near",
      recipient: "a".repeat(64), // 64 hex chars
    });
    expect(hints).toEqual([]);
  });

  it("ignores fields left undefined", () => {
    // All undefined except destinationAsset — no hints about missing recipient.
    const hints = diagnoseQuoteRequest({
      destinationAsset: "nep141:usdt.tether-token.near",
    });
    expect(hints).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Error context threading — 1CS rejection surfaces in err.context
// ═══════════════════════════════════════════════════════════════════════

describe("requestQuote — error context threading", () => {
  it("attaches request fields + hints to QuoteUnavailableError from 400", async () => {
    const cfg = testConfig({
      merchantRecipient: "merchantx402.nea", // typo
      merchantAssetOut: "nep141:usdt.tether-token.near",
    });
    const store = createMockStore();

    try {
      await buildPaymentRequirements(
        cfg, store, "/api/resource",
        failingQuoteFn(400, { message: "Internal server error" }),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QuoteUnavailableError);
      const ctx = (err as QuoteUnavailableError).context;
      expect(ctx).toBeDefined();
      expect(ctx?.recipient).toBe("merchantx402.nea");
      expect(ctx?.destinationAsset).toBe("nep141:usdt.tether-token.near");
      expect(ctx?.upstreamStatus).toBe(400);
      expect(Array.isArray(ctx?.hints)).toBe(true);
      const hints = ctx?.hints as string[];
      expect(hints.some((h) => h.toLowerCase().includes("valid near account"))).toBe(true);
    }
  });

  it("attaches context to AuthenticationError from 401", async () => {
    const cfg = testConfig();
    const store = createMockStore();

    try {
      await buildPaymentRequirements(
        cfg, store, "/api/resource",
        failingQuoteFn(401, { message: "bad jwt" }),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthenticationError);
      const ctx = (err as AuthenticationError).context;
      expect(ctx?.upstreamStatus).toBe(401);
      expect(ctx?.recipient).toBe(cfg.merchantRecipient);
    }
  });

  it("attaches context to ServiceUnavailableError from 5xx", async () => {
    const cfg = testConfig();
    const store = createMockStore();

    try {
      await buildPaymentRequirements(
        cfg, store, "/api/resource",
        failingQuoteFn(503, { message: "upstream down" }),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceUnavailableError);
      const ctx = (err as ServiceUnavailableError).context;
      expect(ctx?.upstreamStatus).toBe(503);
      expect(ctx?.originAsset).toBe(cfg.originAssetIn);
    }
  });

  it("attaches context to ServiceUnavailableError from a network error", async () => {
    const cfg = testConfig();
    const store = createMockStore();

    try {
      await buildPaymentRequirements(
        cfg, store, "/api/resource",
        networkErrorQuoteFn("ECONNREFUSED"),
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceUnavailableError);
      const ctx = (err as ServiceUnavailableError).context;
      expect(ctx?.upstreamStatus).toBe("network");
      expect(ctx?.recipient).toBe(cfg.merchantRecipient);
    }
  });
});
