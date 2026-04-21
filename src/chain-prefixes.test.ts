/**
 * Tests for the shared NEP-141 chain-prefix module.
 *
 * These helpers are the gate for recipient-format validation at startup
 * (`config.validateRecipientFormat` → `diagnoseQuoteRequest`) and runtime
 * (the same diagnoser runs on every 1CS rejection). The diagnoser has
 * its own behavioural tests in `quote-engine.test.ts`; this file covers
 * the primitive helpers directly so regressions land at a clear file.
 */

import { describe, it, expect } from "vitest";
import {
  EVM_CHAIN_PREFIXES,
  NON_EVM_CHAIN_PREFIXES,
  extractChainPrefix,
  isValidNearAccount,
  isNearNativeAsset,
} from "./chain-prefixes.js";

// ═══════════════════════════════════════════════════════════════════════
// Chain-prefix lists
// ═══════════════════════════════════════════════════════════════════════

describe("EVM_CHAIN_PREFIXES / NON_EVM_CHAIN_PREFIXES", () => {
  it("EVM prefixes list is non-empty and lowercase", () => {
    expect(EVM_CHAIN_PREFIXES.length).toBeGreaterThan(0);
    for (const prefix of EVM_CHAIN_PREFIXES) {
      expect(prefix).toBe(prefix.toLowerCase());
    }
  });

  it("non-EVM prefixes list is non-empty and lowercase", () => {
    expect(NON_EVM_CHAIN_PREFIXES.length).toBeGreaterThan(0);
    for (const prefix of NON_EVM_CHAIN_PREFIXES) {
      expect(prefix).toBe(prefix.toLowerCase());
    }
  });

  it("EVM and non-EVM lists are disjoint", () => {
    const evm = new Set(EVM_CHAIN_PREFIXES);
    for (const prefix of NON_EVM_CHAIN_PREFIXES) {
      expect(evm.has(prefix), `"${prefix}" is in both lists`).toBe(false);
    }
  });

  it("contains the expected canonical chain prefixes", () => {
    // Spot-check the chains users most commonly configure.
    expect(EVM_CHAIN_PREFIXES).toContain("eth");
    expect(EVM_CHAIN_PREFIXES).toContain("base");
    expect(EVM_CHAIN_PREFIXES).toContain("arb");
    expect(EVM_CHAIN_PREFIXES).toContain("polygon");
    expect(NON_EVM_CHAIN_PREFIXES).toContain("solana");
    expect(NON_EVM_CHAIN_PREFIXES).toContain("stellar");
    expect(NON_EVM_CHAIN_PREFIXES).toContain("bitcoin");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// extractChainPrefix
// ═══════════════════════════════════════════════════════════════════════

describe("extractChainPrefix", () => {
  it("extracts the prefix from an OMFT-bridged EVM asset", () => {
    expect(
      extractChainPrefix("nep141:base-0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913.omft.near"),
    ).toBe("base");
    expect(
      extractChainPrefix("nep141:arb-0xaf88d065e77c8cC2239327C5EDb3A432268e5831.omft.near"),
    ).toBe("arb");
    expect(
      extractChainPrefix("nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near"),
    ).toBe("eth");
  });

  it("extracts the prefix from an OMFT-bridged non-EVM asset", () => {
    expect(
      extractChainPrefix("nep141:stellar-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN.omft.near"),
    ).toBe("stellar");
    expect(
      extractChainPrefix("nep141:solana-7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs.omft.near"),
    ).toBe("solana");
    expect(
      extractChainPrefix("nep141:bitcoin-somebtcaddress.omft.near"),
    ).toBe("bitcoin");
  });

  it("returns null for NEAR-native named tokens", () => {
    // These have hyphens in the contract name but do NOT end in .omft.near.
    expect(extractChainPrefix("nep141:usdt.tether-token.near")).toBeNull();
    expect(extractChainPrefix("nep141:wrap.near")).toBeNull();
    expect(extractChainPrefix("nep141:usn.near")).toBeNull();
  });

  it("returns null for NEAR implicit account addresses", () => {
    expect(
      extractChainPrefix("nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"),
    ).toBeNull();
  });

  it("accepts asset IDs without the nep141: prefix", () => {
    expect(
      extractChainPrefix("base-0x833589f.omft.near"),
    ).toBe("base");
  });

  it("returns null for obviously malformed input", () => {
    expect(extractChainPrefix("")).toBeNull();
    expect(extractChainPrefix("nep141:")).toBeNull();
    expect(extractChainPrefix("not-an-asset")).toBeNull();
    // No hyphen separator at all:
    expect(extractChainPrefix("nep141:foo.near")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// isValidNearAccount
// ═══════════════════════════════════════════════════════════════════════

describe("isValidNearAccount", () => {
  it("accepts valid named .near accounts", () => {
    expect(isValidNearAccount("merchant.near")).toBe(true);
    expect(isValidNearAccount("merchantx402.near")).toBe(true);
    expect(isValidNearAccount("alice.near")).toBe(true);
    expect(isValidNearAccount("sub.alice.near")).toBe(true);
    expect(isValidNearAccount("a-b-c.near")).toBe(true);
    expect(isValidNearAccount("acc_with_underscore.near")).toBe(true);
  });

  it("accepts valid .tg accounts", () => {
    expect(isValidNearAccount("foo.tg")).toBe(true);
    expect(isValidNearAccount("bar.baz.tg")).toBe(true);
  });

  it("accepts a 64-char hex implicit account", () => {
    const implicit = "a".repeat(64);
    expect(isValidNearAccount(implicit)).toBe(true);
    expect(
      isValidNearAccount("17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"),
    ).toBe(true);
  });

  it("rejects the .nea typo (wrong TLA)", () => {
    expect(isValidNearAccount("merchantx402.nea")).toBe(false);
    expect(isValidNearAccount("foo.nea")).toBe(false);
  });

  it("rejects other wrong TLAs", () => {
    expect(isValidNearAccount("foo.neer")).toBe(false);
    expect(isValidNearAccount("foo.com")).toBe(false);
    expect(isValidNearAccount("foo.eth")).toBe(false);
    expect(isValidNearAccount("foo.testnet")).toBe(false);
  });

  it("rejects names with no TLA", () => {
    expect(isValidNearAccount("merchant")).toBe(false);
    expect(isValidNearAccount("alice")).toBe(false);
  });

  it("rejects uppercase characters", () => {
    expect(isValidNearAccount("Merchant.near")).toBe(false);
    expect(isValidNearAccount("FOO.near")).toBe(false);
    expect(isValidNearAccount("A".repeat(64))).toBe(false);
  });

  it("rejects whitespace", () => {
    expect(isValidNearAccount(" merchant.near")).toBe(false);
    expect(isValidNearAccount("merchant.near ")).toBe(false);
    expect(isValidNearAccount("merchant .near")).toBe(false);
  });

  it("rejects leading or trailing separators", () => {
    expect(isValidNearAccount(".near")).toBe(false);
    expect(isValidNearAccount("-foo.near")).toBe(false);
    expect(isValidNearAccount("foo-.near")).toBe(false);
    expect(isValidNearAccount("_foo.near")).toBe(false);
  });

  it("rejects consecutive separators", () => {
    expect(isValidNearAccount("foo--bar.near")).toBe(false);
    expect(isValidNearAccount("foo..bar.near")).toBe(false);
    expect(isValidNearAccount("foo__bar.near")).toBe(false);
  });

  it("rejects out-of-bounds lengths", () => {
    expect(isValidNearAccount("a")).toBe(false); // too short
    expect(isValidNearAccount("a".repeat(65))).toBe(false); // too long
  });

  it("rejects 63-char hex (one short of implicit length)", () => {
    expect(isValidNearAccount("a".repeat(63))).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidNearAccount("")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// isNearNativeAsset
// ═══════════════════════════════════════════════════════════════════════

describe("isNearNativeAsset", () => {
  it("recognises NEAR-native named tokens", () => {
    expect(isNearNativeAsset("nep141:usdt.tether-token.near")).toBe(true);
    expect(isNearNativeAsset("nep141:wrap.near")).toBe(true);
    expect(isNearNativeAsset("nep141:usn.near")).toBe(true);
  });

  it("recognises NEAR implicit accounts (64-char hex)", () => {
    expect(
      isNearNativeAsset("nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"),
    ).toBe(true);
    expect(isNearNativeAsset("nep141:" + "a".repeat(64))).toBe(true);
  });

  it("rejects OMFT-bridged assets (non-native)", () => {
    expect(
      isNearNativeAsset("nep141:base-0x833589f.omft.near"),
    ).toBe(false);
    expect(
      isNearNativeAsset("nep141:stellar-GA5Z.omft.near"),
    ).toBe(false);
    expect(
      isNearNativeAsset("nep141:arb-0xaf88d065.omft.near"),
    ).toBe(false);
  });

  it("rejects non-NEAR suffixes", () => {
    expect(isNearNativeAsset("nep141:foo.eth")).toBe(false);
    expect(isNearNativeAsset("nep141:bar.com")).toBe(false);
  });

  it("rejects obviously malformed input", () => {
    expect(isNearNativeAsset("")).toBe(false);
    expect(isNearNativeAsset("nep141:")).toBe(false);
  });

  it("accepts asset IDs without the nep141: prefix", () => {
    // The function strips the prefix itself so both forms should work.
    expect(isNearNativeAsset("wrap.near")).toBe(true);
    expect(isNearNativeAsset("a".repeat(64))).toBe(true);
  });
});
