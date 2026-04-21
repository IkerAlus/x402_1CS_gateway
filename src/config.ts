import { z } from "zod";
import { diagnoseQuoteRequest } from "./quote-engine.js";

/**
 * Gateway configuration schema.
 *
 * Validated at startup — if any required variable is missing or malformed
 * the process exits immediately with a descriptive error.
 */
export const GatewayConfigSchema = z.object({
  // ── 1Click Swap API ────────────────────────────────────────────────
  /** JWT bearer token for authenticating with the 1CS API. */
  oneClickJwt: z.string().min(1, "ONE_CLICK_JWT is required"),
  /** Base URL of the 1CS service. */
  oneClickBaseUrl: z.string().url().default("https://1click.chaindefuser.com"),

  // ── Merchant ───────────────────────────────────────────────────────
  /** Recipient address/account on the destination chain (e.g. "merchant.near"). */
  merchantRecipient: z.string().min(1, "MERCHANT_RECIPIENT is required"),
  /** 1CS asset ID for the asset the merchant wants to receive (e.g. "near:nUSDC"). */
  merchantAssetOut: z.string().min(1, "MERCHANT_ASSET_OUT is required"),
  /** Price denominated in the destination asset's smallest unit. */
  merchantAmountOut: z.string().min(1, "MERCHANT_AMOUNT_OUT is required"),

  // ── Origin chain (where the buyer pays) ────────────────────────────
  /** CAIP-2 network identifier, e.g. "eip155:8453" for Base. */
  originNetwork: z.string().regex(/^eip155:\d+$/, "ORIGIN_NETWORK must be CAIP-2 (eip155:<chainId>)"),
  /** 1CS asset ID on the origin chain (used in the quote request). */
  originAssetIn: z.string().min(1, "ORIGIN_ASSET_IN is required"),
  /** ERC-20 contract address of the payment token on the origin chain. */
  originTokenAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "ORIGIN_TOKEN_ADDRESS must be a valid EVM address"),
  /** One or more JSON-RPC endpoints for the origin chain (first = primary). */
  originRpcUrls: z.array(z.string().url()).min(1, "At least one RPC URL is required"),

  // ── Gateway operations ─────────────────────────────────────────────
  /** Private key of the facilitator wallet that broadcasts on-chain txs. */
  facilitatorPrivateKey: z.string().min(1, "FACILITATOR_PRIVATE_KEY is required"),
  /** EVM address that 1CS sends refunds to when swaps fail. */
  gatewayRefundAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "GATEWAY_REFUND_ADDRESS must be a valid EVM address"),

  // ── Tuning ─────────────────────────────────────────────────────────
  /** Maximum wall-clock time (ms) spent polling 1CS for a terminal status. */
  maxPollTimeMs: z.number().int().positive().default(300_000),
  /** Initial polling interval (ms) — grows via exponential backoff. */
  pollIntervalBaseMs: z.number().int().positive().default(2_000),
  /** Ceiling for the exponential-backoff polling interval (ms). */
  pollIntervalMaxMs: z.number().int().positive().default(30_000),
  /** Reject a 1CS quote if fewer than this many seconds remain before its deadline. */
  quoteExpiryBufferSec: z.number().int().nonnegative().default(30),

  // ── Rate limiting & abuse prevention ────────────────────────────────
  /** Maximum quote (402) requests per IP within the rate-limit window. */
  rateLimitQuotesPerWindow: z.number().int().positive().default(20),
  /** Rate-limit sliding window duration in milliseconds. */
  rateLimitWindowMs: z.number().int().positive().default(60_000),
  /** Maximum number of concurrent in-flight settlements (BROADCASTING → POLLING). */
  maxConcurrentSettlements: z.number().int().positive().default(10),
  /** How often (ms) the background job prunes expired QUOTED states. 0 = disabled. */
  quoteGcIntervalMs: z.number().int().nonnegative().default(60_000),
  /** Max age (ms) past a quote's deadline before it's garbage-collected. */
  quoteGcGracePeriodMs: z.number().int().nonnegative().default(300_000),

  // ── Token metadata (populates x402 PaymentRequirements.extra) ──────
  /** EIP-712 domain `name` of the payment token (must match on-chain). */
  tokenName: z.string().default("USD Coin"),
  /** EIP-712 domain `version` of the payment token (must match on-chain). */
  tokenVersion: z.string().default("2"),
  /** Whether the token supports EIP-3009 `transferWithAuthorization`. */
  tokenSupportsEip3009: z.boolean().default(true),

  // ── CORS ───────────────────────────────────────────────────────────
  /**
   * Optional allowlist of origins permitted to call the gateway.
   * Undefined means "reflect any origin" (equivalent to `*` but works with credentials).
   * Required when a browser-based x402 client needs to read `PAYMENT-REQUIRED` / `PAYMENT-RESPONSE`.
   */
  allowedOrigins: z.array(z.string().min(1)).optional(),
});

/** Validated gateway configuration object. */
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

/**
 * Parse environment variables into a validated {@link GatewayConfig}.
 *
 * Comma-separated `ORIGIN_RPC_URLS` are split into an array; boolean and
 * numeric env vars are coerced from their string representations.
 *
 * @throws {z.ZodError} if validation fails — caller should log and exit.
 */
export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const raw = {
    oneClickJwt: env.ONE_CLICK_JWT,
    oneClickBaseUrl: env.ONE_CLICK_BASE_URL ?? undefined,
    merchantRecipient: env.MERCHANT_RECIPIENT,
    merchantAssetOut: env.MERCHANT_ASSET_OUT,
    merchantAmountOut: env.MERCHANT_AMOUNT_OUT,
    originNetwork: env.ORIGIN_NETWORK,
    originAssetIn: env.ORIGIN_ASSET_IN,
    originTokenAddress: env.ORIGIN_TOKEN_ADDRESS,
    originRpcUrls: env.ORIGIN_RPC_URLS?.split(",").map((u) => u.trim()) ?? [],
    facilitatorPrivateKey: env.FACILITATOR_PRIVATE_KEY,
    gatewayRefundAddress: env.GATEWAY_REFUND_ADDRESS,
    maxPollTimeMs: env.MAX_POLL_TIME_MS ? Number(env.MAX_POLL_TIME_MS) : undefined,
    pollIntervalBaseMs: env.POLL_INTERVAL_BASE_MS ? Number(env.POLL_INTERVAL_BASE_MS) : undefined,
    pollIntervalMaxMs: env.POLL_INTERVAL_MAX_MS ? Number(env.POLL_INTERVAL_MAX_MS) : undefined,
    quoteExpiryBufferSec: env.QUOTE_EXPIRY_BUFFER_SEC
      ? Number(env.QUOTE_EXPIRY_BUFFER_SEC)
      : undefined,
    rateLimitQuotesPerWindow: env.RATE_LIMIT_QUOTES_PER_WINDOW
      ? Number(env.RATE_LIMIT_QUOTES_PER_WINDOW)
      : undefined,
    rateLimitWindowMs: env.RATE_LIMIT_WINDOW_MS
      ? Number(env.RATE_LIMIT_WINDOW_MS)
      : undefined,
    maxConcurrentSettlements: env.MAX_CONCURRENT_SETTLEMENTS
      ? Number(env.MAX_CONCURRENT_SETTLEMENTS)
      : undefined,
    quoteGcIntervalMs: env.QUOTE_GC_INTERVAL_MS
      ? Number(env.QUOTE_GC_INTERVAL_MS)
      : undefined,
    quoteGcGracePeriodMs: env.QUOTE_GC_GRACE_PERIOD_MS
      ? Number(env.QUOTE_GC_GRACE_PERIOD_MS)
      : undefined,
    tokenName: env.TOKEN_NAME ?? undefined,
    tokenVersion: env.TOKEN_VERSION ?? undefined,
    tokenSupportsEip3009: env.TOKEN_SUPPORTS_EIP3009
      ? env.TOKEN_SUPPORTS_EIP3009.toLowerCase() === "true"
      : undefined,
    allowedOrigins: parseAllowedOrigins(env.ALLOWED_ORIGINS),
  };

  const config = GatewayConfigSchema.parse(raw);

  // ── Cross-validate recipient format vs destination chain ──────────
  validateRecipientFormat(config);

  return config;
}

/**
 * Parse the `ALLOWED_ORIGINS` env var into a trimmed, non-empty list of origins.
 * Returns undefined when the variable is missing or yields no origins, which the
 * CORS middleware interprets as "reflect any origin".
 */
function parseAllowedOrigins(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const origins = raw.split(",").map((o) => o.trim()).filter(Boolean);
  return origins.length > 0 ? origins : undefined;
}

/**
 * Warn at startup if the merchant config contains any of the common
 * operator mistakes detected by {@link diagnoseQuoteRequest}:
 *   - whitespace or `#` in any string field (leading-space / inline-comment
 *     bugs in `.env`)
 *   - recipient format that doesn't match the destination chain (EVM, NEAR,
 *     or other non-EVM like Stellar / Solana / Bitcoin)
 *   - unknown chain prefix in `MERCHANT_ASSET_OUT`
 *
 * These are warnings, not errors, because 1CS may support shapes we don't
 * recognize yet. The same diagnoser runs again at runtime (in
 * `requestQuote`'s catch block) and surfaces as `err.context.hints` in
 * server logs, so operators see the same diagnosis whenever it fires.
 */
function validateRecipientFormat(cfg: GatewayConfig): void {
  const hints = diagnoseQuoteRequest({
    originAsset: cfg.originAssetIn,
    destinationAsset: cfg.merchantAssetOut,
    recipient: cfg.merchantRecipient,
    amount: cfg.merchantAmountOut,
    refundTo: cfg.gatewayRefundAddress,
  });

  for (const hint of hints) {
    console.warn(`[x402] ⚠️  Config check: ${hint}`);
  }
}
