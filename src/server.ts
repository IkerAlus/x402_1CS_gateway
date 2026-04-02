/**
 * x402-1CS Gateway — HTTP server entry point.
 *
 * Wires together all gateway components and starts an Express server.
 * This is the file you run for a live deployment:
 *
 *   npx tsx src/server.ts
 *
 * Configuration is read from environment variables (see .env.example).
 */

import express from "express";
import { loadConfigFromEnv } from "./config.js";
import { createStateStore } from "./store.js";
import { ProviderPool } from "./provider-pool.js";
import { createChainReader } from "./verifier.js";
import {
  createBroadcastFn,
  createDepositNotifyFn,
  createStatusPollFn,
} from "./settler.js";
import { createX402Middleware } from "./middleware.js";
import type { MiddlewareDeps } from "./middleware.js";
import { createRateLimiting, destroyRateLimiting } from "./rate-limiter.js";

async function main(): Promise<void> {
  // ── 1. Load and validate config ────────────────────────────────────
  console.log("[x402-1CS] Loading configuration...");
  const cfg = loadConfigFromEnv();
  console.log(
    `[x402-1CS] Config OK — network=${cfg.originNetwork}, ` +
      `merchant=${cfg.merchantRecipient}, asset=${cfg.merchantAssetOut}`,
  );

  // ── 2. Initialize state store ──────────────────────────────────────
  const store = await createStateStore({ backend: "sqlite" });
  console.log("[x402-1CS] State store initialized (SQLite in-memory)");

  // ── 3. Set up provider pool ────────────────────────────────────────
  const providerPool = new ProviderPool(cfg.originRpcUrls);
  console.log(
    `[x402-1CS] Provider pool ready — ${providerPool.size} RPC endpoint(s)`,
  );

  // ── 4. Create the facilitator wallet ───────────────────────────────
  const wallet = providerPool.getWallet(cfg.facilitatorPrivateKey);
  console.log(`[x402-1CS] Facilitator wallet: ${wallet.address}`);

  // Sanity check: can we reach the RPC?
  try {
    const balance = await wallet.provider!.getBalance(wallet.address);
    const balanceEth = Number(balance) / 1e18;
    console.log(
      `[x402-1CS] Facilitator gas balance: ${balanceEth.toFixed(6)} ETH`,
    );
    if (balance === 0n) {
      console.warn(
        "[x402-1CS] ⚠️  WARNING: Facilitator wallet has ZERO gas balance. " +
          "Transactions will fail. Fund this address before testing.",
      );
    }
  } catch (err) {
    console.error(
      "[x402-1CS] ⚠️  WARNING: Could not reach RPC to check balance:",
      err instanceof Error ? err.message : err,
    );
  }

  // ── 5. Wire up injectable dependencies ─────────────────────────────
  const chainReader = createChainReader(providerPool.getProvider());
  const broadcastFn = createBroadcastFn(wallet);
  const depositNotifyFn = createDepositNotifyFn();
  const statusPollFn = createStatusPollFn();

  // ── 5b. Rate limiting & abuse prevention ────────────────────────────
  const rateLimiting = createRateLimiting(cfg, store);
  console.log(
    `[x402-1CS] Rate limiting — ${cfg.rateLimitQuotesPerWindow} quotes/${cfg.rateLimitWindowMs}ms per IP, ` +
      `${cfg.maxConcurrentSettlements} max concurrent settlements`,
  );
  if (cfg.quoteGcIntervalMs > 0) {
    console.log(
      `[x402-1CS] Quote GC — sweep every ${cfg.quoteGcIntervalMs}ms, grace period ${cfg.quoteGcGracePeriodMs}ms`,
    );
  }

  const deps: MiddlewareDeps = {
    cfg,
    store,
    chainReader,
    broadcastFn,
    depositNotifyFn,
    statusPollFn,
    resourceDescription: "x402-1CS protected resource",
    quoteLimiter: rateLimiting.quoteLimiter,
    settlementLimiter: rateLimiting.settlementLimiter,
  };

  // ── 6. Create Express app ──────────────────────────────────────────
  const app = express();
  app.use(express.json());

  // Health check (no payment required)
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      network: cfg.originNetwork,
      facilitator: wallet.address,
      rpcEndpoints: providerPool.size,
      healthyProviders: providerPool.healthyCount,
      settlements: {
        inFlight: rateLimiting.settlementLimiter.current,
        capacity: rateLimiting.settlementLimiter.capacity,
      },
      rateLimiter: {
        trackedIPs: rateLimiting.quoteLimiter.size,
        quotesPerWindow: cfg.rateLimitQuotesPerWindow,
        windowMs: cfg.rateLimitWindowMs,
      },
    });
  });

  // Protected route — requires x402 payment
  app.get("/api/premium", createX402Middleware(deps), (_req, res) => {
    res.json({
      message: "You've paid! Here is your premium content.",
      timestamp: new Date().toISOString(),
      merchant: cfg.merchantRecipient,
      amountReceived: cfg.merchantAmountOut,
      destinationAsset: cfg.merchantAssetOut,
    });
  });

  // ── 7. Start server ────────────────────────────────────────────────
  const port = parseInt(process.env.PORT ?? "3402", 10);
  app.listen(port, () => {
    console.log("");
    console.log("═══════════════════════════════════════════════════════");
    console.log(`  x402-1CS Gateway running on http://localhost:${port}`);
    console.log("");
    console.log("  Endpoints:");
    console.log(`    GET /health       — health check (no payment)`);
    console.log(`    GET /api/premium  — x402 protected resource`);
    console.log("");
    console.log("  To test the 402 flow:");
    console.log(`    curl -i http://localhost:${port}/api/premium`);
    console.log("═══════════════════════════════════════════════════════");
    console.log("");
  });

  // ── Graceful shutdown ──────────────────────────────────────────────
  const shutdown = () => {
    console.log("\n[x402-1CS] Shutting down...");
    destroyRateLimiting(rateLimiting);
    providerPool.destroy();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[x402-1CS] Fatal error:", err);
  process.exit(1);
});
