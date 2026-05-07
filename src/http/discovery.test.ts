/**
 * Tests for the `/.well-known/x402` document builder.
 *
 * Verifies the static shape required by x402scan and the IETF `_x402` TXT
 * draft, plus the edge cases that come up when the operator has only
 * half-configured discovery (URL without proofs, proofs without URL,
 * malformed proofs).
 */

import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import { buildWellKnownDocument, WELL_KNOWN_INSTRUCTIONS } from "./discovery.js";
import { signOwnershipProof } from "./ownership-proof.js";
import type { ProtectedRoute } from "./protected-routes.js";
import { mockGatewayConfig } from "../mocks/mock-config.js";

// ═══════════════════════════════════════════════════════════════════════
// Test fixtures
// ═══════════════════════════════════════════════════════════════════════

function route(path: string, method: "GET" | "POST" = "GET"): ProtectedRoute {
  return {
    path,
    method,
    summary: `summary for ${path}`,
    pricing: { mode: "fixed", currency: "USD", amount: "0.01" },
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    handler: (_req, _res, next) => next(),
  };
}

const WALLET = new ethers.Wallet("0x" + "11".repeat(32));

async function realProof(url: string): Promise<string> {
  return signOwnershipProof(WALLET, url);
}

// ═══════════════════════════════════════════════════════════════════════
// Structural shape
// ═══════════════════════════════════════════════════════════════════════

describe("buildWellKnownDocument — shape", () => {
  it("emits version: 1 always", () => {
    const doc = buildWellKnownDocument(mockGatewayConfig(), [route("/a")]);
    expect(doc.version).toBe(1);
  });

  it("keys are exactly { version, resources, ownershipProofs, instructions }", () => {
    // Pinned so anyone adding / removing a top-level field has to update
    // this test deliberately — the x402scan DISCOVERY.md spec does not
    // recognise arbitrary extensions on this surface.
    const doc = buildWellKnownDocument(mockGatewayConfig(), [route("/a")]);
    expect(Object.keys(doc).sort()).toEqual([
      "instructions",
      "ownershipProofs",
      "resources",
      "version",
    ]);
  });

  it("is JSON-serialisable without loss", () => {
    const doc = buildWellKnownDocument(mockGatewayConfig(), [route("/a")]);
    const roundtripped = JSON.parse(JSON.stringify(doc));
    expect(roundtripped).toEqual(doc);
  });

  it("is deterministic given identical inputs", () => {
    const cfg = mockGatewayConfig();
    const d1 = buildWellKnownDocument(cfg, [route("/a"), route("/b")]);
    const d2 = buildWellKnownDocument(cfg, [route("/a"), route("/b")]);
    expect(d2).toEqual(d1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// resources[]
// ═══════════════════════════════════════════════════════════════════════

describe("buildWellKnownDocument — resources", () => {
  it("joins publicBaseUrl with each route path", () => {
    const cfg = mockGatewayConfig({ publicBaseUrl: "https://gateway.example.com" });
    const doc = buildWellKnownDocument(cfg, [route("/api/a"), route("/api/b")]);
    expect(doc.resources).toEqual([
      "https://gateway.example.com/api/a",
      "https://gateway.example.com/api/b",
    ]);
  });

  it("handles a publicBaseUrl with a trailing slash without doubling", () => {
    const cfg = mockGatewayConfig({ publicBaseUrl: "https://gateway.example.com/" });
    const doc = buildWellKnownDocument(cfg, [route("/api/a")]);
    expect(doc.resources).toEqual(["https://gateway.example.com/api/a"]);
  });

  it("preserves a publicBaseUrl that deploys under a subpath", () => {
    // The gateway might be deployed behind a reverse proxy at /x402.
    // Route paths must compose onto the subpath, not replace it.
    const cfg = mockGatewayConfig({ publicBaseUrl: "https://example.com/x402" });
    const doc = buildWellKnownDocument(cfg, [route("/api/a")]);
    expect(doc.resources).toEqual(["https://example.com/x402/api/a"]);
  });

  it("emits an empty resources array when publicBaseUrl is unset", () => {
    const cfg = mockGatewayConfig({ publicBaseUrl: undefined });
    const doc = buildWellKnownDocument(cfg, [route("/api/a")]);
    expect(doc.resources).toEqual([]);
  });

  it("emits one resource per route, in registry order", () => {
    const cfg = mockGatewayConfig({ publicBaseUrl: "https://g.example.com" });
    const doc = buildWellKnownDocument(cfg, [
      route("/r2"),
      route("/r1"),
      route("/r3"),
    ]);
    expect(doc.resources).toEqual([
      "https://g.example.com/r2",
      "https://g.example.com/r1",
      "https://g.example.com/r3",
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ownershipProofs[]
// ═══════════════════════════════════════════════════════════════════════

describe("buildWellKnownDocument — ownership proofs", () => {
  it("emits only structurally valid proofs", async () => {
    const url = "https://gateway.example.com";
    const good = await realProof(url);
    const bad = "not-a-proof";
    const cfg = mockGatewayConfig({
      publicBaseUrl: url,
      ownershipProofs: [good, bad],
    });
    const doc = buildWellKnownDocument(cfg, [route("/a")]);
    expect(doc.ownershipProofs).toContain(good);
    expect(doc.ownershipProofs).not.toContain(bad);
  });

  it("emits no proofs when publicBaseUrl is unset (even if configured)", () => {
    const cfg = mockGatewayConfig({
      publicBaseUrl: undefined,
      ownershipProofs: ["0x" + "a".repeat(130)],
    });
    const doc = buildWellKnownDocument(cfg, [route("/a")]);
    expect(doc.ownershipProofs).toEqual([]);
  });

  it("emits an empty array when ownershipProofs is empty", () => {
    const cfg = mockGatewayConfig({
      publicBaseUrl: "https://gateway.example.com",
      ownershipProofs: [],
    });
    const doc = buildWellKnownDocument(cfg, [route("/a")]);
    expect(doc.ownershipProofs).toEqual([]);
  });

  it("keeps multiple valid proofs from different signers", async () => {
    const url = "https://gateway.example.com";
    const w1 = new ethers.Wallet("0x" + "aa".repeat(32));
    const w2 = new ethers.Wallet("0x" + "bb".repeat(32));
    const [p1, p2] = await Promise.all([
      signOwnershipProof(w1, url),
      signOwnershipProof(w2, url),
    ]);
    const cfg = mockGatewayConfig({
      publicBaseUrl: url,
      ownershipProofs: [p1, p2],
    });
    const doc = buildWellKnownDocument(cfg, [route("/a")]);
    expect(doc.ownershipProofs).toEqual([p1, p2]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Empty routes
// ═══════════════════════════════════════════════════════════════════════

describe("buildWellKnownDocument — empty routes (defensive)", () => {
  it("returns a valid document with zero routes", () => {
    const cfg = mockGatewayConfig({ publicBaseUrl: "https://gateway.example.com" });
    const doc = buildWellKnownDocument(cfg, []);
    expect(doc.version).toBe(1);
    expect(doc.resources).toEqual([]);
    // Note: production startup refuses an empty registry; this case
    // exists so the builder itself is still defensible if anyone calls
    // it with an empty list during tests.
  });
});

// ═══════════════════════════════════════════════════════════════════════
// instructions field (optional-per-spec "legacy guidance")
// ═══════════════════════════════════════════════════════════════════════

describe("buildWellKnownDocument — instructions", () => {
  it("is always present and matches the exported WELL_KNOWN_INSTRUCTIONS constant", () => {
    const doc = buildWellKnownDocument(mockGatewayConfig(), [route("/a")]);
    expect(typeof doc.instructions).toBe("string");
    expect(doc.instructions.length).toBeGreaterThan(0);
    expect(doc.instructions).toBe(WELL_KNOWN_INSTRUCTIONS);
  });

  it("points crawlers at the richer /openapi.json surface", () => {
    // The whole point of the field is to nudge crawlers that land on
    // /.well-known/x402 alone (e.g. via DNS _x402) toward the richer
    // OpenAPI doc rather than stopping at the minimal fan-out list.
    const doc = buildWellKnownDocument(mockGatewayConfig(), [route("/a")]);
    expect(doc.instructions).toContain("/openapi.json");
    expect(doc.instructions).toContain("PAYMENT-REQUIRED");
  });

  it("is identical whether publicBaseUrl is set or not", () => {
    // The string is static (not templated with the base URL) so the
    // same text ships regardless of deployment — crawlers in either
    // posture get the same guidance.
    const withUrl = buildWellKnownDocument(
      mockGatewayConfig({ publicBaseUrl: "https://gateway.example.com" }),
      [route("/a")],
    );
    const withoutUrl = buildWellKnownDocument(
      mockGatewayConfig({ publicBaseUrl: undefined }),
      [route("/a")],
    );
    expect(withUrl.instructions).toBe(withoutUrl.instructions);
  });
});
