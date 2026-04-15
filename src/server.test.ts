/**
 * Tests for the CORS + helmet wiring exposed by `src/server.ts`.
 *
 * We don't spin up the full `main()` entry point (which reads env vars, opens
 * RPC connections, etc.) — instead we replicate the middleware chain using the
 * same `buildCorsOptions()` helper that production uses, so the exact options
 * exercised in tests are the ones shipped.
 */

import { describe, it, expect } from "vitest";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import request from "supertest";
import { buildCorsOptions } from "./cors-options.js";
import type { GatewayConfig } from "./config.js";

/** Minimal app mirroring `server.ts` middleware chain. */
function buildApp(cfg: Pick<GatewayConfig, "allowedOrigins">): express.Express {
  const app = express();
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(cors(buildCorsOptions(cfg)));
  app.use(express.json({ limit: "1mb" }));
  app.get("/api/premium", (_req, res) => res.status(200).json({ ok: true }));
  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));
  return app;
}

describe("CORS + helmet wiring", () => {
  it("exposes PAYMENT-REQUIRED and PAYMENT-RESPONSE headers on preflight", async () => {
    const app = buildApp({ allowedOrigins: undefined });
    const res = await request(app)
      .options("/api/premium")
      .set("Origin", "https://buyer.example.com")
      .set("Access-Control-Request-Method", "GET")
      .set("Access-Control-Request-Headers", "PAYMENT-SIGNATURE, Content-Type");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://buyer.example.com");
    // Exposed headers must be listed (case-insensitive string compare).
    const exposed = (res.headers["access-control-expose-headers"] ?? "").toLowerCase();
    expect(exposed).toContain("payment-required");
    expect(exposed).toContain("payment-response");
    // Allowed request headers must include PAYMENT-SIGNATURE.
    const allowed = (res.headers["access-control-allow-headers"] ?? "").toLowerCase();
    expect(allowed).toContain("payment-signature");
  });

  it("reflects the request origin and sets helmet security headers on regular requests", async () => {
    const app = buildApp({ allowedOrigins: undefined });
    const res = await request(app)
      .get("/api/premium")
      .set("Origin", "https://anywhere.example");

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://anywhere.example");
    // Helmet default: X-Content-Type-Options: nosniff
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("withholds CORS allow-origin for origins not on the allowlist", async () => {
    const app = buildApp({ allowedOrigins: ["https://good.example"] });

    const goodRes = await request(app)
      .get("/api/premium")
      .set("Origin", "https://good.example");
    expect(goodRes.headers["access-control-allow-origin"]).toBe("https://good.example");

    const badRes = await request(app)
      .get("/api/premium")
      .set("Origin", "https://bad.example");
    // cors package default: header simply omitted (request still succeeds;
    // browser enforces the same-origin policy on the client side).
    expect(badRes.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
