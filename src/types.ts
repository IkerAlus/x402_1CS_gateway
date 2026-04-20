/**
 * Type definitions for the x402-1CS gateway.
 *
 * This module bridges the x402 payment protocol with the NEAR Intents
 * 1Click Swap (1CS) API, defining the internal swap lifecycle and the
 * shapes of data that flow between the two systems.
 *
 * **1CS types** are re-exported directly from
 * `@defuse-protocol/one-click-sdk-typescript` so that consumers use the
 * canonical definitions. Gateway-internal types (SwapState, error classes,
 * etc.) live here.
 */

// ═══════════════════════════════════════════════════════════════════════
// Re-export x402 SDK types used throughout the gateway
// ═══════════════════════════════════════════════════════════════════════

export type {
  PaymentRequirements,
  PaymentPayload,
  SettleResponse,
  VerifyResponse,
  Network,
} from "@x402/core/types";

export type {
  AssetTransferMethod,
  ExactEIP3009Payload,
  ExactPermit2Payload,
} from "@x402/evm";

// ═══════════════════════════════════════════════════════════════════════
// Re-export 1Click Swap SDK types
//
// These are the canonical types from the 1CS TypeScript SDK. We re-export
// them so that the rest of the gateway codebase imports from one place.
// The SDK uses namespace-scoped enums (e.g. QuoteRequest.swapType); see
// the SDK docs for the full shape of each type.
//
// @see https://github.com/defuse-protocol/one-click-sdk-typescript
// ═══════════════════════════════════════════════════════════════════════

export {
  /** Service class with static methods for all 1CS API endpoints. */
  OneClickService,
  /** Global API configuration (BASE url, TOKEN, etc.). */
  OpenAPI,
  /** Error class thrown by the SDK on non-2xx responses. */
  ApiError as OneClickApiError,
  /** Enum-bearing namespace for QuoteRequest field enums. */
  QuoteRequest,
  /** Enum-bearing namespace for GetExecutionStatusResponse.status. */
  GetExecutionStatusResponse,
  /** Enum-bearing namespace for SubmitDepositTxResponse.status. */
  SubmitDepositTxResponse,
} from "@defuse-protocol/one-click-sdk-typescript";

export type {
  /** Full quote response from `POST /v0/quote`. */
  QuoteResponse,
  /** Core pricing fields nested inside QuoteResponse. */
  Quote,
  /** Request body for `POST /v0/deposit/submit`. */
  SubmitDepositTxRequest,
  /** Detailed swap execution info from status endpoint. */
  SwapDetails,
  /** Tx hash + explorer URL pair. */
  TransactionDetails,
  /** Token metadata from `GET /v0/tokens`. */
  TokenResponse,
  /** Application fee entry. */
  AppFee,
} from "@defuse-protocol/one-click-sdk-typescript";

// ═══════════════════════════════════════════════════════════════════════
// Convenience aliases for the 1CS status enum
//
// The SDK defines status values inside namespace-scoped enums
// (GetExecutionStatusResponse.status.SUCCESS, etc.). These aliases
// provide ergonomic string-union types for use in switch statements
// and type narrowing throughout the gateway.
// ═══════════════════════════════════════════════════════════════════════

/**
 * All possible 1CS execution status values (terminal + non-terminal).
 * Mirrors `GetExecutionStatusResponse.status` as a plain union.
 */
export type OneClickStatus =
  | "KNOWN_DEPOSIT_TX"
  | "PENDING_DEPOSIT"
  | "INCOMPLETE_DEPOSIT"
  | "PROCESSING"
  | "SUCCESS"
  | "FAILED"
  | "REFUNDED";

// ═══════════════════════════════════════════════════════════════════════
// Internal swap lifecycle
// ═══════════════════════════════════════════════════════════════════════

/**
 * Phases of the gateway-managed swap lifecycle.
 *
 * ```
 * QUOTED ──► VERIFIED ──► BROADCASTING ──► BROADCAST ──► POLLING ──► SETTLED
 *   │            │              │               │            │
 *   └── EXPIRED  └── FAILED    └── FAILED      └── FAILED   └── FAILED
 * ```
 */
export type SwapPhase =
  | "QUOTED" // 1CS quote obtained, 402 response returned to buyer
  | "VERIFIED" // Buyer's payment signature verified against stored requirements
  | "BROADCASTING" // On-chain tx submitted to origin chain
  | "BROADCAST" // On-chain tx confirmed on origin chain
  | "POLLING" // Waiting for 1CS to reach a terminal status
  | "SETTLED" // 1CS reports SUCCESS — 200 returned to buyer
  | "FAILED" // 1CS reports FAILED/REFUNDED, or an internal error occurred
  | "EXPIRED"; // Quote deadline elapsed before the buyer signed

/**
 * Mutable state tracked per swap, keyed by the 1CS deposit address.
 *
 * Persisted in the {@link StateStore} (Phase 1) so that in-flight swaps
 * survive gateway restarts.
 */
export interface SwapState {
  /** 1CS deposit address — also the primary key in the store. */
  depositAddress: string;

  /**
   * Full 1CS quote response (contains pricing, deadline, correlation ID).
   * Stored as a plain record for serialization; structurally identical to
   * the SDK's `QuoteResponse`.
   */
  quoteResponse: QuoteResponseRecord;

  /**
   * The x402 `PaymentRequirements` object that was returned to the buyer
   * in the initial 402 response. Used during verification to ensure the
   * buyer signed against the correct terms.
   */
  paymentRequirements: PaymentRequirementsRecord;

  /** The buyer's signed payment payload (populated after VERIFIED phase). */
  paymentPayload?: PaymentPayloadRecord;

  /** The EVM address that signed the payment (recovered during verification). */
  signerAddress?: string;

  /** Transaction hash of the on-chain transfer (populated after BROADCAST). */
  originTxHash?: string;

  /** Latest status string from the 1CS status endpoint. */
  oneClickStatus?: OneClickStatus;

  /** Current lifecycle phase. */
  phase: SwapPhase;

  /** Unix epoch ms — when this state was first created. */
  createdAt: number;
  /** Unix epoch ms — last time any field was updated. */
  updatedAt: number;
  /** Unix epoch ms — when the swap reached a terminal state. */
  settledAt?: number;

  /** Final settlement details (populated after SETTLED or FAILED). */
  settlementResponse?: SettlementResponseRecord;

  /** Human-readable error description when phase = FAILED. */
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// Serialization-safe record types
//
// These mirror the @x402/core and 1CS SDK types but as plain interfaces
// so the state store can (de)serialize without importing SDK schemas.
// ═══════════════════════════════════════════════════════════════════════

/**
 * JSON-serializable snapshot of a 1CS QuoteResponse.
 * Structurally compatible with the SDK's `QuoteResponse` type.
 */
export interface QuoteResponseRecord {
  correlationId: string;
  timestamp: string;
  signature: string;
  quoteRequest: Record<string, unknown>;
  quote: QuoteRecord;
}

/**
 * JSON-serializable snapshot of the core 1CS Quote fields.
 * Structurally compatible with the SDK's `Quote` type.
 *
 * **EXACT_OUTPUT semantics:** For `swapType: EXACT_OUTPUT` (our use case),
 * the 1CS docs describe the response as having `minAmountIn` and `maxAmountIn`.
 * However, the SDK type names the upper bound field `amountIn` (not `maxAmountIn`).
 *
 * - `amountIn` = upper bound (maxAmountIn) — buyer must authorize at least this
 * - `minAmountIn` = lower bound — minimum deposit that won't be refunded
 *
 * The gateway uses `amountIn` as the x402 `PaymentRequirements.amount` so the
 * buyer's signed authorization covers the worst-case price.
 *
 * @see https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote
 */
export interface QuoteRecord {
  depositAddress?: string;
  depositMemo?: string;
  /** Upper bound of input amount (= `maxAmountIn` per 1CS docs). Used as x402 payment amount. */
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  /** Lower bound — deposits below this are refunded by deadline. */
  minAmountIn: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  deadline?: string;
  timeWhenInactive?: string;
  timeEstimate: number;
  refundFee?: string;
}

/**
 * JSON-serializable representation of x402 PaymentRequirements.
 * Mirrors the @x402/core type for persistence.
 */
export interface PaymentRequirementsRecord {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  /** The 1CS deposit address — this is `payTo` in x402 terms. */
  payTo: string;
  maxTimeoutSeconds: number;
  /**
   * Extra fields for the `exact` EVM scheme. Includes:
   * - `name` — EIP-712 token name
   * - `version` — EIP-712 token version
   * - `assetTransferMethod` — `"eip3009"` | `"permit2"`
   */
  extra: Record<string, unknown>;
}

/**
 * JSON-serializable representation of the buyer's x402 PaymentPayload.
 */
export interface PaymentPayloadRecord {
  x402Version: number;
  resource?: { url: string; description?: string; mimeType?: string };
  accepted: PaymentRequirementsRecord;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

/**
 * JSON-serializable settlement response returned in the `PAYMENT-RESPONSE` header.
 *
 * Extends the standard x402 `SettleResponse` with an `extra` field carrying
 * cross-chain settlement metadata from the 1CS swap.
 *
 * @see Research plan §6 — Settlement response
 */
export interface SettlementResponseRecord {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: string;
  transaction: string;
  network: string;
  amount?: string;
  /**
   * Cross-chain settlement metadata. Populated when the 1CS swap completes.
   *
   * @example
   * ```json
   * {
   *   "settlementType": "crosschain-1cs",
   *   "destinationTxHash": "0x...",
   *   "destinationChain": "near",
   *   "destinationAmount": "10000000",
   *   "destinationAsset": "nUSDC",
   *   "swapStatus": "SUCCESS"
   * }
   * ```
   */
  extra?: CrossChainSettlementExtra;
}

/**
 * Cross-chain settlement details included in the `extra` field of
 * the `PAYMENT-RESPONSE` header when a 1CS swap completes.
 */
export interface CrossChainSettlementExtra {
  settlementType: "crosschain-1cs";
  /** Transaction hash(es) on the destination chain, from 1CS swapDetails. */
  destinationTxHashes?: Array<{ hash: string; explorerUrl: string }>;
  destinationChain?: string;
  destinationAmount?: string;
  destinationAsset?: string;
  swapStatus: OneClickStatus;
  /** 1CS correlation ID for debugging / explorer lookup. */
  correlationId?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// Gateway-specific result types
// ═══════════════════════════════════════════════════════════════════════

/**
 * Returned by the settler after attempting to complete a swap.
 */
export type SettlementResult =
  | { success: true; response: SettlementResponseRecord }
  | { success: false; error: string; refundInfo?: RefundInfo };

/**
 * Information needed to route a refund back to the original buyer.
 */
export interface RefundInfo {
  /** EVM address of the buyer (recovered from their payment signature). */
  buyerAddress: string;
  /** Amount in the origin asset's smallest unit. */
  amount: string;
  /** 1CS refund reason, if available. */
  reason?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// Error types
//
// Each error carries an `httpStatus` so the middleware can map it to the
// correct HTTP response code without a separate lookup table.
//
// @see Research plan §8 — Error handling and edge cases
// ═══════════════════════════════════════════════════════════════════════

/** Base class for all gateway-specific errors. */
export class GatewayError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    /** HTTP status code the middleware should return for this error. */
    public readonly httpStatus: number = 500,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

/** 1CS returned an error for the quote request (400 → gateway returns 503). */
export class QuoteUnavailableError extends GatewayError {
  constructor(message: string) {
    super(message, "QUOTE_UNAVAILABLE", 503);
    this.name = "QuoteUnavailableError";
  }
}

/** 1CS rejected authentication (401 → gateway returns 503). */
export class AuthenticationError extends GatewayError {
  constructor(message: string) {
    super(message, "AUTHENTICATION_ERROR", 503);
    this.name = "AuthenticationError";
  }
}

/** 1CS is unreachable or returned 5xx (→ gateway returns 503). */
export class ServiceUnavailableError extends GatewayError {
  constructor(message: string) {
    super(message, "SERVICE_UNAVAILABLE", 503);
    this.name = "ServiceUnavailableError";
  }
}

/** The 1CS quote deadline is too short to safely complete the flow (→ 503). */
export class DeadlineTooShortError extends GatewayError {
  constructor(message: string) {
    super(message, "DEADLINE_TOO_SHORT", 503);
    this.name = "DeadlineTooShortError";
  }
}

/** Facilitator wallet doesn't have enough native token to pay gas (→ 503). */
export class InsufficientGasError extends GatewayError {
  constructor(message: string) {
    super(message, "INSUFFICIENT_GAS", 503);
    this.name = "InsufficientGasError";
  }
}

/**
 * 1CS swap reached a terminal failure state (FAILED/REFUNDED).
 * The middleware returns 502 Bad Gateway with a PAYMENT-RESPONSE header.
 *
 * @see Research plan §8 — Swap failure / refund
 */
export class SwapFailedError extends GatewayError {
  constructor(
    message: string,
    public readonly swapStatus: OneClickStatus,
    public readonly refundInfo?: RefundInfo,
  ) {
    super(message, "SWAP_FAILED", 502);
    this.name = "SwapFailedError";
  }
}

/**
 * Polling 1CS `/v0/status` exceeded the configured maximum time.
 * The middleware returns 504 Gateway Timeout.
 *
 * @see Research plan §8 — Timeout
 */
export class SwapTimeoutError extends GatewayError {
  constructor(message: string) {
    super(message, "SWAP_TIMEOUT", 504);
    this.name = "SwapTimeoutError";
  }
}

// ═══════════════════════════════════════════════════════════════════════
// State store interface (implemented in Phase 1)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Persistence layer for swap states.
 *
 * Implementations must be safe for concurrent access within a single
 * Node.js process (no multi-process locking required for v1).
 */
export interface StateStore {
  /** Persist a new swap state. Idempotent — re-quoting the same deposit address overwrites. */
  create(depositAddress: string, state: SwapState): Promise<void>;
  /** Retrieve a swap state by deposit address, or null if not found. */
  get(depositAddress: string): Promise<SwapState | null>;
  /**
   * Apply a partial update. Implementations should validate that the phase
   * transition is legal before writing (optimistic locking).
   */
  update(depositAddress: string, patch: Partial<SwapState>): Promise<void>;
  /** List deposit addresses whose `createdAt` is older than the given threshold. */
  listExpired(olderThanMs: number): Promise<string[]>;
  /** List all swap states currently in a given phase. */
  listByPhase(phase: SwapPhase): Promise<SwapState[]>;
  /** Delete a swap state by deposit address. */
  delete(depositAddress: string): Promise<void>;
  /** Gracefully close the store, flushing pending writes and releasing resources. */
  close(): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════

/** Set of 1CS statuses that indicate the swap has reached a terminal state. */
export const TERMINAL_STATUSES: ReadonlySet<OneClickStatus> = new Set([
  "SUCCESS",
  "FAILED",
  "REFUNDED",
]);

/** Allowed phase transitions — used by the state store for optimistic locking. */
export const VALID_PHASE_TRANSITIONS: ReadonlyMap<SwapPhase, ReadonlySet<SwapPhase>> = new Map([
  ["QUOTED", new Set(["VERIFIED", "EXPIRED", "FAILED"])],
  ["VERIFIED", new Set(["BROADCASTING", "FAILED"])],
  ["BROADCASTING", new Set(["BROADCAST", "FAILED"])],
  ["BROADCAST", new Set(["POLLING", "FAILED"])],
  ["POLLING", new Set(["SETTLED", "FAILED"])],
  // Terminal states — no transitions out.
  ["SETTLED", new Set()],
  ["FAILED", new Set()],
  ["EXPIRED", new Set()],
]);
