import { describe, it, expect } from "vitest";
import {
  TERMINAL_STATUSES,
  VALID_PHASE_TRANSITIONS,
  GatewayError,
  QuoteUnavailableError,
  AuthenticationError,
  ServiceUnavailableError,
  DeadlineTooShortError,
  InsufficientGasError,
  SwapFailedError,
  SwapTimeoutError,
  // SDK re-exports — verify they're importable
  OneClickService,
  OpenAPI,
  QuoteRequest,
  GetExecutionStatusResponse,
} from "./types.js";
import type {
  SwapPhase,
  SwapState,
  OneClickStatus,
  PaymentRequirementsRecord,
  SettlementResponseRecord,
  CrossChainSettlementExtra,
  QuoteResponseRecord,
} from "./types.js";

// ─── SDK re-exports ──────────────────────────────────────────────────

describe("1CS SDK re-exports", () => {
  it("exposes OneClickService with expected static methods", () => {
    expect(typeof OneClickService.getQuote).toBe("function");
    expect(typeof OneClickService.getExecutionStatus).toBe("function");
    expect(typeof OneClickService.submitDepositTx).toBe("function");
    expect(typeof OneClickService.getTokens).toBe("function");
  });

  it("exposes OpenAPI config object", () => {
    expect(OpenAPI).toBeDefined();
    expect(typeof OpenAPI.BASE).toBe("string");
  });

  it("exposes QuoteRequest enums", () => {
    expect(QuoteRequest.swapType.EXACT_OUTPUT).toBe("EXACT_OUTPUT");
    expect(QuoteRequest.swapType.EXACT_INPUT).toBe("EXACT_INPUT");
    expect(QuoteRequest.depositType.ORIGIN_CHAIN).toBe("ORIGIN_CHAIN");
    expect(QuoteRequest.refundType.ORIGIN_CHAIN).toBe("ORIGIN_CHAIN");
    expect(QuoteRequest.recipientType.DESTINATION_CHAIN).toBe("DESTINATION_CHAIN");
  });

  it("exposes GetExecutionStatusResponse status enums", () => {
    expect(GetExecutionStatusResponse.status.SUCCESS).toBe("SUCCESS");
    expect(GetExecutionStatusResponse.status.FAILED).toBe("FAILED");
    expect(GetExecutionStatusResponse.status.REFUNDED).toBe("REFUNDED");
    expect(GetExecutionStatusResponse.status.PROCESSING).toBe("PROCESSING");
  });
});

// ─── Terminal statuses ───────────────────────────────────────────────

describe("TERMINAL_STATUSES", () => {
  it("contains exactly SUCCESS, FAILED, and REFUNDED", () => {
    expect(TERMINAL_STATUSES.has("SUCCESS")).toBe(true);
    expect(TERMINAL_STATUSES.has("FAILED")).toBe(true);
    expect(TERMINAL_STATUSES.has("REFUNDED")).toBe(true);
    expect(TERMINAL_STATUSES.size).toBe(3);
  });

  it("does not contain non-terminal statuses", () => {
    const nonTerminal: OneClickStatus[] = [
      "KNOWN_DEPOSIT_TX",
      "PENDING_DEPOSIT",
      "INCOMPLETE_DEPOSIT",
      "PROCESSING",
    ];
    for (const status of nonTerminal) {
      expect(TERMINAL_STATUSES.has(status)).toBe(false);
    }
  });
});

// ─── Phase transitions ──────────────────────────────────────────────

describe("VALID_PHASE_TRANSITIONS", () => {
  it("allows QUOTED → VERIFIED, EXPIRED, FAILED", () => {
    const transitions = VALID_PHASE_TRANSITIONS.get("QUOTED");
    expect(transitions).toBeDefined();
    expect(transitions!.has("VERIFIED")).toBe(true);
    expect(transitions!.has("EXPIRED")).toBe(true);
    expect(transitions!.has("FAILED")).toBe(true);
    expect(transitions!.has("SETTLED")).toBe(false);
  });

  it("does not allow transitions out of terminal phases", () => {
    const terminal: SwapPhase[] = ["SETTLED", "FAILED", "EXPIRED"];
    for (const phase of terminal) {
      const transitions = VALID_PHASE_TRANSITIONS.get(phase);
      expect(transitions).toBeDefined();
      expect(transitions!.size).toBe(0);
    }
  });

  it("defines transitions for every SwapPhase", () => {
    const allPhases: SwapPhase[] = [
      "QUOTED",
      "VERIFIED",
      "BROADCASTING",
      "BROADCAST",
      "POLLING",
      "SETTLED",
      "FAILED",
      "EXPIRED",
    ];
    for (const phase of allPhases) {
      expect(VALID_PHASE_TRANSITIONS.has(phase)).toBe(true);
    }
  });
});

// ─── Error classes ──────────────────────────────────────────────────

describe("Error classes", () => {
  it("GatewayError carries code, httpStatus, and name", () => {
    const err = new GatewayError("something broke", "TEST_CODE", 418);
    expect(err.message).toBe("something broke");
    expect(err.code).toBe("TEST_CODE");
    expect(err.httpStatus).toBe(418);
    expect(err.name).toBe("GatewayError");
    expect(err instanceof Error).toBe(true);
  });

  it("GatewayError defaults to httpStatus 500", () => {
    const err = new GatewayError("default", "X");
    expect(err.httpStatus).toBe(500);
  });

  it.each([
    { Cls: QuoteUnavailableError, code: "QUOTE_UNAVAILABLE", name: "QuoteUnavailableError", http: 503 },
    { Cls: AuthenticationError, code: "AUTHENTICATION_ERROR", name: "AuthenticationError", http: 503 },
    { Cls: ServiceUnavailableError, code: "SERVICE_UNAVAILABLE", name: "ServiceUnavailableError", http: 503 },
    { Cls: DeadlineTooShortError, code: "DEADLINE_TOO_SHORT", name: "DeadlineTooShortError", http: 503 },
    { Cls: InsufficientGasError, code: "INSUFFICIENT_GAS", name: "InsufficientGasError", http: 503 },
    { Cls: SwapTimeoutError, code: "SWAP_TIMEOUT", name: "SwapTimeoutError", http: 504 },
  ])("$name has code=$code, httpStatus=$http, and extends GatewayError", ({ Cls, code, name, http }) => {
    const err = new Cls("test");
    expect(err.code).toBe(code);
    expect(err.name).toBe(name);
    expect(err.httpStatus).toBe(http);
    expect(err instanceof GatewayError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });

  it("SwapFailedError carries swapStatus and optional refundInfo (502)", () => {
    const err = new SwapFailedError("swap failed", "REFUNDED", {
      buyerAddress: "0xbuyer",
      amount: "1000000",
      reason: "slippage exceeded",
    });
    expect(err.httpStatus).toBe(502);
    expect(err.code).toBe("SWAP_FAILED");
    expect(err.swapStatus).toBe("REFUNDED");
    expect(err.refundInfo?.buyerAddress).toBe("0xbuyer");
    expect(err instanceof GatewayError).toBe(true);
  });
});

// ─── Type shape checks ─────────────────────────────────────────────

describe("Type shape checks (compile-time + runtime sanity)", () => {
  it("SwapState can be constructed with minimal fields", () => {
    const state: SwapState = {
      depositAddress: "0xabc",
      quoteResponse: {
        correlationId: "corr-1",
        timestamp: new Date().toISOString(),
        signature: "sig",
        quoteRequest: {
          dry: false,
          swapType: "EXACT_OUTPUT",
          amount: "1000000",
        },
        quote: {
          depositAddress: "0xdeposit",
          amountIn: "1050000",
          amountInFormatted: "1.05",
          amountInUsd: "1.05",
          minAmountIn: "1000000",
          amountOut: "1000000",
          amountOutFormatted: "1.00",
          amountOutUsd: "1.00",
          minAmountOut: "990000",
          timeEstimate: 30,
        },
      },
      paymentRequirements: {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: "1050000",
        payTo: "0xdeposit",
        maxTimeoutSeconds: 570,
        extra: {
          name: "USDC",
          version: "2",
          assetTransferMethod: "eip3009",
        },
      },
      phase: "QUOTED",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    expect(state.phase).toBe("QUOTED");
    expect(state.paymentRequirements.scheme).toBe("exact");
  });

  it("SettlementResponseRecord.extra is optional", () => {
    const minimal: SettlementResponseRecord = {
      success: false,
      transaction: "",
      network: "eip155:8453",
      errorReason: "SWAP_FAILED",
      errorMessage: "1CS returned FAILED",
    };
    expect(minimal.extra).toBeUndefined();
  });

  it("CrossChainSettlementExtra carries full swap metadata", () => {
    const extra: CrossChainSettlementExtra = {
      settlementType: "crosschain-1cs",
      swapStatus: "SUCCESS",
      destinationChain: "near",
      destinationAmount: "10000000",
      destinationAsset: "nUSDC",
      correlationId: "corr-123",
      destinationTxHashes: [
        { hash: "abc123", explorerUrl: "https://nearblocks.io/txns/abc123" },
      ],
    };
    expect(extra.settlementType).toBe("crosschain-1cs");
    expect(extra.destinationTxHashes).toHaveLength(1);
  });
});
