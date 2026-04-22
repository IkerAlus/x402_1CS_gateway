/**
 * Protected Routes Registry — the single source of truth for every paid
 * endpoint served by the gateway.
 *
 * Every protected HTTP route lives here as a {@link ProtectedRoute} entry
 * with:
 *  - HTTP method + path
 *  - Human-readable summary + description (OpenAPI operation fields)
 *  - Pricing metadata (fixed or dynamic, currency, bounds)
 *  - Optional JSON Schemas for request input + success response (required
 *    for x402scan's `extensions.bazaar.info` and for the OpenAPI doc)
 *  - The Express handler invoked **after** a successful x402 settlement
 *
 * Three call-sites consume this registry:
 *
 *  1. `src/server.ts` — mounts each route through `createX402Middleware`
 *     and the entry's handler.
 *  2. `src/openapi.ts` — renders each entry as a path item in the
 *     OpenAPI 3.x document served at `/openapi.json`.
 *  3. `src/discovery.ts` — emits each `path` as an absolute URL in the
 *     `/.well-known/x402` fan-out document.
 *
 * Adding a new paid endpoint is one `PROTECTED_ROUTES` entry — the three
 * discovery surfaces pick it up automatically.
 *
 * @module protected-routes
 */

import type { RequestHandler } from "express";

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

/** HTTP verbs the gateway supports for paid routes (expand as needed). */
export type ProtectedMethod = "GET" | "POST";

/**
 * Fixed-price operation — every successful settlement transfers the same
 * merchant amount. `amount` is the price in the quote's currency (not the
 * buyer's origin-chain token amount — that's computed per-request by the
 * 1Click quote engine).
 */
export interface FixedPricing {
  mode: "fixed";
  currency: "USD";
  /** Price string, e.g. "0.05". Follows x402scan `x-payment-info` spec. */
  amount: string;
}

/**
 * Dynamic-price operation — the actual price is computed per-request and
 * falls within a declared band. Reserved for future use; the 1CS flow is
 * currently EXACT_OUTPUT at a fixed merchant amount.
 */
export interface DynamicPricing {
  mode: "dynamic";
  currency: "USD";
  /** Inclusive lower bound, e.g. "0.01". */
  min: string;
  /** Inclusive upper bound, e.g. "1.00". */
  max: string;
}

/** Pricing metadata surfaced in `x-payment-info` and `extensions.bazaar`. */
export type RoutePricing = FixedPricing | DynamicPricing;

/**
 * A paid HTTP route the gateway serves.
 *
 * All fields except `description`, `inputSchema`, and `outputSchema` are
 * required. `inputSchema` is effectively required for x402scan to classify
 * the route as machine-invocable; omit only for purely human-facing pages.
 */
export interface ProtectedRoute {
  /** URL path, must start with `/`. Used as Express route + OpenAPI key. */
  path: string;
  method: ProtectedMethod;
  /** Short operation title, surfaces in OpenAPI + Bazaar `info.name`. */
  summary: string;
  /** Longer human-readable description; used by OpenAPI + Bazaar. */
  description?: string;
  /** Pricing metadata — fixed amount or dynamic min/max band. */
  pricing: RoutePricing;
  /**
   * JSON Schema for the request body / query input. Copied into
   * `extensions.bazaar.info.inputSchema` on the 402 challenge and into the
   * OpenAPI `requestBody`. Required for x402scan to mark the route as
   * machine-invocable.
   */
  inputSchema?: Record<string, unknown>;
  /**
   * JSON Schema for the success (200) response body. Copied into
   * `extensions.bazaar.info.outputSchema` and the OpenAPI `responses.200`.
   */
  outputSchema?: Record<string, unknown>;
  /**
   * Express handler invoked **after** a successful x402 settlement. The
   * middleware has already validated the payment, broadcast the tx,
   * confirmed 1CS settlement, and attached the `PAYMENT-RESPONSE` header
   * by the time this handler runs.
   */
  handler: RequestHandler;
}

// ═══════════════════════════════════════════════════════════════════════
// Validation
// ═══════════════════════════════════════════════════════════════════════

/**
 * Validate a {@link ProtectedRoute} entry. Throws a descriptive error if
 * any required field is malformed. Called once at startup, before any
 * route is mounted, so misconfiguration fails fast with a clear message.
 */
export function validateProtectedRoute(route: ProtectedRoute): void {
  if (typeof route.path !== "string" || !route.path.startsWith("/")) {
    throw new Error(
      `ProtectedRoute.path must be a string starting with "/", got ${JSON.stringify(route.path)}`,
    );
  }
  if (route.method !== "GET" && route.method !== "POST") {
    throw new Error(
      `ProtectedRoute(${route.path}).method must be "GET" or "POST", got ${JSON.stringify(route.method)}`,
    );
  }
  if (typeof route.summary !== "string" || route.summary.length === 0) {
    throw new Error(
      `ProtectedRoute(${route.path}).summary must be a non-empty string`,
    );
  }
  if (typeof route.handler !== "function") {
    throw new Error(
      `ProtectedRoute(${route.path}).handler must be a function`,
    );
  }
  if (route.pricing.mode === "fixed") {
    if (typeof route.pricing.amount !== "string" || route.pricing.amount.length === 0) {
      throw new Error(
        `ProtectedRoute(${route.path}).pricing.amount must be a non-empty string for fixed mode`,
      );
    }
  } else if (route.pricing.mode === "dynamic") {
    if (typeof route.pricing.min !== "string" || route.pricing.min.length === 0) {
      throw new Error(
        `ProtectedRoute(${route.path}).pricing.min must be a non-empty string for dynamic mode`,
      );
    }
    if (typeof route.pricing.max !== "string" || route.pricing.max.length === 0) {
      throw new Error(
        `ProtectedRoute(${route.path}).pricing.max must be a non-empty string for dynamic mode`,
      );
    }
  } else {
    // Exhaustiveness check — TypeScript catches new modes at compile time;
    // this branch handles plain-JS callers or runtime tampering.
    throw new Error(
      `ProtectedRoute(${route.path}).pricing.mode must be "fixed" or "dynamic"`,
    );
  }
}

/**
 * Validate an entire registry. Enforces per-entry shape plus global
 * constraints: path uniqueness (path+method tuple), at least one route.
 */
export function validateProtectedRoutes(routes: readonly ProtectedRoute[]): void {
  if (routes.length === 0) {
    throw new Error("PROTECTED_ROUTES registry is empty — at least one route is required");
  }
  const seen = new Set<string>();
  for (const route of routes) {
    validateProtectedRoute(route);
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate route in registry: ${key}`);
    }
    seen.add(key);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// The registry
//
// Add a new paid endpoint by appending a {@link ProtectedRoute} entry
// here. The three discovery surfaces (server mount, OpenAPI document,
// well-known fan-out) pick it up automatically.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Default output schema for the demo `/api/premium` route — matches the
 * shape returned by the handler in `server.ts`. Lives alongside the
 * registry so OpenAPI and Bazaar consumers see the same source of truth.
 */
const PREMIUM_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    message: { type: "string" },
    timestamp: { type: "string", format: "date-time" },
    merchant: { type: "string", description: "Merchant recipient on the destination chain." },
    amountReceived: {
      type: "string",
      description: "Amount the merchant received on the destination chain, in smallest unit.",
    },
    destinationAsset: {
      type: "string",
      description: "1CS asset ID the merchant received (e.g. nep141:usdt.tether-token.near).",
    },
  },
  required: ["message", "timestamp", "merchant", "amountReceived", "destinationAsset"],
};

/**
 * The live registry. Currently seeded with the single demo resource;
 * future paid routes are appended here. Handlers stay in this file so
 * each entry is a single cohesive unit — the handler's shape obviously
 * matches the `outputSchema` next to it.
 */
export const PROTECTED_ROUTES: readonly ProtectedRoute[] = [
  {
    path: "/api/premium",
    method: "GET",
    summary: "Fetch the premium demo resource",
    description:
      "Demo x402 resource. After a successful cross-chain settlement via 1Click " +
      "Swap, returns a small JSON payload including the merchant destination and " +
      "the amount received. Useful for smoke-testing the full 402 → sign → 200 flow.",
    pricing: {
      mode: "fixed",
      currency: "USD",
      // Indicative USD value; the actual origin-chain amount is computed
      // per-request by the 1Click quote engine (it depends on live FX).
      amount: "0.01",
    },
    // No input required — the route is a parameterless GET.
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    outputSchema: PREMIUM_OUTPUT_SCHEMA,
    // Handler is attached at startup (see `buildPremiumHandler` below)
    // where it has access to `cfg`. The placeholder here throws loudly
    // if anyone mounts the raw registry entry by mistake.
    handler: (_req, _res, next) => next(new Error(
      "handler not bound — the registry entry must be cloned with a real handler at startup; " +
      "see `buildPremiumHandler` in src/protected-routes.ts",
    )),
  },
];

// ═══════════════════════════════════════════════════════════════════════
// Handler factories
//
// Some handlers need access to config values at request time (e.g. the
// merchant address to echo back). Rather than sprinkle closures through
// the registry, we expose small factories here; server.ts calls them at
// startup and replaces the placeholder handlers on cloned entries.
// ═══════════════════════════════════════════════════════════════════════

import type { GatewayConfig } from "./config.js";

/**
 * Build the handler for `GET /api/premium`. Kept co-located with the
 * route entry so the handler's shape obviously matches `outputSchema`.
 */
export function buildPremiumHandler(cfg: GatewayConfig): RequestHandler {
  return (_req, res) => {
    res.json({
      message: "You've paid! Here is your premium content.",
      timestamp: new Date().toISOString(),
      merchant: cfg.merchantRecipient,
      amountReceived: cfg.merchantAmountOut,
      destinationAsset: cfg.merchantAssetOut,
    });
  };
}

/**
 * Produce a ready-to-mount copy of the registry with per-request
 * handlers bound to the runtime config. Validates the final list before
 * returning; throws if anything is malformed.
 *
 * Keep this the **only** way server.ts obtains its list of routes, so
 * adding a new entry never requires touching server.ts.
 */
export function buildProtectedRoutes(cfg: GatewayConfig): ProtectedRoute[] {
  const bound: ProtectedRoute[] = PROTECTED_ROUTES.map((route) => {
    switch (route.path) {
      case "/api/premium":
        return { ...route, handler: buildPremiumHandler(cfg) };
      default:
        // New entries: bind their handler here, or leave as-is if the
        // registry already carries a self-contained handler.
        return { ...route };
    }
  });
  validateProtectedRoutes(bound);
  return bound;
}
