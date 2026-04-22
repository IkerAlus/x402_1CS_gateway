/**
 * x402-1CS Gateway — public library surface.
 *
 * Pure barrel file: re-exports every named symbol consumers need. No
 * runtime side effects — importing this module will NOT load config,
 * open network connections, or exit the process.
 *
 * The runnable HTTP gateway lives in `src/server.ts` and is started via
 * `npx env-cmd npx tsx src/server.ts` (see `README.md` § "Start the
 * gateway"). Library consumers import types and helpers from here and
 * wire up their own runtime.
 */

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
