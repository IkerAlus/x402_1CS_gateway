/**
 * x402 Middleware — Express middleware wiring quote-engine → verifier → settler.
 *
 * This module handles Step 2.1 of the implementation roadmap. It implements
 * the full x402 HTTP flow as an Express middleware:
 *
 * 1. **No PAYMENT-SIGNATURE header** → call Quote Engine → return 402 with
 *    `PAYMENT-REQUIRED` header containing the `PaymentRequired` envelope.
 * 2. **PAYMENT-SIGNATURE present** → decode → look up SwapState:
 *    - Not found → return fresh 402
 *    - Expired → delete stale state, return fresh 402
 *    - Already SETTLED → return cached 200 with PAYMENT-RESPONSE
 *    - QUOTED → call Verifier → on success → call Settler → return 200
 * 3. Errors → appropriate HTTP status + PAYMENT-RESPONSE where applicable.
 *
 * Design decisions (all "recommended"):
 * - D-M1: Uses `@x402/core/http` for header encoding/decoding
 * - D-M2: Custom middleware (not `x402HTTPResourceServer`) — we are the facilitator
 * - D-M3: Empty body `{}` for 402 responses
 * - D-M4: Single `accepts` entry for v1
 * - D-M5: Awaits full cross-chain settlement (Option A)
 * - D-M6: Expired quotes → fresh 402
 *
 * @module middleware
 * @see Implementation roadmap Step 2.1
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";
import {
  encodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentRequired, SettleResponse, Network } from "@x402/core/types";
import type { GatewayConfig } from "./config.js";
import type { StateStore, PaymentPayloadRecord } from "./types.js";
import { GatewayError } from "./types.js";
import { buildPaymentRequirements } from "./quote-engine.js";
import type { QuoteFn } from "./quote-engine.js";
import { verifyPayment } from "./verifier.js";
import type { ChainReader } from "./verifier.js";
import { settlePayment } from "./settler.js";
import type {
  BroadcastFn,
  DepositNotifyFn,
  StatusPollFn,
  SettlerOptions,
} from "./settler.js";
import type {
  QuoteRateLimiter,
  SettlementLimiter,
} from "./rate-limiter.js";

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

/**
 * Dependencies injected into the middleware.
 *
 * All external I/O is abstracted behind these interfaces, matching the
 * injectable pattern established in the verifier and settler modules.
 */
export interface MiddlewareDeps {
  /** Gateway configuration. */
  cfg: GatewayConfig;
  /** State persistence layer. */
  store: StateStore;
  /** On-chain reader for verifier balance/allowance checks. */
  chainReader: ChainReader;
  /** On-chain transaction broadcaster. */
  broadcastFn: BroadcastFn;
  /** 1CS deposit notification. */
  depositNotifyFn: DepositNotifyFn;
  /** 1CS status poller. */
  statusPollFn: StatusPollFn;
  /** Injectable 1CS quote function. */
  quoteFn?: QuoteFn;
  /** Settler tuning options. */
  settlerOptions?: SettlerOptions;
  /**
   * Resource description for the x402 PaymentRequired envelope.
   * @default { url: req.originalUrl }
   */
  resourceDescription?: string;
  /** Per-IP rate limiter for quote (402) generation. */
  quoteLimiter?: QuoteRateLimiter;
  /** Concurrent settlement limiter. */
  settlementLimiter?: SettlementLimiter;
}

// ═══════════════════════════════════════════════════════════════════════
// Middleware factory
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create an Express middleware that implements the x402 payment flow.
 *
 * Attach this middleware to any route that requires payment:
 *
 * ```ts
 * const app = express();
 * const x402 = createX402Middleware(deps);
 *
 * app.get("/api/premium", x402, (req, res) => {
 *   res.json({ data: "premium content" });
 * });
 * ```
 *
 * When a client requests a protected route:
 * - Without payment → 402 with `PAYMENT-REQUIRED` header
 * - With valid payment → settlement → 200 with `PAYMENT-RESPONSE` header + next()
 *
 * @param deps Injected dependencies (config, store, chain reader, broadcaster, etc.)
 * @returns Express middleware function
 */
export function createX402Middleware(deps: MiddlewareDeps): RequestHandler {
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  return (async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await handleX402Request(req, res, next, deps);
    } catch (err) {
      handleError(res, err);
    }
  }) as RequestHandler;
}

// ═══════════════════════════════════════════════════════════════════════
// Core request handler
// ═══════════════════════════════════════════════════════════════════════

/**
 * Process an incoming request through the x402 payment flow.
 */
async function handleX402Request(
  req: Request,
  res: Response,
  next: NextFunction,
  deps: MiddlewareDeps,
): Promise<void> {
  const paymentSignatureHeader = req.headers["payment-signature"] as string | undefined;

  // ── No payment header → return 402 with fresh quote ──────────────
  if (!paymentSignatureHeader) {
    // Rate-limit quote generation per IP
    if (deps.quoteLimiter) {
      const clientIp = req.ip ?? req.socket.remoteAddress ?? "unknown";
      const rl = deps.quoteLimiter.check(clientIp);
      if (!rl.allowed) {
        res.status(429);
        res.setHeader("Retry-After", String(Math.ceil((rl.resetAt - Date.now()) / 1000)));
        res.setHeader("X-RateLimit-Limit", String(rl.limit));
        res.setHeader("X-RateLimit-Remaining", "0");
        res.setHeader("X-RateLimit-Reset", String(Math.ceil(rl.resetAt / 1000)));
        res.json({ error: "RATE_LIMITED", message: "Too many quote requests. Try again later." });
        return;
      }
      // Set rate-limit headers on successful requests too
      res.setHeader("X-RateLimit-Limit", String(rl.limit));
      res.setHeader("X-RateLimit-Remaining", String(rl.remaining));
      res.setHeader("X-RateLimit-Reset", String(Math.ceil(rl.resetAt / 1000)));
    }

    await returnPaymentRequired(req, res, deps);
    return;
  }

  // ── Decode the buyer's payment payload ────────────────────────────
  let paymentPayload: PaymentPayloadRecord;
  try {
    paymentPayload = decodePaymentSignatureHeader(paymentSignatureHeader) as unknown as PaymentPayloadRecord;
  } catch {
    res.status(400).json({ error: "Invalid PAYMENT-SIGNATURE header" });
    return;
  }

  // ── Look up the swap state ────────────────────────────────────────
  const depositAddress = paymentPayload.accepted?.payTo;
  if (!depositAddress) {
    res.status(400).json({ error: "Payment payload missing accepted.payTo" });
    return;
  }

  const state = await deps.store.get(depositAddress);

  // State not found → return fresh 402
  if (!state) {
    await returnPaymentRequired(req, res, deps);
    return;
  }

  // State expired → delete and return fresh 402
  const quoteDeadline = state.quoteResponse.quote.deadline;
  if (quoteDeadline && Date.now() > new Date(quoteDeadline).getTime()) {
    await deps.store.delete(depositAddress);
    await returnPaymentRequired(req, res, deps);
    return;
  }

  // Already settled → return cached success
  if (state.phase === "SETTLED" && state.settlementResponse) {
    const settleResponse = toSettleResponse(state.settlementResponse);
    res.setHeader("PAYMENT-RESPONSE", encodePaymentResponseHeader(settleResponse));
    next();
    return;
  }

  // Already in progress (BROADCASTING, BROADCAST, POLLING) → reject
  if (state.phase !== "QUOTED") {
    res.status(409).json({
      error: `Swap already in progress (phase: ${state.phase})`,
    });
    return;
  }

  // ── Verify the payment ────────────────────────────────────────────
  const verifyResult = await verifyPayment(
    paymentPayload,
    deps.store,
    deps.chainReader,
    deps.cfg,
  );

  if (!verifyResult.valid) {
    // Verification failed → return 402 with error
    const { requirements } = await buildPaymentRequirements(
      deps.cfg,
      deps.store,
      req.originalUrl,
      deps.quoteFn,
    );

    const paymentRequired: PaymentRequired = {
      x402Version: 2,
      error: verifyResult.error,
      resource: {
        url: req.originalUrl,
        description: deps.resourceDescription,
      },
      accepts: [toPaymentRequirements(requirements)],
    };

    res.status(402);
    res.setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired));
    res.json({});
    return;
  }

  // ── Check settlement capacity ──────────────────────────────────────
  if (deps.settlementLimiter && !deps.settlementLimiter.acquire()) {
    res.status(503).json({
      error: "SETTLEMENT_CAPACITY_EXCEEDED",
      message: "Too many settlements in progress. Try again shortly.",
    });
    return;
  }

  // ── Settle the payment ────────────────────────────────────────────
  try {
    const settlementResponse = await settlePayment(
      depositAddress,
      deps.store,
      deps.broadcastFn,
      deps.depositNotifyFn,
      deps.statusPollFn,
      deps.cfg,
      deps.settlerOptions,
    );

    // ── Success → set PAYMENT-RESPONSE header and call next() ──────
    const settleResponse = toSettleResponse(settlementResponse);
    res.setHeader("PAYMENT-RESPONSE", encodePaymentResponseHeader(settleResponse));
    next();
  } finally {
    // Always release the slot, whether settlement succeeded or failed
    deps.settlementLimiter?.release();
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 402 response builder
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build and send a 402 Payment Required response with a fresh 1CS quote.
 */
async function returnPaymentRequired(
  req: Request,
  res: Response,
  deps: MiddlewareDeps,
): Promise<void> {
  const { requirements } = await buildPaymentRequirements(
    deps.cfg,
    deps.store,
    req.originalUrl,
    deps.quoteFn,
  );

  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: {
      url: req.originalUrl,
      description: deps.resourceDescription,
    },
    accepts: [toPaymentRequirements(requirements)],
  };

  res.status(402);
  res.setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired));
  res.json({});
}

// ═══════════════════════════════════════════════════════════════════════
// Error handling
// ═══════════════════════════════════════════════════════════════════════

/**
 * Map errors to appropriate HTTP responses.
 *
 * Gateway errors carry their own `httpStatus`; unknown errors become 500.
 * For settlement failures (502, 504), we include a PAYMENT-RESPONSE header
 * with `success: false` so the client can interpret the failure.
 */
function handleError(res: Response, err: unknown): void {
  if (err instanceof GatewayError) {
    const status = err.httpStatus;

    // For settlement-related errors, include PAYMENT-RESPONSE header
    if (status === 502 || status === 504) {
      const failResponse: SettleResponse = {
        success: false,
        errorReason: err.code,
        errorMessage: err.message,
        transaction: "",
        network: "" as Network,
      };

      try {
        res.setHeader("PAYMENT-RESPONSE", encodePaymentResponseHeader(failResponse));
      } catch {
        // If encoding fails, still send the error response
      }
    }

    res.status(status).json({
      error: err.code,
      message: err.message,
    });
    return;
  }

  // Unknown error
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({
    error: "INTERNAL_ERROR",
    message,
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

/**
 * Convert our internal `PaymentRequirementsRecord` to the x402 `PaymentRequirements`
 * type. The only difference is `network` — ours is `string`, x402's is a
 * template literal `${string}:${string}`.
 */
function toPaymentRequirements(
  record: import("./types.js").PaymentRequirementsRecord,
): import("@x402/core/types").PaymentRequirements {
  return {
    ...record,
    network: record.network as Network,
  };
}

/**
 * Convert our internal `SettlementResponseRecord` to the x402 `SettleResponse`
 * type expected by `encodePaymentResponseHeader`.
 */
function toSettleResponse(
  record: import("./types.js").SettlementResponseRecord,
): SettleResponse {
  return {
    success: record.success,
    errorReason: record.errorReason,
    errorMessage: record.errorMessage,
    payer: record.payer,
    transaction: record.transaction,
    network: record.network as import("@x402/core/types").Network,
    extensions: record.extra ? { crossChain: record.extra } : undefined,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Express app factory (convenience)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a minimal Express app with the x402 middleware on all routes.
 *
 * Useful for testing and simple deployments. For production, mount the
 * middleware on specific routes using `createX402Middleware()`.
 *
 * ```ts
 * const app = createGatewayApp(deps, (req, res) => {
 *   res.json({ message: "Premium content" });
 * });
 * ```
 */
export async function createGatewayApp(
  deps: MiddlewareDeps,
  handler: RequestHandler,
): Promise<import("express").Express> {
  const express = await import("express");
  const app = express.default();

  app.use(express.default.json());
  app.use(createX402Middleware(deps));
  app.get("*", handler);

  return app;
}
