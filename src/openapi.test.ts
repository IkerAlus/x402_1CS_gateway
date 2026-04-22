/**
 * Tests for the `/openapi.json` document builder.
 *
 * Verifies x402scan-required fields: top-level `openapi`, `info.title`,
 * `info.version`, `x-discovery.ownershipProofs`; per-operation `security`,
 * `x-payment-info`, `402` response; and the `components.securitySchemes.x402`
 * definition referenced by every paid operation.
 */

import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import { buildOpenApiDocument, type OpenApiInfo } from "./openapi.js";
import { signOwnershipProof } from "./ownership-proof.js";
import type { ProtectedRoute } from "./protected-routes.js";
import { mockGatewayConfig } from "./mocks/mock-config.js";

// ═══════════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════════

function info(overrides: Partial<OpenApiInfo> = {}): OpenApiInfo {
  return {
    title: "x402-1cs-gateway",
    version: "0.1.0",
    description: "test description",
    ...overrides,
  };
}

function route(overrides: Partial<ProtectedRoute> = {}): ProtectedRoute {
  return {
    path: "/api/premium",
    method: "GET",
    summary: "Demo paid resource",
    description: "Returns a small JSON payload after settlement.",
    pricing: { mode: "fixed", currency: "USD", amount: "0.05" },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
    handler: (_req, _res, next) => next(),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Top-level shape
// ═══════════════════════════════════════════════════════════════════════

describe("buildOpenApiDocument — top-level shape", () => {
  it("advertises OpenAPI 3.1.0", () => {
    const doc = buildOpenApiDocument(info(), mockGatewayConfig(), [route()]);
    expect(doc.openapi).toBe("3.1.0");
  });

  it("emits info.title, info.version, info.description", () => {
    const doc = buildOpenApiDocument(
      info({ title: "my-gw", version: "9.9.9", description: "desc" }),
      mockGatewayConfig(),
      [route()],
    );
    expect(doc.info).toEqual({
      title: "my-gw",
      version: "9.9.9",
      description: "desc",
    });
  });

  it("omits info.description when the input description is absent", () => {
    const doc = buildOpenApiDocument(
      { title: "t", version: "v" },
      mockGatewayConfig(),
      [route()],
    );
    expect(doc.info).toEqual({ title: "t", version: "v" });
  });

  it("emits servers[] when publicBaseUrl is set", () => {
    const doc = buildOpenApiDocument(
      info(),
      mockGatewayConfig({ publicBaseUrl: "https://gateway.example.com" }),
      [route()],
    );
    expect(doc.servers).toEqual([
      { url: "https://gateway.example.com", description: "Gateway public endpoint" },
    ]);
  });

  it("omits servers[] entirely when publicBaseUrl is unset", () => {
    const doc = buildOpenApiDocument(
      info(),
      mockGatewayConfig({ publicBaseUrl: undefined }),
      [route()],
    );
    expect(doc).not.toHaveProperty("servers");
  });

  it("is JSON-serialisable", () => {
    const doc = buildOpenApiDocument(info(), mockGatewayConfig(), [route()]);
    const roundtripped = JSON.parse(JSON.stringify(doc));
    expect(roundtripped).toEqual(doc);
  });

  it("emits top-level keys in the OpenAPI-canonical reading order (paths before components)", () => {
    // Insertion order is preserved by JS objects + JSON.stringify, so the
    // wire output respects this order. Keeps `info` near the top and the
    // bulky `components` / `schemas` blob at the bottom — matches the
    // spec's own example files and avoids a ~80-line schema dominating
    // the first screenful of the pretty-printed JSON.
    const doc = buildOpenApiDocument(
      info(),
      mockGatewayConfig({ publicBaseUrl: "https://gateway.example.com" }),
      [route()],
    );
    expect(Object.keys(doc)).toEqual([
      "openapi",
      "info",
      "servers",
      "x-discovery",
      "x-crosschain",
      "paths",
      "components",
    ]);
  });

  it("is deterministic given identical inputs", () => {
    const cfg = mockGatewayConfig();
    const d1 = buildOpenApiDocument(info(), cfg, [route()]);
    const d2 = buildOpenApiDocument(info(), cfg, [route()]);
    expect(d2).toEqual(d1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// x-discovery.ownershipProofs
// ═══════════════════════════════════════════════════════════════════════

describe("buildOpenApiDocument — x-discovery.ownershipProofs", () => {
  const WALLET = new ethers.Wallet("0x" + "22".repeat(32));

  it("mirrors the valid proofs from config", async () => {
    const url = "https://gateway.example.com";
    const proof = await signOwnershipProof(WALLET, url);
    const doc = buildOpenApiDocument(
      info(),
      mockGatewayConfig({
        publicBaseUrl: url,
        ownershipProofs: [proof],
      }),
      [route()],
    );
    expect(doc["x-discovery"]).toEqual({ ownershipProofs: [proof] });
  });

  it("drops malformed proofs silently", async () => {
    const url = "https://gateway.example.com";
    const good = await signOwnershipProof(WALLET, url);
    const doc = buildOpenApiDocument(
      info(),
      mockGatewayConfig({
        publicBaseUrl: url,
        ownershipProofs: [good, "garbage"],
      }),
      [route()],
    );
    expect((doc["x-discovery"] as { ownershipProofs: string[] }).ownershipProofs)
      .toEqual([good]);
  });

  it("emits an empty proofs array when publicBaseUrl is unset", () => {
    const doc = buildOpenApiDocument(
      info(),
      mockGatewayConfig({
        publicBaseUrl: undefined,
        ownershipProofs: ["0x" + "a".repeat(130)],
      }),
      [route()],
    );
    expect(doc["x-discovery"]).toEqual({ ownershipProofs: [] });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Security schemes
// ═══════════════════════════════════════════════════════════════════════

describe("buildOpenApiDocument — components.securitySchemes.x402", () => {
  it("defines an x402 security scheme of type http", () => {
    const doc = buildOpenApiDocument(info(), mockGatewayConfig(), [route()]);
    const schemes = (doc.components as { securitySchemes: Record<string, unknown> }).securitySchemes;
    expect(schemes).toHaveProperty("x402");
    expect(schemes.x402).toMatchObject({ type: "http", scheme: "x402" });
  });

  it("every operation references x402 via security: [{ x402: [] }]", () => {
    const doc = buildOpenApiDocument(info(), mockGatewayConfig(), [
      route({ path: "/a" }),
      route({ path: "/b", method: "POST" }),
    ]);
    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;
    expect(paths["/a"]!.get!.security).toEqual([{ x402: [] }]);
    expect(paths["/b"]!.post!.security).toEqual([{ x402: [] }]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Per-operation content
// ═══════════════════════════════════════════════════════════════════════

describe("buildOpenApiDocument — operations", () => {
  it("lowercases method keys on path items", () => {
    const doc = buildOpenApiDocument(info(), mockGatewayConfig(), [
      route({ path: "/api/a", method: "GET" }),
      route({ path: "/api/b", method: "POST" }),
    ]);
    const paths = doc.paths as Record<string, Record<string, unknown>>;
    expect(Object.keys(paths["/api/a"]!)).toContain("get");
    expect(Object.keys(paths["/api/a"]!)).not.toContain("GET");
    expect(Object.keys(paths["/api/b"]!)).toContain("post");
  });

  it("allows multiple methods on the same path", () => {
    const doc = buildOpenApiDocument(info(), mockGatewayConfig(), [
      route({ path: "/api/shared", method: "GET" }),
      route({ path: "/api/shared", method: "POST" }),
    ]);
    const paths = doc.paths as Record<string, Record<string, unknown>>;
    expect(Object.keys(paths["/api/shared"]!).sort()).toEqual(["get", "post"]);
  });

  it("includes summary and description from the route entry", () => {
    const doc = buildOpenApiDocument(info(), mockGatewayConfig(), [
      route({ summary: "The Premium", description: "Hello." }),
    ]);
    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;
    const op = paths["/api/premium"]!.get!;
    expect(op.summary).toBe("The Premium");
    expect(op.description).toBe("Hello.");
  });

  it("omits description when the route has none", () => {
    const doc = buildOpenApiDocument(info(), mockGatewayConfig(), [
      route({ description: undefined }),
    ]);
    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;
    const op = paths["/api/premium"]!.get!;
    expect(op).not.toHaveProperty("description");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// x-payment-info
// ═══════════════════════════════════════════════════════════════════════

describe("buildOpenApiDocument — x-payment-info", () => {
  it("emits fixed pricing verbatim", () => {
    const doc = buildOpenApiDocument(info(), mockGatewayConfig(), [
      route({ pricing: { mode: "fixed", currency: "USD", amount: "0.05" } }),
    ]);
    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;
    expect(paths["/api/premium"]!.get!["x-payment-info"]).toEqual({
      protocols: "x402",
      mode: "fixed",
      currency: "USD",
      amount: "0.05",
    });
  });

  it("emits dynamic pricing with min and max", () => {
    const doc = buildOpenApiDocument(info(), mockGatewayConfig(), [
      route({ pricing: { mode: "dynamic", currency: "USD", min: "0.01", max: "1.00" } }),
    ]);
    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;
    expect(paths["/api/premium"]!.get!["x-payment-info"]).toEqual({
      protocols: "x402",
      mode: "dynamic",
      currency: "USD",
      min: "0.01",
      max: "1.00",
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Responses
// ═══════════════════════════════════════════════════════════════════════

describe("buildOpenApiDocument — responses", () => {
  it("declares a 200 response with the route's outputSchema", () => {
    const schema = {
      type: "object",
      properties: { foo: { type: "string" } },
      required: ["foo"],
    };
    const doc = buildOpenApiDocument(info(), mockGatewayConfig(), [
      route({ outputSchema: schema }),
    ]);
    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;
    const responses = paths["/api/premium"]!.get!.responses as Record<string, unknown>;
    expect(responses["200"]).toMatchObject({
      description: expect.any(String) as unknown,
      content: { "application/json": { schema } },
    });
  });

  it("omits 200 content when outputSchema is absent", () => {
    const doc = buildOpenApiDocument(info(), mockGatewayConfig(), [
      route({ outputSchema: undefined }),
    ]);
    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;
    const r200 = (paths["/api/premium"]!.get!.responses as Record<string, unknown>)["200"] as Record<string, unknown>;
    expect(r200).toHaveProperty("description");
    expect(r200).not.toHaveProperty("content");
  });

  it("declares a 402 response documenting the PAYMENT-REQUIRED header", () => {
    const doc = buildOpenApiDocument(info(), mockGatewayConfig(), [route()]);
    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;
    const r402 = (paths["/api/premium"]!.get!.responses as Record<string, unknown>)["402"] as Record<string, unknown>;
    expect(r402).toHaveProperty("description");
    const headers = r402.headers as Record<string, unknown>;
    expect(headers).toHaveProperty("PAYMENT-REQUIRED");
    expect((headers["PAYMENT-REQUIRED"] as { schema: unknown }).schema).toEqual({ type: "string" });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Request body
// ═══════════════════════════════════════════════════════════════════════

describe("buildOpenApiDocument — request bodies", () => {
  it("attaches a JSON requestBody for POST routes with an inputSchema", () => {
    const schema = { type: "object", properties: { q: { type: "string" } } };
    const doc = buildOpenApiDocument(info(), mockGatewayConfig(), [
      route({ method: "POST", path: "/api/query", inputSchema: schema }),
    ]);
    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;
    const op = paths["/api/query"]!.post!;
    expect(op.requestBody).toEqual({
      required: true,
      content: { "application/json": { schema } },
    });
  });

  it("does NOT attach requestBody for GET routes even with an inputSchema", () => {
    // GETs with schemas: the schema still appears via Bazaar on the 402
    // challenge (Phase 5), but OpenAPI's requestBody is inappropriate
    // for GET and we don't want to emit noise.
    const doc = buildOpenApiDocument(info(), mockGatewayConfig(), [
      route({ method: "GET", inputSchema: { type: "object" } }),
    ]);
    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;
    expect(paths["/api/premium"]!.get!).not.toHaveProperty("requestBody");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// x402scan-required fields (assertion pass)
// ═══════════════════════════════════════════════════════════════════════

describe("buildOpenApiDocument — x402scan required fields", () => {
  it("every required top-level field is present", async () => {
    const url = "https://gateway.example.com";
    const wallet = new ethers.Wallet("0x" + "33".repeat(32));
    const proof = await signOwnershipProof(wallet, url);

    const doc = buildOpenApiDocument(
      info({ title: "my-gw", version: "1.0.0" }),
      mockGatewayConfig({
        publicBaseUrl: url,
        ownershipProofs: [proof],
      }),
      [route({ path: "/api/premium" })],
    );

    // Top-level
    expect(doc.openapi).toBeDefined();
    expect((doc.info as Record<string, unknown>).title).toBeDefined();
    expect((doc.info as Record<string, unknown>).version).toBeDefined();
    expect(doc.paths).toBeDefined();
    expect(doc["x-discovery"]).toBeDefined();
    expect((doc["x-discovery"] as { ownershipProofs: string[] }).ownershipProofs).toContain(proof);

    // Per-operation
    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;
    const op = paths["/api/premium"]!.get!;
    expect(op.security).toEqual([{ x402: [] }]);
    expect(op["x-payment-info"]).toBeDefined();
    expect((op.responses as Record<string, unknown>)["402"]).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// x-crosschain + components.schemas.CrossChainQuoteExtra
//
// The gateway carries informational 1CS metadata on every 402 envelope
// under `accepts[0].extra.crossChain`. The OpenAPI document advertises
// the shape so indexers / integrators can discover it without parsing a
// live 402.
// ═══════════════════════════════════════════════════════════════════════

describe("buildOpenApiDocument — x-crosschain + CrossChainQuoteExtra schema", () => {
  it("emits top-level `x-crosschain` pointing at the schema", () => {
    const doc = buildOpenApiDocument(info(), mockGatewayConfig(), [route()]);
    const xcc = doc["x-crosschain"] as Record<string, unknown>;
    expect(xcc).toBeDefined();
    expect(xcc.protocol).toBe("1cs");
    expect(xcc.schema).toBe("#/components/schemas/CrossChainQuoteExtra");
  });

  it("publishes the CrossChainQuoteExtra JSON schema under components.schemas", () => {
    const doc = buildOpenApiDocument(info(), mockGatewayConfig(), [route()]);
    const schemas = (doc.components as { schemas?: Record<string, unknown> }).schemas;
    expect(schemas).toBeDefined();
    const schema = schemas!.CrossChainQuoteExtra as Record<string, unknown>;
    expect(schema).toBeDefined();
    expect(schema.type).toBe("object");

    // Required fields listed
    const required = schema.required as string[];
    expect(required).toEqual(
      expect.arrayContaining([
        "protocol",
        "quoteId",
        "destinationRecipient",
        "destinationAsset",
        "amountOut",
        "amountOutFormatted",
        "amountOutUsd",
        "amountInUsd",
        "refundTo",
      ]),
    );

    // Optional fields declared as properties but not in `required`
    const props = schema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("refundFee");
    expect(props).toHaveProperty("depositMemo");
    expect(required).not.toContain("refundFee");
    expect(required).not.toContain("depositMemo");

    // protocol is pinned to the single literal "1cs"
    expect((props.protocol as { enum: string[] }).enum).toEqual(["1cs"]);
  });

  it("per-operation 402 response description mentions extra.crossChain + the schema ref", () => {
    const doc = buildOpenApiDocument(info(), mockGatewayConfig(), [
      route({ path: "/api/a" }),
      route({ path: "/api/b", method: "POST" }),
    ]);
    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>;

    for (const [path, method] of [["/api/a", "get"], ["/api/b", "post"]] as const) {
      const op = paths[path]![method]!;
      const r402 = (op.responses as Record<string, unknown>)["402"] as Record<string, unknown>;
      const desc = r402.description as string;
      expect(desc).toContain("extra.crossChain");
      expect(desc).toContain("CrossChainQuoteExtra");
    }
  });
});
