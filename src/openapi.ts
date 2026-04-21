/**
 * `/openapi.json` document builder.
 *
 * This is x402scan's **primary** discovery surface — it's checked before
 * `/.well-known/x402`, so the richness of this document determines how
 * well the gateway is indexed. Key x402-specific fields:
 *
 *  - `info.title` / `info.version`                          (stock OpenAPI)
 *  - `servers[0].url`         — the public base URL
 *  - `x-discovery.ownershipProofs`                          (x402scan ext.)
 *  - `components.securitySchemes.x402`                      (stock OpenAPI)
 *  - Per operation:
 *      - `security: [{ x402: [] }]`                         (stock OpenAPI)
 *      - `x-payment-info: { protocols: "x402", ...pricing }` (x402scan ext.)
 *      - `requestBody` driven by `route.inputSchema`
 *      - `responses.200` driven by `route.outputSchema`
 *      - `responses.402` documenting the PAYMENT-REQUIRED header
 *
 * This module is a **pure builder** — no Express handler, no I/O. The
 * `server.ts` entry point calls `buildOpenApiDocument` at startup and
 * serves the resulting plain object as JSON from `GET /openapi.json`.
 *
 * @module openapi
 * @see docs/X402SCAN_PLAN.md — Phase 4
 */

import type { GatewayConfig } from "./config.js";
import type {
  ProtectedMethod,
  ProtectedRoute,
  RoutePricing,
} from "./protected-routes.js";
import { validateOwnershipProofs } from "./ownership-proof.js";

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

/**
 * Static metadata describing the gateway itself. Passed in (rather than
 * derived from `package.json`) so the builder stays pure and testable
 * without JSON imports, and so release tooling controls the version
 * string the document advertises.
 */
export interface OpenApiInfo {
  /** Human-readable title — shown in x402scan's indexer. */
  title: string;
  /** Semantic version string from the package manifest. */
  version: string;
  /** Optional longer description. */
  description?: string;
}

/**
 * The built document. The shape follows OpenAPI 3.1 with x402scan-style
 * extensions; we model it loosely (`Record<string, unknown>`) because
 * dragging in a full OpenAPI type dependency buys us nothing here and
 * would fight the x402 extensions.
 */
export type OpenApiDocument = Record<string, unknown>;

// ═══════════════════════════════════════════════════════════════════════
// Builder
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build the OpenAPI document for every protected route.
 *
 * Pure function: returns a fresh plain object on each call. Safe to
 * compute per-request, but `server.ts` caches it at startup since the
 * routes registry and config are both immutable at runtime.
 *
 * Behaviour when `publicBaseUrl` is unset (local development):
 *  - `servers` is omitted entirely (allowed by OpenAPI 3.1).
 *  - `x-discovery.ownershipProofs` is emitted as an empty array — the
 *    proofs would be structurally valid but semantically meaningless
 *    without a canonical base URL, so we drop them to avoid confusing
 *    indexers.
 *  - Paths still appear with their paid-resource metadata; local
 *    consumers can still use the document for development / testing.
 */
export function buildOpenApiDocument(
  info: OpenApiInfo,
  cfg: GatewayConfig,
  routes: readonly ProtectedRoute[],
): OpenApiDocument {
  const baseUrl = cfg.publicBaseUrl;

  // Filter malformed ownership proofs the same way the well-known
  // document does, so the two surfaces never disagree.
  const { valid: validProofs } = validateOwnershipProofs(
    cfg.ownershipProofs,
    baseUrl,
  );

  const doc: OpenApiDocument = {
    openapi: "3.1.0",
    info: {
      title: info.title,
      version: info.version,
      ...(info.description ? { description: info.description } : {}),
    },
    ...(baseUrl
      ? {
          servers: [
            {
              url: baseUrl,
              description: "Gateway public endpoint",
            },
          ],
        }
      : {}),
    "x-discovery": {
      ownershipProofs: validProofs,
    },
    components: {
      securitySchemes: {
        x402: {
          type: "http",
          scheme: "x402",
          description:
            "Pay-per-request authentication via the x402 protocol. Clients receive a 402 with a PAYMENT-REQUIRED envelope, sign an EIP-712 authorization, and retry with PAYMENT-SIGNATURE.",
        },
      },
    },
    paths: buildPaths(routes),
  };

  return doc;
}

// ═══════════════════════════════════════════════════════════════════════
// Path-item construction
// ═══════════════════════════════════════════════════════════════════════

function buildPaths(
  routes: readonly ProtectedRoute[],
): Record<string, Record<string, unknown>> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    // Multiple methods on the same path share a single path item.
    const pathItem = paths[route.path] ?? {};
    pathItem[route.method.toLowerCase()] = buildOperation(route);
    paths[route.path] = pathItem;
  }

  return paths;
}

function buildOperation(route: ProtectedRoute): Record<string, unknown> {
  const operation: Record<string, unknown> = {
    summary: route.summary,
    ...(route.description ? { description: route.description } : {}),
    security: [{ x402: [] }],
    "x-payment-info": buildPaymentInfo(route.pricing),
  };

  // Attach request body when the route defines an input schema. We
  // advertise JSON for POST and query-style usage for GET (by convention
  // GET routes are parameterless here; the schema is still useful for
  // the Bazaar `inputSchema` field when we wire that in Phase 5).
  if (route.inputSchema) {
    attachRequestShape(operation, route.method, route.inputSchema);
  }

  operation.responses = buildResponses(route);

  return operation;
}

/**
 * Translate the registry's `RoutePricing` (union type) into the
 * x402scan-compatible `x-payment-info` block.
 *
 * Output shape per x402scan DISCOVERY.md:
 *  - fixed:   `{ protocols: "x402", mode: "fixed",   currency, amount }`
 *  - dynamic: `{ protocols: "x402", mode: "dynamic", currency, min, max }`
 */
function buildPaymentInfo(pricing: RoutePricing): Record<string, unknown> {
  if (pricing.mode === "fixed") {
    return {
      protocols: "x402",
      mode: "fixed",
      currency: pricing.currency,
      amount: pricing.amount,
    };
  }
  return {
    protocols: "x402",
    mode: "dynamic",
    currency: pricing.currency,
    min: pricing.min,
    max: pricing.max,
  };
}

/**
 * Attach the input shape to an operation.
 *
 * - For POST: an `application/json` `requestBody` whose schema is the
 *   registry's `inputSchema`.
 * - For GET: attach nothing at the operation level (GETs in the v1
 *   registry are parameterless); the Bazaar `info.inputSchema` on the
 *   402 challenge (Phase 5) is where the input shape actually lives.
 */
function attachRequestShape(
  operation: Record<string, unknown>,
  method: ProtectedMethod,
  inputSchema: Record<string, unknown>,
): void {
  if (method === "POST") {
    operation.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: inputSchema,
        },
      },
    };
  }
  // For GET, do nothing — query parameters would be `parameters: [...]`
  // but the v1 registry has no parameterised GETs, and emitting an
  // empty array is noise.
}

function buildResponses(route: ProtectedRoute): Record<string, unknown> {
  const responses: Record<string, unknown> = {
    "200": {
      description: "Paid resource response",
      ...(route.outputSchema
        ? {
            content: {
              "application/json": {
                schema: route.outputSchema,
              },
            },
          }
        : {}),
    },
    "402": {
      description:
        "Payment required. The response carries a PAYMENT-REQUIRED header " +
        "with a base64-encoded x402 envelope (v2). Clients sign an EIP-712 " +
        "authorization and retry the request with a PAYMENT-SIGNATURE header.",
      headers: {
        "PAYMENT-REQUIRED": {
          description:
            "Base64-encoded x402 PaymentRequired envelope listing the accepted payment options.",
          schema: { type: "string" },
        },
      },
    },
  };
  return responses;
}
