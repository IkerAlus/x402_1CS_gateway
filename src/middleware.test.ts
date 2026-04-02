/**
 * Tests for the x402 Middleware (Step 2.1).
 *
 * Uses supertest to drive an Express app with the x402 middleware,
 * and injectable dependency stubs to avoid real RPC/1CS calls.
 */

import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { createX402Middleware } from "./middleware.js";
import type { MiddlewareDeps } from "./middleware.js";
import { InMemoryStateStore } from "./store.js";
import type { StateStore, PaymentPayloadRecord, SwapState } from "./types.js";
import {
  mockGatewayConfig,
  mockFastPollConfig,
  mockChainReader,
  mockBroadcastFn,
  mockDepositNotifyFn,
  mockStatusPollFn,
  MOCK_DEPOSIT_ADDRESS,
  mockQuoteResponse,
  MOCK_TX_HASH,
  buyerWallet,
  BUYER_ADDRESS,
  signEIP3009Payload,
  mockPaymentRequirements,
} from "./mocks/index.js";
import type { QuoteFn } from "./quote-engine.js";
import type { QuoteResponse } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════════════

/** Create a mock QuoteFn that returns a predictable quote. */
function createMockQuoteFn(): QuoteFn {
  return async (_req) => mockQuoteResponse() as unknown as QuoteResponse;
}

/** Build standard test deps. */
function buildDeps(overrides: Partial<MiddlewareDeps> = {}): MiddlewareDeps {
  const store = new InMemoryStateStore();
  return {
    cfg: mockFastPollConfig(),
    store,
    chainReader: mockChainReader(),
    broadcastFn: mockBroadcastFn(),
    depositNotifyFn: mockDepositNotifyFn(),
    statusPollFn: mockStatusPollFn(),
    quoteFn: createMockQuoteFn(),
    ...overrides,
  };
}

/** Create a test Express app with the x402 middleware. */
function createTestApp(deps: MiddlewareDeps): express.Express {
  const app = express();
  app.use(express.json());
  app.get("/api/premium", createX402Middleware(deps), (_req, res) => {
    res.json({ content: "premium data" });
  });
  return app;
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe("x402 Middleware", () => {
  let deps: MiddlewareDeps;
  let app: express.Express;

  beforeEach(() => {
    deps = buildDeps();
    app = createTestApp(deps);
  });

  // ── 402 flow (no payment header) ───────────────────────────────────

  describe("No PAYMENT-SIGNATURE header", () => {
    it("returns 402 with PAYMENT-REQUIRED header", async () => {
      const res = await request(app).get("/api/premium");

      expect(res.status).toBe(402);
      expect(res.headers["payment-required"]).toBeDefined();

      // Decode and verify the PaymentRequired envelope
      const paymentRequired = decodePaymentRequiredHeader(
        res.headers["payment-required"],
      );
      expect(paymentRequired.x402Version).toBe(2);
      expect(paymentRequired.accepts).toHaveLength(1);
      expect(paymentRequired.accepts[0].scheme).toBe("exact");
      expect(paymentRequired.accepts[0].payTo).toBe(MOCK_DEPOSIT_ADDRESS);
    });

    it("returns empty JSON body", async () => {
      const res = await request(app).get("/api/premium");
      expect(res.body).toEqual({});
    });

    it("includes resource info in PaymentRequired", async () => {
      const depsWithDesc = buildDeps({ resourceDescription: "Premium API access" });
      const appWithDesc = createTestApp(depsWithDesc);

      const res = await request(appWithDesc).get("/api/premium");
      const paymentRequired = decodePaymentRequiredHeader(
        res.headers["payment-required"],
      );
      expect(paymentRequired.resource.url).toBe("/api/premium");
      expect(paymentRequired.resource.description).toBe("Premium API access");
    });
  });

  // ── Invalid payment header ─────────────────────────────────────────

  describe("Invalid PAYMENT-SIGNATURE header", () => {
    it("returns 400 for malformed base64", async () => {
      const res = await request(app)
        .get("/api/premium")
        .set("PAYMENT-SIGNATURE", "not-valid-base64!!!");

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid PAYMENT-SIGNATURE");
    });

    it("returns 400 for missing accepted.payTo", async () => {
      // Encode a payload without accepted.payTo
      const badPayload = { x402Version: 2, accepted: {}, payload: {} };
      const encoded = encodePaymentSignatureHeader(badPayload as any);

      const res = await request(app)
        .get("/api/premium")
        .set("PAYMENT-SIGNATURE", encoded);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("missing accepted.payTo");
    });
  });

  // ── State not found (stale deposit address) ────────────────────────

  describe("Payment with unknown deposit address", () => {
    it("returns fresh 402 when state not found", async () => {
      // Encode a payload referencing a deposit address not in the store
      const payload: PaymentPayloadRecord = {
        x402Version: 2,
        accepted: {
          ...mockPaymentRequirements(),
          payTo: "0xunknown0000000000000000000000000000dead",
        },
        payload: {},
      };
      const encoded = encodePaymentSignatureHeader(payload as any);

      const res = await request(app)
        .get("/api/premium")
        .set("PAYMENT-SIGNATURE", encoded);

      expect(res.status).toBe(402);
      expect(res.headers["payment-required"]).toBeDefined();
    });
  });

  // ── Expired quote ──────────────────────────────────────────────────

  describe("Payment with expired quote", () => {
    it("deletes stale state and returns fresh 402", async () => {
      // Seed the store with an expired state
      const now = Date.now();
      const expiredState: SwapState = {
        depositAddress: MOCK_DEPOSIT_ADDRESS,
        quoteResponse: {
          ...mockQuoteResponse(),
          quote: {
            ...mockQuoteResponse().quote,
            deadline: new Date(now - 60_000).toISOString(), // expired 1 min ago
          },
        },
        paymentRequirements: mockPaymentRequirements(),
        phase: "QUOTED",
        createdAt: now - 120_000,
        updatedAt: now - 120_000,
      };
      await deps.store.create(MOCK_DEPOSIT_ADDRESS, expiredState);

      const payload: PaymentPayloadRecord = {
        x402Version: 2,
        accepted: mockPaymentRequirements(),
        payload: {},
      };
      const encoded = encodePaymentSignatureHeader(payload as any);

      const res = await request(app)
        .get("/api/premium")
        .set("PAYMENT-SIGNATURE", encoded);

      expect(res.status).toBe(402);

      // State should be deleted
      const stateAfter = await deps.store.get(MOCK_DEPOSIT_ADDRESS);
      // The old state is deleted, but a new one is created by the fresh quote
      expect(stateAfter?.phase).toBe("QUOTED");
    });
  });

  // ── Already settled (idempotent retry) ─────────────────────────────

  describe("Payment for already-settled swap", () => {
    it("returns 200 with cached PAYMENT-RESPONSE", async () => {
      // Seed a SETTLED state
      const now = Date.now();
      const settledState: SwapState = {
        depositAddress: MOCK_DEPOSIT_ADDRESS,
        quoteResponse: {
          ...mockQuoteResponse(),
          quote: {
            ...mockQuoteResponse().quote,
            deadline: new Date(now + 300_000).toISOString(),
          },
        },
        paymentRequirements: mockPaymentRequirements(),
        paymentPayload: {
          x402Version: 2,
          accepted: mockPaymentRequirements(),
          payload: {},
        },
        signerAddress: BUYER_ADDRESS,
        originTxHash: MOCK_TX_HASH,
        phase: "SETTLED",
        createdAt: now - 10_000,
        updatedAt: now,
        settledAt: now,
        settlementResponse: {
          success: true,
          payer: BUYER_ADDRESS,
          transaction: MOCK_TX_HASH,
          network: "eip155:8453",
          extra: {
            settlementType: "crosschain-1cs",
            swapStatus: "SUCCESS",
            correlationId: "test-correlation-id",
          },
        },
      };
      await deps.store.create(MOCK_DEPOSIT_ADDRESS, settledState);

      const payload: PaymentPayloadRecord = {
        x402Version: 2,
        accepted: mockPaymentRequirements(),
        payload: {},
      };
      const encoded = encodePaymentSignatureHeader(payload as any);

      const res = await request(app)
        .get("/api/premium")
        .set("PAYMENT-SIGNATURE", encoded);

      expect(res.status).toBe(200);
      expect(res.headers["payment-response"]).toBeDefined();
      expect(res.body.content).toBe("premium data");

      const paymentResponse = decodePaymentResponseHeader(
        res.headers["payment-response"],
      );
      expect(paymentResponse.success).toBe(true);
      expect(paymentResponse.transaction).toBe(MOCK_TX_HASH);
    });
  });

  // ── Swap in progress (duplicate request) ───────────────────────────

  describe("Payment for in-progress swap", () => {
    it("returns 409 when swap is already being settled", async () => {
      const now = Date.now();
      const inProgressState: SwapState = {
        depositAddress: MOCK_DEPOSIT_ADDRESS,
        quoteResponse: {
          ...mockQuoteResponse(),
          quote: {
            ...mockQuoteResponse().quote,
            deadline: new Date(now + 300_000).toISOString(),
          },
        },
        paymentRequirements: mockPaymentRequirements(),
        phase: "BROADCASTING",
        createdAt: now - 5_000,
        updatedAt: now,
      };
      await deps.store.create(MOCK_DEPOSIT_ADDRESS, inProgressState);

      const payload: PaymentPayloadRecord = {
        x402Version: 2,
        accepted: mockPaymentRequirements(),
        payload: {},
      };
      const encoded = encodePaymentSignatureHeader(payload as any);

      const res = await request(app)
        .get("/api/premium")
        .set("PAYMENT-SIGNATURE", encoded);

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("already in progress");
    });
  });

  // ── Full happy path: quote → verify → settle → 200 ────────────────

  describe("Full settlement flow", () => {
    it("completes EIP-3009 payment and returns 200 with PAYMENT-RESPONSE", async () => {
      // Step 1: First request → 402 (creates QUOTED state)
      const initialRes = await request(app).get("/api/premium");
      expect(initialRes.status).toBe(402);

      // Step 2: Decode the payment requirements from the 402
      const paymentRequired = decodePaymentRequiredHeader(
        initialRes.headers["payment-required"],
      );
      const requirements = paymentRequired.accepts[0];
      expect(requirements).toBeDefined();

      // Step 3: Sign an EIP-3009 payload (real EIP-712 signature)
      const { payload: signedPayload } = await signEIP3009Payload(buyerWallet, {
        to: requirements.payTo,
        value: requirements.amount,
      });

      // Step 4: Send the signed payment
      const encoded = encodePaymentSignatureHeader(signedPayload as any);

      const paymentRes = await request(app)
        .get("/api/premium")
        .set("PAYMENT-SIGNATURE", encoded);

      expect(paymentRes.status).toBe(200);
      expect(paymentRes.body.content).toBe("premium data");
      expect(paymentRes.headers["payment-response"]).toBeDefined();

      const paymentResponse = decodePaymentResponseHeader(
        paymentRes.headers["payment-response"],
      );
      expect(paymentResponse.success).toBe(true);
      expect(paymentResponse.transaction).toBeTruthy();
    });
  });

  // ── Settlement failure ─────────────────────────────────────────────

  describe("Settlement failure handling", () => {
    it("returns 502 with PAYMENT-RESPONSE on broadcast failure", async () => {
      // Create deps with a failing broadcaster
      const failDeps = buildDeps({
        broadcastFn: mockBroadcastFn({
          eip3009Error: new Error("RPC timeout"),
        }),
      });
      const failApp = createTestApp(failDeps);

      // Step 1: Get 402
      const initialRes = await request(failApp).get("/api/premium");
      expect(initialRes.status).toBe(402);

      // Step 2: Decode requirements and sign
      const paymentRequired = decodePaymentRequiredHeader(
        initialRes.headers["payment-required"],
      );
      const requirements = paymentRequired.accepts[0];
      const { payload: signedPayload } = await signEIP3009Payload(buyerWallet, {
        to: requirements.payTo,
        value: requirements.amount,
      });

      // Step 3: Send the signed payment (should fail during broadcast)
      const encoded = encodePaymentSignatureHeader(signedPayload as any);
      const paymentRes = await request(failApp)
        .get("/api/premium")
        .set("PAYMENT-SIGNATURE", encoded);

      expect(paymentRes.status).toBe(502);
      expect(paymentRes.headers["payment-response"]).toBeDefined();

      const paymentResponse = decodePaymentResponseHeader(
        paymentRes.headers["payment-response"],
      );
      expect(paymentResponse.success).toBe(false);
    });
  });

  // ── Quote engine failure ───────────────────────────────────────────

  describe("Quote engine failure", () => {
    it("returns 503 when 1CS is unavailable", async () => {
      const failQuoteFn: QuoteFn = async () => {
        throw new Error("1CS unreachable");
      };
      const failDeps = buildDeps({ quoteFn: failQuoteFn });
      const failApp = createTestApp(failDeps);

      const res = await request(failApp).get("/api/premium");
      expect(res.status).toBe(503);
    });
  });
});
