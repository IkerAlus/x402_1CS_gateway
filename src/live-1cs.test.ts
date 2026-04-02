/**
 * Live 1CS API integration tests.
 *
 * These tests call the REAL 1Click Swap API — they are **skipped by default**
 * and only run when the `ONE_CLICK_JWT` environment variable is set.
 *
 * Usage:
 *   ONE_CLICK_JWT="<jwt>" npx vitest run src/live-1cs.test.ts
 *   ONE_CLICK_JWT="<jwt>" npm run test:live
 *
 * No funds are spent: quote requests use either `dry: true` or non-dry mode
 * that generates a deposit address but never receives a deposit. The gateway
 * middleware tests use real 1CS quotes but mock the on-chain broadcast layer.
 *
 * @module live-1cs
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import {
  OneClickService,
  OpenAPI,
  QuoteRequest,
} from "@defuse-protocol/one-click-sdk-typescript";
import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { ethers } from "ethers";

import { createX402Middleware } from "./middleware.js";
import type { MiddlewareDeps } from "./middleware.js";
import { InMemoryStateStore } from "./store.js";
import type { GatewayConfig } from "./config.js";
import type { QuoteResponse } from "./types.js";
import type { QuoteFn } from "./quote-engine.js";
import { configureOneClickSdk, defaultQuoteFn } from "./quote-engine.js";
import {
  mockBroadcastFn,
  mockDepositNotifyFn,
  mockStatusPollFn,
  signEIP3009Payload,
  buyerWallet,
  BUYER_ADDRESS,
  MOCK_TX_HASH,
} from "./mocks/index.js";
import { mockChainReader } from "./mocks/index.js";

// ═══════════════════════════════════════════════════════════════════════
// Skip guard — only run when JWT is available
// ═══════════════════════════════════════════════════════════════════════

const JWT = process.env.ONE_CLICK_JWT;
const BASE_URL = process.env.ONE_CLICK_BASE_URL ?? "https://1click.chaindefuser.com";

const describeIfLive = JWT ? describe : describe.skip;

// ═══════════════════════════════════════════════════════════════════════
// Constants — correct asset IDs for the live 1CS API
// ═══════════════════════════════════════════════════════════════════════

/**
 * IMPORTANT: The live 1CS API expects `nep141:` prefixed asset IDs,
 * NOT the short `base:0x...` format used in some earlier mock data.
 *
 * @see https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote
 */
const LIVE_ORIGIN_ASSET = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const LIVE_DESTINATION_ASSET = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const LIVE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const LIVE_NETWORK = "eip155:8453";

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

/** Build a GatewayConfig wired to the real 1CS API. */
function liveConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const facilitatorWallet = ethers.Wallet.createRandom();

  return {
    oneClickJwt: JWT!,
    oneClickBaseUrl: BASE_URL,
    merchantRecipient: "test.near",
    merchantAssetOut: LIVE_DESTINATION_ASSET,
    merchantAmountOut: "1000000", // 1 USDC
    originNetwork: LIVE_NETWORK,
    originAssetIn: LIVE_ORIGIN_ASSET,
    originTokenAddress: LIVE_USDC_ADDRESS,
    originRpcUrls: ["https://mainnet.base.org"],
    facilitatorPrivateKey: facilitatorWallet.privateKey,
    gatewayRefundAddress: facilitatorWallet.address,
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

/** Build MiddlewareDeps using the real 1CS quoteFn but mocked settlement. */
function liveDeps(overrides: Partial<MiddlewareDeps> = {}): MiddlewareDeps {
  const cfg = liveConfig();
  return {
    cfg,
    store: new InMemoryStateStore(),
    chainReader: mockChainReader(),
    broadcastFn: mockBroadcastFn(),
    depositNotifyFn: mockDepositNotifyFn(),
    statusPollFn: mockStatusPollFn(),
    // NO quoteFn override — uses the real defaultQuoteFn (hits live 1CS API)
    ...overrides,
  };
}

function createLiveTestApp(deps: MiddlewareDeps): express.Express {
  const app = express();
  app.use(express.json());
  app.get(
    "/api/premium",
    createX402Middleware(deps),
    (_req, res) => {
      res.json({ content: "premium data", timestamp: Date.now() });
    },
  );
  return app;
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describeIfLive("Live 1CS API Integration", () => {
  // Increase timeout for live API calls
  const LIVE_TIMEOUT = 30_000;

  beforeAll(() => {
    OpenAPI.BASE = BASE_URL;
    OpenAPI.TOKEN = JWT;
  });

  // ── 1. Authentication ────────────────────────────────────────────

  describe("Authentication", () => {
    it("accepts the JWT and returns a dry quote", async () => {
      const deadline = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      const resp = await OneClickService.getQuote({
        dry: true,
        swapType: QuoteRequest.swapType.EXACT_OUTPUT,
        slippageTolerance: 50,
        originAsset: LIVE_ORIGIN_ASSET,
        depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
        destinationAsset: LIVE_DESTINATION_ASSET,
        amount: "1000000",
        refundTo: "0x0000000000000000000000000000000000000001",
        refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
        recipient: "test.near",
        recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
        deadline,
      });

      expect(resp).toBeDefined();
      expect(resp.correlationId).toBeTruthy();
      expect(resp.quote).toBeDefined();
      expect(resp.quote.amountIn).toBeTruthy();
      expect(resp.quote.amountOut).toBeTruthy();
    }, LIVE_TIMEOUT);
  });

  // ── 2. Dry quote structure validation ────────────────────────────

  describe("Dry quote response structure", () => {
    it("returns all expected fields for an EXACT_OUTPUT dry quote", async () => {
      const deadline = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      const resp = await OneClickService.getQuote({
        dry: true,
        swapType: QuoteRequest.swapType.EXACT_OUTPUT,
        slippageTolerance: 50,
        originAsset: LIVE_ORIGIN_ASSET,
        depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
        destinationAsset: LIVE_DESTINATION_ASSET,
        amount: "1000000",
        refundTo: "0x0000000000000000000000000000000000000001",
        refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
        recipient: "test.near",
        recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
        deadline,
      });

      // Top-level fields
      expect(typeof resp.correlationId).toBe("string");
      expect(typeof resp.timestamp).toBe("string");

      // Quote pricing — amountIn should be >= amountOut for same-stablecoin swaps
      const amountIn = BigInt(resp.quote.amountIn);
      const amountOut = BigInt(resp.quote.amountOut);
      expect(amountIn).toBeGreaterThan(0n);
      expect(amountOut).toBe(1000000n); // We requested exactly 1 USDC out
      // For USDC→USDC cross-chain, amountIn ≥ amountOut (includes fees)
      expect(amountIn).toBeGreaterThanOrEqual(amountOut);

      // minAmountIn should exist and be ≤ amountIn
      const minAmountIn = BigInt(resp.quote.minAmountIn);
      expect(minAmountIn).toBeGreaterThan(0n);
      expect(minAmountIn).toBeLessThanOrEqual(amountIn);

      // Formatted strings should be present
      expect(resp.quote.amountInFormatted).toBeTruthy();
      expect(resp.quote.amountOutFormatted).toBeTruthy();

      // Time estimate should be a positive number
      expect(resp.quote.timeEstimate).toBeGreaterThan(0);

      // Dry quote may or may not have a deposit address (implementation-dependent)
      // Don't assert depositAddress here — that's tested in the non-dry test
    }, LIVE_TIMEOUT);
  });

  // ── 3. Real (non-dry) quote ──────────────────────────────────────

  describe("Real quote (non-dry)", () => {
    it("returns a deposit address for a non-dry EXACT_OUTPUT quote", async () => {
      const deadline = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      const resp = await OneClickService.getQuote({
        dry: false,
        swapType: QuoteRequest.swapType.EXACT_OUTPUT,
        slippageTolerance: 50,
        originAsset: LIVE_ORIGIN_ASSET,
        depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
        destinationAsset: LIVE_DESTINATION_ASSET,
        amount: "1000000",
        refundTo: "0x0000000000000000000000000000000000000001",
        refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
        recipient: "test.near",
        recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
        deadline,
      });

      // Must have a deposit address (this is the critical field for the gateway)
      expect(resp.quote.depositAddress).toBeTruthy();
      expect(resp.quote.depositAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);

      // Must have a deadline
      expect(resp.quote.deadline).toBeTruthy();
      const quoteDeadline = new Date(resp.quote.deadline!).getTime();
      expect(quoteDeadline).toBeGreaterThan(Date.now());

      // Signature should be present for non-dry quotes
      expect(resp.signature).toBeTruthy();
    }, LIVE_TIMEOUT);
  });

  // ── 4. Quote pricing sanity ──────────────────────────────────────

  describe("Quote pricing sanity", () => {
    it("USDC-to-USDC swap has reasonable fees (< 5%)", async () => {
      const deadline = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      const resp = await OneClickService.getQuote({
        dry: true,
        swapType: QuoteRequest.swapType.EXACT_OUTPUT,
        slippageTolerance: 50,
        originAsset: LIVE_ORIGIN_ASSET,
        depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
        destinationAsset: LIVE_DESTINATION_ASSET,
        amount: "10000000", // 10 USDC
        refundTo: "0x0000000000000000000000000000000000000001",
        refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
        recipient: "test.near",
        recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
        deadline,
      });

      const amountIn = Number(resp.quote.amountIn);
      const amountOut = Number(resp.quote.amountOut);
      const feePercent = ((amountIn - amountOut) / amountOut) * 100;

      // For stablecoin-to-stablecoin, fees should be well under 5%
      expect(feePercent).toBeLessThan(5);
      expect(feePercent).toBeGreaterThanOrEqual(0);
    }, LIVE_TIMEOUT);
  });

  // ── 5. Error handling: invalid asset pair ─────────────────────────

  describe("Error handling", () => {
    it("rejects an invalid origin asset with 400", async () => {
      const deadline = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      try {
        await OneClickService.getQuote({
          dry: true,
          swapType: QuoteRequest.swapType.EXACT_OUTPUT,
          slippageTolerance: 50,
          originAsset: "nep141:nonexistent-token.near",
          depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
          destinationAsset: LIVE_DESTINATION_ASSET,
          amount: "1000000",
          refundTo: "0x0000000000000000000000000000000000000001",
          refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
          recipient: "test.near",
          recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
          deadline,
        });
        // Should not reach here
        expect.unreachable("Expected 1CS to reject invalid asset");
      } catch (err: any) {
        // 1CS should return 400 for bad asset pairs
        expect(err.status).toBe(400);
      }
    }, LIVE_TIMEOUT);

    it("rejects an expired deadline", async () => {
      // Deadline in the past
      const deadline = new Date(Date.now() - 60_000).toISOString();

      try {
        await OneClickService.getQuote({
          dry: true,
          swapType: QuoteRequest.swapType.EXACT_OUTPUT,
          slippageTolerance: 50,
          originAsset: LIVE_ORIGIN_ASSET,
          depositType: QuoteRequest.depositType.ORIGIN_CHAIN,
          destinationAsset: LIVE_DESTINATION_ASSET,
          amount: "1000000",
          refundTo: "0x0000000000000000000000000000000000000001",
          refundType: QuoteRequest.refundType.ORIGIN_CHAIN,
          recipient: "test.near",
          recipientType: QuoteRequest.recipientType.DESTINATION_CHAIN,
          deadline,
        });
        expect.unreachable("Expected 1CS to reject expired deadline");
      } catch (err: any) {
        // 1CS should return 400 for expired deadlines
        expect(err.status).toBe(400);
      }
    }, LIVE_TIMEOUT);
  });

  // ── 6. Full gateway 402 flow with real 1CS quote ──────────────────

  describe("Gateway 402 flow with real 1CS quote", () => {
    it("returns a valid 402 response using a real 1CS quote", async () => {
      const deps = liveDeps();
      const app = createLiveTestApp(deps);

      const res = await request(app).get("/api/premium");

      expect(res.status).toBe(402);
      expect(res.headers["payment-required"]).toBeDefined();

      // Decode the 402 envelope
      const pr = decodePaymentRequiredHeader(res.headers["payment-required"]);
      expect(pr.x402Version).toBe(2);
      expect(pr.accepts).toHaveLength(1);

      const accepted = pr.accepts[0]!;

      // Validate fields populated from real 1CS quote
      expect(accepted.scheme).toBe("exact");
      expect(accepted.network).toBe(LIVE_NETWORK);
      expect(accepted.asset.toLowerCase()).toBe(LIVE_USDC_ADDRESS.toLowerCase());

      // payTo should be a real deposit address from 1CS
      expect(accepted.payTo).toMatch(/^0x[a-fA-F0-9]{40}$/);

      // Amount should be set (from quote.amountIn)
      expect(BigInt(accepted.amount)).toBeGreaterThan(0n);
      // For 1 USDC out, amountIn should be at least 1 USDC (1000000)
      expect(BigInt(accepted.amount)).toBeGreaterThanOrEqual(1000000n);

      // maxTimeoutSeconds from the quote deadline
      expect(accepted.maxTimeoutSeconds).toBeGreaterThan(0);

      // Extra fields for EIP-712
      expect(accepted.extra.name).toBe("USD Coin");
      expect(accepted.extra.version).toBe("2");
      expect(accepted.extra.assetTransferMethod).toBe("eip3009");

      // Resource info
      expect(pr.resource.url).toBe("/api/premium");
    }, LIVE_TIMEOUT);

    it("deposit address from 402 is unique per request", async () => {
      const deps = liveDeps();
      const app = createLiveTestApp(deps);

      const res1 = await request(app).get("/api/premium");
      const res2 = await request(app).get("/api/premium");

      const pr1 = decodePaymentRequiredHeader(res1.headers["payment-required"]);
      const pr2 = decodePaymentRequiredHeader(res2.headers["payment-required"]);

      // Each request should get a unique deposit address from 1CS
      expect(pr1.accepts[0]!.payTo).not.toBe(pr2.accepts[0]!.payTo);
    }, LIVE_TIMEOUT);
  });

  // ── 7. Full 402 → sign → 200 flow (real quote, mocked settlement) ─

  describe("Full 402 → sign → settle flow (real quote, mocked broadcast)", () => {
    it("completes the full x402 flow using a real 1CS quote", async () => {
      const deps = liveDeps();
      const app = createLiveTestApp(deps);

      // Step 1: GET without payment → 402 (real 1CS quote)
      const initialRes = await request(app).get("/api/premium");
      expect(initialRes.status).toBe(402);

      // Step 2: Decode the real 1CS-backed 402 response
      const pr = decodePaymentRequiredHeader(initialRes.headers["payment-required"]);
      const accepted = pr.accepts[0]!;

      // Verify this is a real deposit address (not the mock one)
      expect(accepted.payTo).toMatch(/^0x[a-fA-F0-9]{40}$/);

      // Step 3: Sign an EIP-3009 payload against the real deposit address/amount
      // IMPORTANT: We must override the `requirements` so the payload's `accepted`
      // field matches the real 1CS quote data (payTo, amount, etc.), not the mock defaults.
      const { payload: signedPayload } = await signEIP3009Payload(buyerWallet, {
        to: accepted.payTo,
        value: accepted.amount,
        requirements: {
          payTo: accepted.payTo,
          amount: accepted.amount,
          maxTimeoutSeconds: accepted.maxTimeoutSeconds,
        },
      });

      // Step 4: Retry with PAYMENT-SIGNATURE → settle (broadcast is mocked)
      const encoded = encodePaymentSignatureHeader(signedPayload as any);
      const paymentRes = await request(app)
        .get("/api/premium")
        .set("PAYMENT-SIGNATURE", encoded);

      // Should succeed (broadcast + polling are mocked to happy path)
      expect(paymentRes.status).toBe(200);
      expect(paymentRes.body.content).toBe("premium data");

      // PAYMENT-RESPONSE header should be present
      expect(paymentRes.headers["payment-response"]).toBeDefined();
    }, LIVE_TIMEOUT);
  });

  // ── 7b. X402Client.payAndFetch() against real 1CS-backed gateway ──

  describe("X402Client end-to-end against real 1CS quote", () => {
    it("payAndFetch completes the full x402 flow via the client library", async () => {
      const deps = liveDeps();
      const app = createLiveTestApp(deps);

      // Start on a random port so the X402Client can reach it via fetch
      const server = await new Promise<import("http").Server>((resolve) => {
        const s = app.listen(0, () => resolve(s));
      });
      const port = (server.address() as import("net").AddressInfo).port;

      try {
        // Use the client library — this is the exact code path end users would run
        const { X402Client } = await import("./client/index.js");
        const client = new X402Client({ gatewayUrl: `http://127.0.0.1:${port}` });

        const result = await client.payAndFetch(buyerWallet, "/api/premium");

        // Verify success
        expect(result.success).toBe(true);
        if (!result.success) return; // type narrowing

        // Resource body from the handler
        expect(result.body).toBeDefined();
        expect(result.body.content).toBe("premium data");

        // PAYMENT-RESPONSE settlement receipt
        expect(result.paymentResponse).toBeDefined();
        expect(result.paymentResponse.success).toBe(true);
        expect(result.paymentResponse.transaction).toBe(MOCK_TX_HASH);

        // The payment required envelope should reference the real 1CS quote
        expect(result.paymentRequired).toBeDefined();
        expect(result.paymentRequired.accepts.length).toBeGreaterThan(0);
        const accepted = result.paymentRequired.accepts[0]!;
        // payTo is a real 1CS deposit address (not mock)
        expect(accepted.payTo).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(accepted.network).toBe(LIVE_NETWORK);
        expect(accepted.asset.toLowerCase()).toBe(LIVE_USDC_ADDRESS.toLowerCase());
      } finally {
        server.close();
      }
    }, LIVE_TIMEOUT);
  });

  // ── 8. Quote engine error mapping ─────────────────────────────────

  describe("Quote engine 1CS error mapping", () => {
    it("maps 1CS 401 (bad JWT) to gateway 503", async () => {
      const deps = liveDeps({
        cfg: liveConfig({ oneClickJwt: "invalid-jwt-token" }),
      });
      const app = createLiveTestApp(deps);

      const res = await request(app).get("/api/premium");

      // Bad JWT → 1CS returns 401 → gateway maps to 503
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("AUTHENTICATION_ERROR");
    }, LIVE_TIMEOUT);

    it("maps 1CS 400 (bad asset) to gateway 503", async () => {
      const deps = liveDeps({
        cfg: liveConfig({ originAssetIn: "nep141:nonexistent.near" }),
      });
      const app = createLiveTestApp(deps);

      const res = await request(app).get("/api/premium");

      // Bad asset → 1CS returns 400 → gateway maps to 503
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("QUOTE_UNAVAILABLE");
    }, LIVE_TIMEOUT);
  });

  // ── 9. Different amount sizes ─────────────────────────────────────

  describe("Various amount sizes", () => {
    it("handles a small amount (0.01 USDC = 10000 units)", async () => {
      const cfg = liveConfig({ merchantAmountOut: "10000" }); // 0.01 USDC
      const deps = liveDeps({ cfg });
      const app = createLiveTestApp(deps);

      const res = await request(app).get("/api/premium");
      expect(res.status).toBe(402);

      const pr = decodePaymentRequiredHeader(res.headers["payment-required"]);
      expect(BigInt(pr.accepts[0]!.amount)).toBeGreaterThan(0n);
    }, LIVE_TIMEOUT);

    it("handles a larger amount (100 USDC = 100000000 units)", async () => {
      const cfg = liveConfig({ merchantAmountOut: "100000000" }); // 100 USDC
      const deps = liveDeps({ cfg });
      const app = createLiveTestApp(deps);

      const res = await request(app).get("/api/premium");
      expect(res.status).toBe(402);

      const pr = decodePaymentRequiredHeader(res.headers["payment-required"]);
      const amount = BigInt(pr.accepts[0]!.amount);
      // For 100 USDC out, amountIn should be at least 100 USDC
      expect(amount).toBeGreaterThanOrEqual(100000000n);
    }, LIVE_TIMEOUT);
  });

  // ── 10. State store persists real quote data ──────────────────────

  describe("State store with real 1CS data", () => {
    it("persists the real 1CS quote response in the state store", async () => {
      const store = new InMemoryStateStore();
      const deps = liveDeps({ store });
      const app = createLiveTestApp(deps);

      // Trigger a 402 to populate the store
      const res = await request(app).get("/api/premium");
      expect(res.status).toBe(402);

      // Decode the deposit address from the 402
      const pr = decodePaymentRequiredHeader(res.headers["payment-required"]);
      const depositAddress = pr.accepts[0]!.payTo;

      // Verify the state store has the real 1CS data
      const state = await store.get(depositAddress);
      expect(state).toBeDefined();
      expect(state!.phase).toBe("QUOTED");
      expect(state!.depositAddress).toBe(depositAddress);

      // The quote response should contain real 1CS data
      expect(state!.quoteResponse.correlationId).toBeTruthy();
      expect(state!.quoteResponse.quote.amountIn).toBeTruthy();
      expect(state!.quoteResponse.quote.amountOut).toBe("1000000"); // 1 USDC exact output
      expect(state!.quoteResponse.quote.depositAddress).toBe(depositAddress);

      // Payment requirements should be properly mapped
      expect(state!.paymentRequirements.scheme).toBe("exact");
      expect(state!.paymentRequirements.network).toBe(LIVE_NETWORK);
      expect(state!.paymentRequirements.payTo).toBe(depositAddress);
    }, LIVE_TIMEOUT);
  });

  // ── 11. Status endpoint reachability ──────────────────────────────

  describe("Status endpoint", () => {
    it("returns a response for a known or unknown deposit address", async () => {
      configureOneClickSdk(liveConfig());

      // Use a random address — we just want to confirm the endpoint is reachable
      const randomAddress = ethers.Wallet.createRandom().address;

      try {
        const resp = await OneClickService.getExecutionStatus(randomAddress);
        // If it succeeds, the status should be a string
        expect(typeof resp.status).toBe("string");
      } catch (err: any) {
        // 404 or 400 for unknown address is also fine — means the endpoint works
        expect([400, 404]).toContain(err.status);
      }
    }, LIVE_TIMEOUT);
  });

  // ── 12. Concurrent quotes ─────────────────────────────────────────

  describe("Concurrent quote requests", () => {
    it("handles 3 concurrent quote requests without errors", async () => {
      const deps1 = liveDeps();
      const deps2 = liveDeps();
      const deps3 = liveDeps();
      const app1 = createLiveTestApp(deps1);
      const app2 = createLiveTestApp(deps2);
      const app3 = createLiveTestApp(deps3);

      const [res1, res2, res3] = await Promise.all([
        request(app1).get("/api/premium"),
        request(app2).get("/api/premium"),
        request(app3).get("/api/premium"),
      ]);

      expect(res1.status).toBe(402);
      expect(res2.status).toBe(402);
      expect(res3.status).toBe(402);

      // Each should have a unique deposit address
      const pr1 = decodePaymentRequiredHeader(res1.headers["payment-required"]);
      const pr2 = decodePaymentRequiredHeader(res2.headers["payment-required"]);
      const pr3 = decodePaymentRequiredHeader(res3.headers["payment-required"]);

      const addresses = new Set([
        pr1.accepts[0]!.payTo,
        pr2.accepts[0]!.payTo,
        pr3.accepts[0]!.payTo,
      ]);
      expect(addresses.size).toBe(3);
    }, LIVE_TIMEOUT * 2);
  });
});
