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
 *  - `x-crosschain`           — protocol + schema pointer   (gateway ext.)
 *  - `components.securitySchemes.x402`                      (stock OpenAPI)
 *  - `components.schemas.CrossChainQuoteExtra`              (informational shape)
 *  - Per operation:
 *      - `security: [{ x402: [] }]`                         (stock OpenAPI)
 *      - `x-payment-info: { protocols: "x402", ...pricing }` (x402scan ext.)
 *      - `requestBody` driven by `route.inputSchema`
 *      - `responses.200` driven by `route.outputSchema`
 *      - `responses.402` documenting the PAYMENT-REQUIRED header (and its
 *        decoded `accepts[0].extra.crossChain` informational block)
 *
 * This module is a **pure builder** — no Express handler, no I/O. The
 * `server.ts` entry point calls `buildOpenApiDocument` at startup and
 * serves the resulting plain object as JSON from `GET /openapi.json`.
 *
 * @module openapi
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

/**
 * JSON Schema for the `accepts[0].extra.crossChain` informational block
 * carried on every 402 envelope. Advertised in the OpenAPI document at
 * `components.schemas.CrossChainQuoteExtra` so indexers (x402scan,
 * generic OpenAPI tooling) and integrators can discover the shape
 * without parsing a live 402 response.
 *
 * Mirrors {@link import("./types.js").CrossChainQuoteExtra} 1:1. Kept as
 * a module-level constant so a future shape change is one edit here +
 * one in `types.ts` + one in `quote-engine.ts`.
 */
export const CROSS_CHAIN_QUOTE_SCHEMA: Readonly<Record<string, unknown>> =
  Object.freeze({
    type: "object",
    description:
      "Informational 1CS quote metadata carried on `accepts[0].extra.crossChain`. " +
      "Never used for signing. Clients opt in by checking `protocol === \"1cs\"`; " +
      "clients that don't care ignore the whole object.",
    required: [
      "protocol",
      "quoteId",
      "destinationRecipient",
      "destinationAsset",
      "amountOut",
      "amountOutFormatted",
      "amountOutUsd",
      "amountInUsd",
      "refundTo",
    ],
    properties: {
      protocol: {
        type: "string",
        enum: ["1cs"],
        description: "Cross-chain protocol discriminator.",
      },
      quoteId: {
        type: "string",
        description: "1CS quote correlation ID — use when contacting support.",
      },
      destinationRecipient: {
        type: "string",
        description: "Merchant recipient on the destination chain.",
      },
      destinationAsset: {
        type: "string",
        description: "1CS asset ID the merchant receives.",
      },
      amountOut: {
        type: "string",
        description: "Expected destination amount (smallest unit).",
      },
      amountOutFormatted: {
        type: "string",
        description: "Human-readable destination amount (e.g. \"10.00\").",
      },
      amountOutUsd: {
        type: "string",
        description: "USD value of the destination amount.",
      },
      amountInUsd: {
        type: "string",
        description: "USD value of the buyer's origin-chain authorisation.",
      },
      refundFee: {
        type: "string",
        description:
          "Fee charged if the deposit is refunded. Optional (chain-dependent).",
      },
      refundTo: {
        type: "string",
        description: "Address that receives refunds from failed swaps.",
      },
      depositMemo: {
        type: "string",
        description:
          "Memo required by certain destination chains (Stellar, XRP, " +
          "Cosmos-family). Omitted when the chain does not require one.",
      },
    },
  });

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
    "x-crosschain": {
      protocol: "1cs",
      schema: "#/components/schemas/CrossChainQuoteExtra",
      description:
        "Every 402 envelope carries an informational `accepts[0].extra.crossChain` " +
        "block (quote ID, destination amount, refund details, optional deposit memo). " +
        "Full shape in `schema` above; clients that only speak the EVM `exact` " +
        "scheme can ignore it entirely.",
    },
    // `paths` before `components` follows the OpenAPI 3.x spec's own
    // example ordering (openapi → info → servers → paths → components)
    // and keeps the human-readable route list near the top of the JSON,
    // above the bulky supporting-schema block.
    paths: buildPaths(routes),
    components: {
      securitySchemes: {
        x402: {
          type: "http",
          scheme: "x402",
          description:
            "Pay-per-request authentication via the x402 protocol. Clients receive a 402 with a PAYMENT-REQUIRED envelope, sign an EIP-712 authorization, and retry with PAYMENT-SIGNATURE.",
        },
      },
      schemas: {
        CrossChainQuoteExtra: CROSS_CHAIN_QUOTE_SCHEMA,
      },
    },
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
  // the Bazaar `inputSchema` field if/when that deferred integration
  // lands — see the "Non-Goals" section of docs/X402SCAN_PLAN.md).
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
 * - For GET: attach nothing at the operation level (GETs in the current
 *   registry are parameterless); a future Bazaar `info.inputSchema` on
 *   the 402 challenge (deferred integration, see docs/X402SCAN_PLAN.md)
 *   is where the input shape will live.
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
        "Payment required. The `PAYMENT-REQUIRED` header carries a base64-encoded " +
        "x402 v2 envelope; clients sign an EIP-712 authorization and retry with " +
        "`PAYMENT-SIGNATURE`. Decoded, `accepts[0].extra.crossChain` conforms to " +
        "CrossChainQuoteExtra — informational metadata about the 1Click Swap; " +
        "safe to ignore if unused.",
      headers: {
        "PAYMENT-REQUIRED": {
          description: "Base64-encoded x402 PaymentRequired envelope (v2).",
          schema: { type: "string" },
        },
      },
    },
  };
  return responses;
}
