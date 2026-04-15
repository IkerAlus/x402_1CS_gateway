import { describe, it, expect } from "vitest";
import { GatewayConfigSchema, loadConfigFromEnv } from "./config.js";

/** Minimal valid env that satisfies every required field. */
function validEnv(): Record<string, string> {
  return {
    ONE_CLICK_JWT: "test-jwt-token",
    MERCHANT_RECIPIENT: "merchant.near",
    MERCHANT_ASSET_OUT: "near:nUSDC",
    MERCHANT_AMOUNT_OUT: "1000000",
    ORIGIN_NETWORK: "eip155:8453",
    ORIGIN_ASSET_IN: "nep141:base-0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    ORIGIN_TOKEN_ADDRESS: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    ORIGIN_RPC_URLS: "https://mainnet.base.org,https://base.drpc.org",
    FACILITATOR_PRIVATE_KEY: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    GATEWAY_REFUND_ADDRESS: "0x1234567890abcdef1234567890abcdef12345678",
  };
}

describe("GatewayConfigSchema", () => {
  it("accepts a fully valid configuration", () => {
    const result = GatewayConfigSchema.safeParse({
      oneClickJwt: "jwt",
      merchantRecipient: "merchant.near",
      merchantAssetOut: "near:nUSDC",
      merchantAmountOut: "1000000",
      originNetwork: "eip155:8453",
      originAssetIn: "nep141:base-0xabc",
      originTokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      originRpcUrls: ["https://mainnet.base.org"],
      facilitatorPrivateKey: "0xabc",
      gatewayRefundAddress: "0x1234567890abcdef1234567890abcdef12345678",
    });
    expect(result.success).toBe(true);
  });

  it("applies defaults for optional fields", () => {
    const result = GatewayConfigSchema.parse({
      oneClickJwt: "jwt",
      merchantRecipient: "merchant.near",
      merchantAssetOut: "near:nUSDC",
      merchantAmountOut: "1000000",
      originNetwork: "eip155:42161",
      originAssetIn: "nep141:arb-0xabc",
      originTokenAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      originRpcUrls: ["https://arb1.arbitrum.io/rpc"],
      facilitatorPrivateKey: "0xkey",
      gatewayRefundAddress: "0x1234567890abcdef1234567890abcdef12345678",
    });
    expect(result.oneClickBaseUrl).toBe("https://1click.chaindefuser.com");
    expect(result.maxPollTimeMs).toBe(300_000);
    expect(result.pollIntervalBaseMs).toBe(2_000);
    expect(result.pollIntervalMaxMs).toBe(30_000);
    expect(result.quoteExpiryBufferSec).toBe(30);
    expect(result.tokenName).toBe("USD Coin");
    expect(result.tokenVersion).toBe("2");
    expect(result.tokenSupportsEip3009).toBe(true);
  });

  it("rejects invalid CAIP-2 network identifier", () => {
    const result = GatewayConfigSchema.safeParse({
      oneClickJwt: "jwt",
      merchantRecipient: "merchant.near",
      merchantAssetOut: "near:nUSDC",
      merchantAmountOut: "1000000",
      originNetwork: "base-mainnet", // invalid — not CAIP-2
      originAssetIn: "nep141:base-0xabc",
      originTokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      originRpcUrls: ["https://mainnet.base.org"],
      facilitatorPrivateKey: "0xkey",
      gatewayRefundAddress: "0x1234567890abcdef1234567890abcdef12345678",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid EVM token address", () => {
    const result = GatewayConfigSchema.safeParse({
      oneClickJwt: "jwt",
      merchantRecipient: "merchant.near",
      merchantAssetOut: "near:nUSDC",
      merchantAmountOut: "1000000",
      originNetwork: "eip155:8453",
      originAssetIn: "nep141:base-0xabc",
      originTokenAddress: "not-an-address",
      originRpcUrls: ["https://mainnet.base.org"],
      facilitatorPrivateKey: "0xkey",
      gatewayRefundAddress: "0x1234567890abcdef1234567890abcdef12345678",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty RPC URLs array", () => {
    const result = GatewayConfigSchema.safeParse({
      oneClickJwt: "jwt",
      merchantRecipient: "merchant.near",
      merchantAssetOut: "near:nUSDC",
      merchantAmountOut: "1000000",
      originNetwork: "eip155:8453",
      originAssetIn: "nep141:base-0xabc",
      originTokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      originRpcUrls: [],
      facilitatorPrivateKey: "0xkey",
      gatewayRefundAddress: "0x1234567890abcdef1234567890abcdef12345678",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing required fields", () => {
    const result = GatewayConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("loadConfigFromEnv", () => {
  it("parses a complete set of environment variables", () => {
    const env = validEnv();
    const config = loadConfigFromEnv(env as unknown as NodeJS.ProcessEnv);
    expect(config.oneClickJwt).toBe("test-jwt-token");
    expect(config.originNetwork).toBe("eip155:8453");
    expect(config.originRpcUrls).toEqual(["https://mainnet.base.org", "https://base.drpc.org"]);
    expect(config.merchantAmountOut).toBe("1000000");
  });

  it("coerces numeric env vars from strings", () => {
    const env = {
      ...validEnv(),
      MAX_POLL_TIME_MS: "120000",
      POLL_INTERVAL_BASE_MS: "5000",
      POLL_INTERVAL_MAX_MS: "60000",
      QUOTE_EXPIRY_BUFFER_SEC: "60",
    };
    const config = loadConfigFromEnv(env as unknown as NodeJS.ProcessEnv);
    expect(config.maxPollTimeMs).toBe(120_000);
    expect(config.pollIntervalBaseMs).toBe(5_000);
    expect(config.pollIntervalMaxMs).toBe(60_000);
    expect(config.quoteExpiryBufferSec).toBe(60);
  });

  it("coerces boolean TOKEN_SUPPORTS_EIP3009 from string", () => {
    const envTrue = { ...validEnv(), TOKEN_SUPPORTS_EIP3009: "true" };
    expect(loadConfigFromEnv(envTrue as unknown as NodeJS.ProcessEnv).tokenSupportsEip3009).toBe(
      true,
    );

    const envFalse = { ...validEnv(), TOKEN_SUPPORTS_EIP3009: "false" };
    expect(loadConfigFromEnv(envFalse as unknown as NodeJS.ProcessEnv).tokenSupportsEip3009).toBe(
      false,
    );
  });

  it("throws on missing required env vars", () => {
    expect(() => loadConfigFromEnv({} as NodeJS.ProcessEnv)).toThrow();
  });

  it("parses ALLOWED_ORIGINS comma-separated list, trimming whitespace", () => {
    const env = {
      ...validEnv(),
      ALLOWED_ORIGINS: "https://a.example, https://b.example ,https://c.example",
    };
    const config = loadConfigFromEnv(env as unknown as NodeJS.ProcessEnv);
    expect(config.allowedOrigins).toEqual([
      "https://a.example",
      "https://b.example",
      "https://c.example",
    ]);
  });

  it("leaves allowedOrigins undefined when ALLOWED_ORIGINS is unset or empty", () => {
    const unset = loadConfigFromEnv(validEnv() as unknown as NodeJS.ProcessEnv);
    expect(unset.allowedOrigins).toBeUndefined();

    const empty = loadConfigFromEnv({
      ...validEnv(),
      ALLOWED_ORIGINS: "",
    } as unknown as NodeJS.ProcessEnv);
    expect(empty.allowedOrigins).toBeUndefined();

    const whitespaceOnly = loadConfigFromEnv({
      ...validEnv(),
      ALLOWED_ORIGINS: " , ,",
    } as unknown as NodeJS.ProcessEnv);
    expect(whitespaceOnly.allowedOrigins).toBeUndefined();
  });
});
