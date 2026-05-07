/**
 * Tests for the ownership-proof module.
 *
 * Covers the canonical message builder, URL normalisation, signature
 * shape validation, signer recovery, sign-then-recover round-trips, and
 * the startup-validation aggregator used by `config.ts`.
 */

import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import {
  OWNERSHIP_PROOF_PREFIX,
  OWNERSHIP_PROOF_SIGNATURE_REGEX,
  buildOwnershipProofMessage,
  normalizePublicBaseUrl,
  isValidOwnershipProofFormat,
  recoverOwnershipProofSigner,
  signOwnershipProof,
  validateOwnershipProofs,
} from "./ownership-proof.js";

// ═══════════════════════════════════════════════════════════════════════
// normalizePublicBaseUrl
// ═══════════════════════════════════════════════════════════════════════

describe("normalizePublicBaseUrl", () => {
  it("strips trailing slash and path", () => {
    expect(normalizePublicBaseUrl("https://gateway.example.com/"))
      .toBe("https://gateway.example.com");
    expect(normalizePublicBaseUrl("https://gateway.example.com/some/path"))
      .toBe("https://gateway.example.com");
    expect(normalizePublicBaseUrl("https://gateway.example.com/?x=1#frag"))
      .toBe("https://gateway.example.com");
  });

  it("lowercases scheme and host", () => {
    expect(normalizePublicBaseUrl("HTTPS://Gateway.Example.COM"))
      .toBe("https://gateway.example.com");
  });

  it("drops default ports (80 for http, 443 for https)", () => {
    expect(normalizePublicBaseUrl("http://gateway.example.com:80"))
      .toBe("http://gateway.example.com");
    expect(normalizePublicBaseUrl("https://gateway.example.com:443"))
      .toBe("https://gateway.example.com");
  });

  it("preserves non-default ports", () => {
    expect(normalizePublicBaseUrl("https://gateway.example.com:8443"))
      .toBe("https://gateway.example.com:8443");
  });

  it("rejects non-http(s) schemes", () => {
    expect(() => normalizePublicBaseUrl("ftp://gateway.example.com"))
      .toThrow(/must use http or https/);
    expect(() => normalizePublicBaseUrl("ws://gateway.example.com"))
      .toThrow(/must use http or https/);
  });

  it("rejects malformed URLs", () => {
    expect(() => normalizePublicBaseUrl("not a url at all")).toThrow();
    expect(() => normalizePublicBaseUrl("")).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// buildOwnershipProofMessage
// ═══════════════════════════════════════════════════════════════════════

describe("buildOwnershipProofMessage", () => {
  it("uses the canonical prefix", () => {
    const msg = buildOwnershipProofMessage("https://gateway.example.com");
    expect(msg.startsWith(OWNERSHIP_PROOF_PREFIX)).toBe(true);
  });

  it("produces identical output for URLs that differ only in trailing slash", () => {
    const a = buildOwnershipProofMessage("https://gateway.example.com");
    const b = buildOwnershipProofMessage("https://gateway.example.com/");
    expect(a).toBe(b);
  });

  it("produces identical output for URLs that differ only in case", () => {
    const a = buildOwnershipProofMessage("https://Gateway.Example.COM");
    const b = buildOwnershipProofMessage("https://gateway.example.com");
    expect(a).toBe(b);
  });

  it("produces identical output for default vs omitted port", () => {
    expect(buildOwnershipProofMessage("https://gateway.example.com:443"))
      .toBe(buildOwnershipProofMessage("https://gateway.example.com"));
  });

  it("matches the documented example verbatim", () => {
    expect(buildOwnershipProofMessage("https://gateway.example.com"))
      .toBe("x402 ownership of https://gateway.example.com");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Signature shape
// ═══════════════════════════════════════════════════════════════════════

describe("isValidOwnershipProofFormat", () => {
  it("accepts a 0x + 130 hex-char string", () => {
    const sig = "0x" + "a".repeat(130);
    expect(isValidOwnershipProofFormat(sig)).toBe(true);
    expect(OWNERSHIP_PROOF_SIGNATURE_REGEX.test(sig)).toBe(true);
  });

  it("accepts mixed-case hex", () => {
    expect(isValidOwnershipProofFormat("0x" + "aB".repeat(65))).toBe(true);
  });

  it("rejects missing 0x prefix", () => {
    expect(isValidOwnershipProofFormat("a".repeat(130))).toBe(false);
  });

  it("rejects wrong length", () => {
    expect(isValidOwnershipProofFormat("0x" + "a".repeat(128))).toBe(false);
    expect(isValidOwnershipProofFormat("0x" + "a".repeat(132))).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(isValidOwnershipProofFormat("0x" + "g".repeat(130))).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidOwnershipProofFormat("")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Round-trip: sign then recover
// ═══════════════════════════════════════════════════════════════════════

describe("signOwnershipProof + recoverOwnershipProofSigner", () => {
  const PRIVATE_KEY = "0x" + "ab".repeat(32);
  const URL = "https://gateway.example.com";

  it("recovers the signer address", async () => {
    const wallet = new ethers.Wallet(PRIVATE_KEY);
    const sig = await signOwnershipProof(wallet, URL);
    const recovered = recoverOwnershipProofSigner(sig, URL);
    expect(recovered).toBe(wallet.address.toLowerCase());
  });

  it("produces a signature matching the structural regex", async () => {
    const wallet = new ethers.Wallet(PRIVATE_KEY);
    const sig = await signOwnershipProof(wallet, URL);
    expect(isValidOwnershipProofFormat(sig)).toBe(true);
  });

  it("recovers to the same address for differently-formatted URLs of the same origin", async () => {
    const wallet = new ethers.Wallet(PRIVATE_KEY);
    const sig = await signOwnershipProof(wallet, "https://Gateway.Example.COM/");
    // URL that differs only in cosmetic ways — message builder normalises both.
    const recovered = recoverOwnershipProofSigner(sig, "https://gateway.example.com");
    expect(recovered).toBe(wallet.address.toLowerCase());
  });

  it("recovers a different address when the URL differs semantically", async () => {
    const wallet = new ethers.Wallet(PRIVATE_KEY);
    const sig = await signOwnershipProof(wallet, "https://gateway.example.com");
    // Signature was over example.com, but we ask recovery against example.org.
    // EIP-191 recovery does not throw — it returns whatever address the
    // signature math produces, which for this altered message won't match
    // the original wallet.
    const recovered = recoverOwnershipProofSigner(sig, "https://gateway.example.org");
    expect(recovered).not.toBe(wallet.address.toLowerCase());
  });

  it("throws on malformed signatures", () => {
    expect(() => recoverOwnershipProofSigner("0xdeadbeef", URL))
      .toThrow(/malformed/);
    expect(() => recoverOwnershipProofSigner("not-a-signature", URL))
      .toThrow(/malformed/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// validateOwnershipProofs
// ═══════════════════════════════════════════════════════════════════════

describe("validateOwnershipProofs", () => {
  const URL = "https://gateway.example.com";
  const WALLET = new ethers.Wallet("0x" + "cd".repeat(32));

  async function realProof(url: string = URL): Promise<string> {
    return signOwnershipProof(WALLET, url);
  }

  it("returns empty with no warnings when both inputs are empty", () => {
    expect(validateOwnershipProofs([], undefined))
      .toEqual({ valid: [], warnings: [] });
  });

  it("warns when proofs are set but publicBaseUrl is not", () => {
    const { valid, warnings } = validateOwnershipProofs(["0x" + "a".repeat(130)], undefined);
    expect(valid).toEqual([]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/PUBLIC_BASE_URL is not/);
  });

  it("flags malformed proofs without dropping the valid ones", async () => {
    const good = await realProof();
    const bad = "not-a-proof";
    const { valid, warnings } = validateOwnershipProofs([bad, good], URL);

    // Good proof survives; malformed entry is reported but skipped.
    expect(valid).toContain(good);
    expect(valid).not.toContain(bad);
    expect(warnings.some((w) => w.includes("OWNERSHIP_PROOFS[0] is malformed"))).toBe(true);
    expect(warnings.some((w) => w.includes("recovered to"))).toBe(true);
  });

  it("includes the signer address in the info warning for each valid proof", async () => {
    const good = await realProof();
    const { warnings } = validateOwnershipProofs([good], URL);
    const infoLine = warnings.find((w) => w.includes("recovered to"));
    expect(infoLine).toBeDefined();
    expect(infoLine!).toContain(WALLET.address.toLowerCase());
  });

  it("handles multiple valid proofs from the same key", async () => {
    const a = await realProof();
    const b = await realProof(); // Same key, same URL — ECDSA is non-deterministic
    const { valid, warnings } = validateOwnershipProofs([a, b], URL);
    expect(valid).toContain(a);
    expect(valid).toContain(b);
    // Both info lines present.
    expect(warnings.filter((w) => w.includes("recovered to")).length).toBe(2);
  });

  it("handles a proof signed against a different URL (still structurally valid, recovers wrong address)", async () => {
    const sigOverOtherUrl = await realProof("https://other.example.com");
    const { valid, warnings } = validateOwnershipProofs([sigOverOtherUrl], URL);
    // Signature is structurally valid, so it ends up in `valid` and logs
    // an info line with the recovered address — which will differ from
    // the operator's wallet. Verification against a known operator key
    // is intentionally out of scope for this helper (multisig / HW
    // wallets can't be pre-enumerated).
    expect(valid.length).toBe(1);
    const infoLine = warnings.find((w) => w.includes("recovered to"));
    expect(infoLine).toBeDefined();
    expect(infoLine!).not.toContain(WALLET.address.toLowerCase());
  });
});
