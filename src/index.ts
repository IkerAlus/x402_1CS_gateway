/**
 * x402-1CS Gateway — entry point.
 *
 * Loads configuration from environment variables, validates it, and
 * will eventually start the Express server with x402 middleware.
 *
 * For now (Phase 0) this simply validates config and confirms the
 * gateway is ready to proceed to Phase 1.
 */

import { loadConfigFromEnv } from "./config.js";

// ── Configuration ───────────────────────────────────────────────────
export { GatewayConfigSchema, loadConfigFromEnv } from "./config.js";
export type { GatewayConfig } from "./config.js";

// ── Types ───────────────────────────────────────────────────────────
export * from "./types.js";

// ── State Store ─────────────────────────────────────────────────────
export {
  SqliteStateStore,
  InMemoryStateStore,
  createStateStore,
  validatePhaseTransition,
  StateNotFoundError,
  InvalidPhaseTransitionError,
} from "./store.js";
export type { SqliteStoreOptions, CreateStoreOptions } from "./store.js";

// ── Quote Engine ────────────────────────────────────────────────────
export {
  buildPaymentRequirements,
  defaultQuoteFn,
  configureOneClickSdk,
  buildQuoteDeadline,
  buildQuoteRequest,
  validateDeadline,
  mapToPaymentRequirements,
  computeMaxTimeoutSeconds,
  toQuoteResponseRecord,
} from "./quote-engine.js";
export type { BuildPaymentRequirementsResult, QuoteFn } from "./quote-engine.js";

// ── Verifier ────────────────────────────────────────────────────────
export {
  verifyPayment,
  extractChainId,
  validateRequirementsMatch,
  createChainReader,
} from "./verifier.js";
export type { VerifyResult, ChainReader, VerifierOptions } from "./verifier.js";

// ── Settler ─────────────────────────────────────────────────────────
export {
  settlePayment,
  pollUntilTerminal,
  buildSettlementResponse,
  extractDestinationChain,
  createBroadcastFn,
  createDepositNotifyFn,
  createStatusPollFn,
} from "./settler.js";
export type {
  BroadcastFn,
  BroadcastResult,
  DepositNotifyFn,
  DepositNotifyResult,
  StatusPollFn,
  StatusPollResult,
  GasOptions,
  SettlerOptions,
} from "./settler.js";

// ── Middleware ──────────────────────────────────────────────────────
export { createX402Middleware, createGatewayApp } from "./middleware.js";
export type { MiddlewareDeps } from "./middleware.js";

// ── Provider Pool ──────────────────────────────────────────────────
export { ProviderPool } from "./provider-pool.js";
export type { ProviderPoolOptions } from "./provider-pool.js";

function main() {
  try {
    const config = loadConfigFromEnv();
    // eslint-disable-next-line no-console
    console.log(
      `[x402-1CS] Config loaded — network=${config.originNetwork}, ` +
        `merchant=${config.merchantRecipient}, asset=${config.merchantAssetOut}`,
    );
  } catch (err) {
    console.error("[x402-1CS] Invalid configuration:", err);
    process.exit(1);
  }
}

main();
