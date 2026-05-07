/**
 * Tests for the client-side signer module.
 *
 * Verifies that EIP-3009 and Permit2 signing produce payloads that
 * pass the gateway's verification logic. Uses real EIP-712 signatures
 * (ethers.Wallet.signTypedData) and round-trips them through
 * ethers.verifyTypedData.
 *
 * @module client/signer.test
 */

import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import { authorizationTypes, permit2WitnessTypes, PERMIT2_ADDRESS } from "@x402/evm";

import { signPayment, signEIP3009, signPermit2, extractChainId } from "./signer.js";
import type { PaymentRequirements, EIP3009SignedPayload, Permit2SignedPayload } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════════

const BUYER_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const wallet = new ethers.Wallet(BUYER_PRIVATE_KEY);

function eip3009Requirements(
  overrides: Partial<PaymentRequirements> = {},
): PaymentRequirements {
  return {
    scheme: "exact",
    network: "eip155:8453",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    amount: "1050000",
    payTo: "0x7a16fF8270133F063aAb6C9977183D9e72835428",
    maxTimeoutSeconds: 300,
    extra: {
      name: "USD Coin",
      version: "2",
      assetTransferMethod: "eip3009",
    },
    ...overrides,
  };
}

function permit2Requirements(
  overrides: Partial<PaymentRequirements> = {},
): PaymentRequirements {
  return {
    ...eip3009Requirements(),
    extra: {
      name: "USD Coin",
      version: "2",
      assetTransferMethod: "permit2",
    },
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe("extractChainId", () => {
  it("extracts chain ID from CAIP-2 string", () => {
    expect(extractChainId("eip155:8453")).toBe(8453);
    expect(extractChainId("eip155:1")).toBe(1);
    expect(extractChainId("eip155:42161")).toBe(42161);
  });

  it("rejects non-eip155 networks", () => {
    expect(() => extractChainId("solana:mainnet")).toThrow("Unsupported network format");
  });

  it("rejects malformed strings", () => {
    expect(() => extractChainId("eip155")).toThrow("Unsupported network format");
    expect(() => extractChainId("eip155:abc")).toThrow("Invalid chain ID");
  });
});

describe("signEIP3009", () => {
  it("produces a valid EIP-712 signature that recovers to the wallet address", async () => {
    const requirements = eip3009Requirements();
    const payload = await signEIP3009(wallet, requirements);

    expect(payload.x402Version).toBe(2);
    expect(payload.accepted).toEqual(requirements);

    const signed = payload.payload as EIP3009SignedPayload;
    expect(signed.signature).toMatch(/^0x[a-fA-F0-9]{130}$/);
    expect(signed.authorization.from).toBe(wallet.address);
    expect(signed.authorization.to).toBe(requirements.payTo);
    expect(signed.authorization.value).toBe(requirements.amount);

    // Verify the signature round-trips
    const domain = {
      name: requirements.extra.name,
      version: requirements.extra.version,
      chainId: 8453,
      verifyingContract: requirements.asset,
    };
    const types = {
      TransferWithAuthorization: authorizationTypes.TransferWithAuthorization.map(
        (f) => ({ name: f.name, type: f.type }),
      ),
    };
    const recovered = ethers.verifyTypedData(
      domain,
      types,
      signed.authorization,
      signed.signature,
    );
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it("sets validAfter to 0 and validBefore based on maxTimeoutSeconds", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const requirements = eip3009Requirements({ maxTimeoutSeconds: 600 });
    const payload = await signEIP3009(wallet, requirements);
    const signed = payload.payload as EIP3009SignedPayload;

    expect(signed.authorization.validAfter).toBe("0");
    const validBefore = Number(signed.authorization.validBefore);
    expect(validBefore).toBeGreaterThanOrEqual(nowSec + 590); // small tolerance
    expect(validBefore).toBeLessThanOrEqual(nowSec + 610);
  });

  it("generates a unique nonce for each signing", async () => {
    const requirements = eip3009Requirements();
    const p1 = await signEIP3009(wallet, requirements);
    const p2 = await signEIP3009(wallet, requirements);

    const nonce1 = (p1.payload as EIP3009SignedPayload).authorization.nonce;
    const nonce2 = (p2.payload as EIP3009SignedPayload).authorization.nonce;
    expect(nonce1).not.toBe(nonce2);
  });

  it("includes resource URL when provided", async () => {
    const payload = await signEIP3009(
      wallet,
      eip3009Requirements(),
      "/api/premium",
    );
    expect(payload.resource?.url).toBe("/api/premium");
  });

  it("omits resource when not provided", async () => {
    const payload = await signEIP3009(wallet, eip3009Requirements());
    expect(payload.resource).toBeUndefined();
  });
});

describe("signPermit2", () => {
  it("produces a valid Permit2 signature that recovers to the wallet address", async () => {
    const requirements = permit2Requirements();
    const payload = await signPermit2(wallet, requirements);

    expect(payload.x402Version).toBe(2);
    expect(payload.accepted).toEqual(requirements);

    const signed = payload.payload as Permit2SignedPayload;
    expect(signed.signature).toMatch(/^0x[a-fA-F0-9]{130}$/);
    expect(signed.permit2Authorization.from).toBe(wallet.address);
    expect(signed.permit2Authorization.permitted.token).toBe(requirements.asset);
    expect(signed.permit2Authorization.permitted.amount).toBe(requirements.amount);
    expect(signed.permit2Authorization.witness.to).toBe(requirements.payTo);

    // Verify the signature round-trips
    const domain = {
      name: "Permit2",
      verifyingContract: PERMIT2_ADDRESS,
      chainId: 8453,
    };
    const types: Record<string, Array<{ name: string; type: string }>> = {};
    for (const [key, fields] of Object.entries(permit2WitnessTypes)) {
      types[key] = fields.map((f: { name: string; type: string }) => ({
        name: f.name,
        type: f.type,
      }));
    }
    const message = {
      permitted: signed.permit2Authorization.permitted,
      spender: signed.permit2Authorization.spender,
      nonce: signed.permit2Authorization.nonce,
      deadline: signed.permit2Authorization.deadline,
      witness: signed.permit2Authorization.witness,
    };
    const recovered = ethers.verifyTypedData(domain, types, message, signed.signature);
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });
});

describe("signPayment (dispatch)", () => {
  it("dispatches to signEIP3009 when assetTransferMethod is eip3009", async () => {
    const payload = await signPayment(wallet, eip3009Requirements());
    expect((payload.payload as EIP3009SignedPayload).authorization).toBeDefined();
  });

  it("dispatches to signPermit2 when assetTransferMethod is permit2", async () => {
    const payload = await signPayment(wallet, permit2Requirements());
    expect((payload.payload as Permit2SignedPayload).permit2Authorization).toBeDefined();
  });

  it("throws for unsupported transfer method", async () => {
    const bad = eip3009Requirements({
      extra: { name: "X", version: "1", assetTransferMethod: "unknown" as any },
    });
    await expect(signPayment(wallet, bad)).rejects.toThrow(
      "Unsupported asset transfer method",
    );
  });
});
