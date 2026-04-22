/**
 * x402 Middleware — Express middleware wiring quote-engine → verifier → settler.
 *
 * Implements the full x402 HTTP flow as an Express middleware:
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
 * Internal design notes (cross-referenced in body comments):
 * - **D-M1**: Uses `@x402/core/http` for header encoding/decoding
 * - **D-M2**: Custom middleware (not `x402HTTPResourceServer`) — we are the facilitator
 * - **D-M3**: Empty body `{}` for 402 responses
 * - **D-M4**: Single `accepts` entry
 * - **D-M5**: Awaits full cross-chain settlement before responding
 * - **D-M6**: Expired quotes → fresh 402
 *
 * @module middleware
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
    console.warn(`[x402] State not found for deposit address: ${depositAddress} — returning fresh 402`);
    await returnPaymentRequired(req, res, deps);
    return;
  }

  // State expired → delete and return fresh 402
  const quoteDeadline = state.quoteResponse.quote.deadline;
  if (quoteDeadline && Date.now() > new Date(quoteDeadline).getTime()) {
    console.warn(`[x402] Quote expired for ${depositAddress} (deadline: ${quoteDeadline}) — returning fresh 402`);
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
    console.warn(`[x402] Verification failed for ${depositAddress}: ${verifyResult.error}`);
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

  console.log(
    `[x402] 402 issued for ${req.originalUrl} → deposit=${requirements.payTo}, amount=${requirements.amount}`,
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
 * Client-safe messages keyed by `GatewayError.code`. Intentionally vague —
 * full details (upstream error bodies, RPC endpoints, wallet balances,
 * stack traces) are logged server-side and identified via the correlation
 * ID included in every error response.
 *
 * **Do not include** internal state (balances, file paths, tx hashes that
 * weren't already visible to the client, upstream error payloads) in any
 * value here.
 */
const CLIENT_SAFE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  // Quote / 1CS reachability (503)
  QUOTE_UNAVAILABLE:
    "Unable to obtain a swap quote at this time. Please try again shortly.",
  AUTHENTICATION_ERROR:
    "Gateway cannot authenticate with the swap provider.",
  SERVICE_UNAVAILABLE:
    "Upstream swap service is temporarily unavailable. Please try again shortly.",
  DEADLINE_TOO_SHORT:
    "Quote deadline is too short to complete the payment safely. Please retry.",
  INSUFFICIENT_GAS:
    "Gateway is temporarily unable to process settlements. Please try again shortly.",

  // Settlement (502 / 504)
  SWAP_FAILED:
    "The cross-chain swap failed. If your payment was broadcast, contact the gateway operator with the correlation ID.",
  SWAP_TIMEOUT:
    "Settlement did not complete within the timeout. Contact the gateway operator with the correlation ID if you were charged.",
  BROADCAST_FAILED:
    "Failed to broadcast the payment transaction. Please retry.",
  POLL_FAILED:
    "Failed to observe the swap status after broadcast. Contact the gateway operator with the correlation ID if you were charged.",
  TX_REVERTED:
    "The payment transaction reverted on-chain. Please retry.",
  TX_NOT_MINED:
    "The payment transaction was not mined within the expected time. Contact the gateway operator with the correlation ID if you were charged.",

  // Protocol / payload (4xx, 5xx)
  NONCE_ALREADY_USED:
    "Payment authorization nonce has already been used. Request a fresh quote and sign again.",
  UNKNOWN_PAYLOAD:
    "Payment payload format not recognized.",
  MISSING_SIGNATURE:
    "Payment payload is missing a required signature.",
  STATE_NOT_FOUND:
    "No swap state found for this deposit address.",
  INVALID_PHASE:
    "Swap is not in a state that can be settled.",
  INCOMPLETE_STATE:
    "Swap state is incomplete. Request a fresh quote and sign again.",
});

/** Fallback when a GatewayError carries an unmapped code. */
const DEFAULT_GATEWAY_CLIENT_MESSAGE =
  "Gateway request failed. Contact the gateway operator with the correlation ID.";

/** Generic message returned for any non-GatewayError (500 INTERNAL_ERROR). */
const DEFAULT_INTERNAL_CLIENT_MESSAGE =
  "An unexpected error occurred. Contact the gateway operator with the correlation ID.";

/**
 * Generate a short correlation ID (8 hex chars) used to tie a client-facing
 * error response to the detailed server-side log entry. Short enough to
 * quote verbally, long enough to identify one request among thousands.
 */
function generateCorrelationId(): string {
  return Math.floor(Math.random() * 0x1_0000_0000)
    .toString(16)
    .padStart(8, "0");
}

/** Map a GatewayError to its client-safe message. */
function clientMessageFor(err: GatewayError): string {
  return CLIENT_SAFE_MESSAGES[err.code] ?? DEFAULT_GATEWAY_CLIENT_MESSAGE;
}

/**
 * Log the full error details server-side for operator debugging.
 *
 * Output goes to stderr via `console.error` and contains:
 *  - ISO timestamp and correlation ID
 *  - HTTP method, path, client IP (as available)
 *  - For `GatewayError`: name, code, HTTP status, and full message
 *  - For any `Error`: name and full message
 *  - For non-Error throws: the stringified value
 *  - The full stack trace (separate log line)
 *
 * This output **must never** reach the HTTP client. Only the correlation
 * ID is echoed back so operators can grep logs on incident reports.
 */
function logServerError(
  correlationId: string,
  req: Request | undefined,
  err: unknown,
): void {
  const timestamp = new Date().toISOString();
  const method = req?.method ?? "-";
  const path = req?.originalUrl ?? "-";
  const ip = req?.ip ?? req?.socket?.remoteAddress ?? "-";
  const prefix = `[x402][error][${timestamp}][cid=${correlationId}] ${method} ${path} from ${ip}`;

  if (err instanceof GatewayError) {
    console.error(
      `${prefix} — ${err.name} (code=${err.code}, httpStatus=${err.httpStatus}): ${err.message}`,
    );
    // Dump structured diagnostic context (request fields + hints) when
    // present. This is the operator's primary signal for "what actually
    // went wrong" — e.g. a malformed NEAR recipient vs. a flaky upstream.
    if (err.context && Object.keys(err.context).length > 0) {
      console.error(
        `[x402][error][cid=${correlationId}] context: ${JSON.stringify(err.context, null, 2)}`,
      );
    }
    if (err.stack) console.error(err.stack);
    return;
  }
  if (err instanceof Error) {
    console.error(`${prefix} — ${err.name}: ${err.message}`);
    if (err.stack) console.error(err.stack);
    return;
  }
  console.error(`${prefix} — Non-Error thrown: ${String(err)}`);
}

/**
 * Map errors to appropriate HTTP responses.
 *
 * Gateway errors carry their own `httpStatus`; unknown errors become 500.
 * For settlement failures (502, 504), we include a PAYMENT-RESPONSE header
 * with `success: false` so the client can interpret the failure.
 *
 * All error responses carry a short `correlationId`; the full error (name,
 * message, stack) is logged server-side under that ID so operators can
 * investigate without the client ever seeing internal details.
 */
function handleError(res: Response, err: unknown): void {
  const correlationId = generateCorrelationId();
  logServerError(correlationId, res.req, err);

  if (err instanceof GatewayError) {
    const status = err.httpStatus;
    const clientMsg = clientMessageFor(err);

    // For settlement-related errors, include PAYMENT-RESPONSE header
    if (status === 502 || status === 504) {
      const failResponse: SettleResponse = {
        success: false,
        errorReason: err.code,
        errorMessage: clientMsg,
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
      message: clientMsg,
      correlationId,
    });
    return;
  }

  // Unknown error — never reveal raw message or stack to the client.
  res.status(500).json({
    error: "INTERNAL_ERROR",
    message: DEFAULT_INTERNAL_CLIENT_MESSAGE,
    correlationId,
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
