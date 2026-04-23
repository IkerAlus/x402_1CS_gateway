/**
 * Tests for the protected-routes registry.
 *
 * Covers:
 *  - Registry contents: at least one route, well-formed, unique paths.
 *  - Validator: catches malformed paths, methods, pricing, handlers.
 *  - Factory (`buildProtectedRoutes`): binds runtime handlers and that the
 *    bound handler produces the shape declared in `outputSchema`.
 */

import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import {
  PROTECTED_ROUTES,
  buildProtectedRoutes,
  validateProtectedRoute,
  validateProtectedRoutes,
  type ProtectedRoute,
} from "./protected-routes.js";
import { mockGatewayConfig } from "../mocks/mock-config.js";

// ═══════════════════════════════════════════════════════════════════════
// Static registry shape
// ═══════════════════════════════════════════════════════════════════════

describe("PROTECTED_ROUTES registry", () => {
  it("is non-empty", () => {
    expect(PROTECTED_ROUTES.length).toBeGreaterThan(0);
  });

  it("has unique (method, path) tuples", () => {
    const seen = new Set<string>();
    for (const route of PROTECTED_ROUTES) {
      const key = `${route.method} ${route.path}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("every entry passes validation", () => {
    // The `handler` placeholder in the static list throws when called, but
    // validation only checks that it's a function — that's the point of
    // separating validation from handler execution.
    expect(() => validateProtectedRoutes(PROTECTED_ROUTES)).not.toThrow();
  });

  it("declares an input schema for each route (Bazaar invocability)", () => {
    // x402scan marks routes without an inputSchema as non-invocable.
    // This test is a hard gate on every new paid endpoint.
    for (const route of PROTECTED_ROUTES) {
      expect(route.inputSchema, `route ${route.path} missing inputSchema`).toBeDefined();
      expect(typeof route.inputSchema).toBe("object");
    }
  });

  it("declares an output schema for each route", () => {
    for (const route of PROTECTED_ROUTES) {
      expect(route.outputSchema, `route ${route.path} missing outputSchema`).toBeDefined();
      expect(typeof route.outputSchema).toBe("object");
    }
  });

  it("every pricing entry has currency USD", () => {
    // x402scan parses `currency` strictly; anything other than USD today
    // would surprise indexing. Tighten or relax per x402scan spec updates.
    for (const route of PROTECTED_ROUTES) {
      expect(route.pricing.currency).toBe("USD");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// validateProtectedRoute — error paths
// ═══════════════════════════════════════════════════════════════════════

describe("validateProtectedRoute", () => {
  function sampleRoute(overrides: Partial<ProtectedRoute> = {}): ProtectedRoute {
    return {
      path: "/api/ok",
      method: "GET",
      summary: "OK",
      pricing: { mode: "fixed", currency: "USD", amount: "0.01" },
      handler: (_req, _res, next) => next(),
      ...overrides,
    };
  }

  it("accepts a minimally valid route", () => {
    expect(() => validateProtectedRoute(sampleRoute())).not.toThrow();
  });

  it("rejects a path that does not start with /", () => {
    expect(() => validateProtectedRoute(sampleRoute({ path: "api/no-slash" as string })))
      .toThrow(/must be a string starting with "\/"/);
  });

  it("rejects an unsupported HTTP method", () => {
    expect(() =>
      validateProtectedRoute(sampleRoute({ method: "DELETE" as "GET" })),
    ).toThrow(/"GET" or "POST"/);
  });

  it("rejects an empty summary", () => {
    expect(() => validateProtectedRoute(sampleRoute({ summary: "" })))
      .toThrow(/summary must be a non-empty string/);
  });

  it("rejects a non-function handler", () => {
    expect(() =>
      validateProtectedRoute(sampleRoute({ handler: "not a function" as unknown as ProtectedRoute["handler"] })),
    ).toThrow(/handler must be a function/);
  });

  it("rejects fixed pricing with an empty amount", () => {
    expect(() =>
      validateProtectedRoute(
        sampleRoute({ pricing: { mode: "fixed", currency: "USD", amount: "" } }),
      ),
    ).toThrow(/pricing.amount must be a non-empty string for fixed mode/);
  });

  it("accepts dynamic pricing with min and max", () => {
    expect(() =>
      validateProtectedRoute(
        sampleRoute({ pricing: { mode: "dynamic", currency: "USD", min: "0.01", max: "1.00" } }),
      ),
    ).not.toThrow();
  });

  it("rejects dynamic pricing missing min", () => {
    expect(() =>
      validateProtectedRoute(
        sampleRoute({
          pricing: {
            mode: "dynamic",
            currency: "USD",
            max: "1.00",
          } as unknown as ProtectedRoute["pricing"],
        }),
      ),
    ).toThrow(/pricing.min must be a non-empty string for dynamic mode/);
  });

  it("rejects dynamic pricing missing max", () => {
    expect(() =>
      validateProtectedRoute(
        sampleRoute({
          pricing: {
            mode: "dynamic",
            currency: "USD",
            min: "0.01",
          } as unknown as ProtectedRoute["pricing"],
        }),
      ),
    ).toThrow(/pricing.max must be a non-empty string for dynamic mode/);
  });

  it("rejects an unknown pricing mode", () => {
    expect(() =>
      validateProtectedRoute(
        sampleRoute({
          pricing: { mode: "tip-jar", currency: "USD" } as unknown as ProtectedRoute["pricing"],
        }),
      ),
    ).toThrow(/pricing.mode must be "fixed" or "dynamic"/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// validateProtectedRoutes — list-level errors
// ═══════════════════════════════════════════════════════════════════════

describe("validateProtectedRoutes", () => {
  const ok = (): ProtectedRoute => ({
    path: "/api/ok",
    method: "GET",
    summary: "OK",
    pricing: { mode: "fixed", currency: "USD", amount: "0.01" },
    handler: (_req, _res, next) => next(),
  });

  it("rejects an empty registry", () => {
    expect(() => validateProtectedRoutes([])).toThrow(/empty/);
  });

  it("rejects duplicate (method, path) tuples", () => {
    const a = ok();
    const b: ProtectedRoute = { ...ok(), summary: "OK2" };
    expect(() => validateProtectedRoutes([a, b])).toThrow(/Duplicate route/);
  });

  it("allows same path with different methods", () => {
    expect(() =>
      validateProtectedRoutes([
        { ...ok(), method: "GET" },
        { ...ok(), method: "POST" },
      ]),
    ).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// buildProtectedRoutes — factory binds real handlers
// ═══════════════════════════════════════════════════════════════════════

describe("buildProtectedRoutes", () => {
  it("returns routes with executable handlers bound to cfg", async () => {
    const cfg = mockGatewayConfig();
    const routes = buildProtectedRoutes(cfg);
    expect(routes.length).toBe(PROTECTED_ROUTES.length);

    const premium = routes.find((r) => r.path === "/api/premium");
    expect(premium).toBeDefined();

    // Mount the handler as-is (skipping the x402 middleware) and verify it
    // emits the shape declared in outputSchema, with cfg values echoed.
    const app = express();
    app.get("/api/premium", premium!.handler);

    const res = await request(app).get("/api/premium");
    expect(res.status).toBe(200);
    expect(res.body.message).toContain("paid");
    expect(res.body.merchant).toBe(cfg.merchantRecipient);
    expect(res.body.amountReceived).toBe(cfg.merchantAmountOut);
    expect(res.body.destinationAsset).toBe(cfg.merchantAssetOut);
    expect(typeof res.body.timestamp).toBe("string");
  });

  it("validates the bound registry (throws on malformed handler substitution)", () => {
    // Sanity: buildProtectedRoutes runs validateProtectedRoutes at the end.
    // Can't easily corrupt PROTECTED_ROUTES from outside, so verify the
    // coupling indirectly: the factory never returns an invalid list when
    // given a valid cfg.
    const cfg = mockGatewayConfig();
    expect(() => buildProtectedRoutes(cfg)).not.toThrow();
  });
});
