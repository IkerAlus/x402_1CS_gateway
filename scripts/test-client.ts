/**
 * x402 Test Client — simulates a buyer wallet paying the gateway.
 *
 * This script exercises the full live 402 flow:
 *   1. GET /api/premium → 402 + PAYMENT-REQUIRED
 *   2. Decode the requirements, sign an EIP-3009 authorization
 *   3. GET /api/premium + PAYMENT-SIGNATURE → (gateway settles) → 200
 *
 * Usage:
 *   # First start the gateway in another terminal:
 *   #   npx tsx src/server.ts
 *
 *   # Then run this client (dry run — no real funds):
 *   npx tsx scripts/test-client.ts
 *
 *   # Or with real signing (you must fund the buyer wallet):
 *   BUYER_PRIVATE_KEY=0x... npx tsx scripts/test-client.ts
 *
 * ⚠️  WARNING: With a funded buyer wallet and a live gateway, this
 *    script will attempt a REAL on-chain payment. Use small amounts.
 */

import { ethers } from "ethers";
import {
  authorizationTypes,
  permit2WitnessTypes,
  PERMIT2_ADDRESS,
  x402ExactPermit2ProxyAddress,
} from "@x402/evm";

// ═══════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:3402";
const RESOURCE_PATH = process.env.RESOURCE_PATH ?? "/api/premium";

// Default: Hardhat test wallet #0 — has no funds on real chains
const DEFAULT_BUYER_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const BUYER_PRIVATE_KEY = process.env.BUYER_PRIVATE_KEY ?? DEFAULT_BUYER_KEY;

const DRY_RUN = process.env.DRY_RUN !== "false"; // Default: dry run (don't send payment)

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

/** Base64-safe encode a JSON object (matching @x402/core/http). */
function encodeBase64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

/** Decode a base64-encoded JSON header. */
function decodeBase64<T>(encoded: string): T {
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as T;
}

interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource: { url: string; description?: string };
  accepts: Array<{
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra: Record<string, unknown>;
  }>;
}

// ═══════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const wallet = new ethers.Wallet(BUYER_PRIVATE_KEY);
  console.log("═══════════════════════════════════════════════════════");
  console.log("  x402 Test Client");
  console.log(`  Gateway:   ${GATEWAY_URL}`);
  console.log(`  Resource:  ${RESOURCE_PATH}`);
  console.log(`  Buyer:     ${wallet.address}`);
  console.log(`  Dry run:   ${DRY_RUN}`);
  console.log("═══════════════════════════════════════════════════════");
  console.log("");

  // ── Step 1: Request without payment ────────────────────────────────
  console.log("Step 1: GET (no payment header) → expecting 402...");
  const url = `${GATEWAY_URL}${RESOURCE_PATH}`;

  const initialRes = await fetch(url);
  console.log(`  Status: ${initialRes.status}`);

  if (initialRes.status !== 402) {
    console.error(
      `  ❌ Expected 402, got ${initialRes.status}. Body:`,
      await initialRes.text(),
    );
    process.exit(1);
  }

  // ── Step 2: Decode PAYMENT-REQUIRED ────────────────────────────────
  const paymentRequiredHeader = initialRes.headers.get("payment-required");
  if (!paymentRequiredHeader) {
    console.error("  ❌ No PAYMENT-REQUIRED header in 402 response");
    process.exit(1);
  }

  console.log("  ✅ Got 402 with PAYMENT-REQUIRED header");
  console.log("");

  const paymentRequired = decodeBase64<PaymentRequired>(paymentRequiredHeader);
  console.log("Step 2: Decoded PaymentRequired:");
  console.log(`  x402Version:       ${paymentRequired.x402Version}`);
  console.log(`  resource.url:      ${paymentRequired.resource.url}`);
  console.log(`  accepts count:     ${paymentRequired.accepts.length}`);

  if (paymentRequired.accepts.length === 0) {
    console.error("  ❌ No payment options in accepts array");
    process.exit(1);
  }

  const accepted = paymentRequired.accepts[0]!;
  console.log("");
  console.log("  Payment option [0]:");
  console.log(`    scheme:              ${accepted.scheme}`);
  console.log(`    network:             ${accepted.network}`);
  console.log(`    asset:               ${accepted.asset}`);
  console.log(`    amount:              ${accepted.amount} (smallest unit)`);
  console.log(
    `    amount (human):      ${(Number(accepted.amount) / 1e6).toFixed(6)} USDC`,
  );
  console.log(`    payTo:               ${accepted.payTo}`);
  console.log(`    maxTimeoutSeconds:   ${accepted.maxTimeoutSeconds}`);
  console.log(`    extra.name:          ${accepted.extra.name}`);
  console.log(`    extra.version:       ${accepted.extra.version}`);
  console.log(
    `    extra.transferMethod: ${accepted.extra.assetTransferMethod}`,
  );

  if (DRY_RUN) {
    console.log("");
    console.log("═══════════════════════════════════════════════════════");
    console.log("  DRY RUN — stopping here.");
    console.log("  The 402 flow works. To attempt a real payment:");
    console.log("");
    console.log("  1. Fund the buyer wallet with USDC on Base:");
    console.log(`     ${wallet.address}`);
    console.log("");
    console.log("  2. Fund the facilitator wallet with ETH on Base");
    console.log("     (for gas — see the gateway startup logs for address)");
    console.log("");
    console.log("  3. Run again with DRY_RUN=false:");
    console.log(
      "     DRY_RUN=false BUYER_PRIVATE_KEY=0x... npx tsx scripts/test-client.ts",
    );
    console.log("═══════════════════════════════════════════════════════");
    return;
  }

  // ── Step 3: Sign the payment ───────────────────────────────────────
  console.log("");
  console.log("Step 3: Signing payment...");

  const transferMethod = accepted.extra.assetTransferMethod as string;
  let signedPayload: Record<string, unknown>;

  if (transferMethod === "eip3009") {
    signedPayload = await signEIP3009(wallet, accepted);
  } else if (transferMethod === "permit2") {
    signedPayload = await signPermit2(wallet, accepted);
  } else {
    console.error(`  ❌ Unknown transfer method: ${transferMethod}`);
    process.exit(1);
  }

  const paymentPayload = {
    x402Version: paymentRequired.x402Version,
    resource: paymentRequired.resource,
    accepted,
    payload: signedPayload,
  };

  const encodedPayment = encodeBase64(paymentPayload);
  console.log(`  ✅ Signed (${transferMethod}) — payload length: ${encodedPayment.length} chars`);

  // ── Step 4: Retry with PAYMENT-SIGNATURE ───────────────────────────
  console.log("");
  console.log("Step 4: GET with PAYMENT-SIGNATURE → awaiting settlement...");
  console.log("  (This may take 30-60 seconds for the cross-chain swap...)");

  const startTime = Date.now();
  const paymentRes = await fetch(url, {
    headers: { "PAYMENT-SIGNATURE": encodedPayment },
  });
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`  Status: ${paymentRes.status} (took ${elapsed}s)`);

  if (paymentRes.status === 200) {
    console.log("  ✅ Payment accepted!");
    console.log("");

    // Decode PAYMENT-RESPONSE
    const paymentResponseHeader = paymentRes.headers.get("payment-response");
    if (paymentResponseHeader) {
      const paymentResponse = decodeBase64<Record<string, unknown>>(
        paymentResponseHeader,
      );
      console.log("  PAYMENT-RESPONSE:");
      console.log(`    success:     ${paymentResponse.success}`);
      console.log(`    transaction: ${paymentResponse.transaction}`);
      console.log(`    network:     ${paymentResponse.network}`);
      console.log(`    payer:       ${paymentResponse.payer}`);
      if (paymentResponse.extensions) {
        console.log(
          `    extensions:  ${JSON.stringify(paymentResponse.extensions, null, 2)}`,
        );
      }
    }

    // Resource body
    const body = await paymentRes.json();
    console.log("");
    console.log("  Resource body:", JSON.stringify(body, null, 2));
  } else {
    console.log(`  ❌ Payment failed with status ${paymentRes.status}`);
    const body = await paymentRes.text();
    console.log(`  Body: ${body}`);

    // Decode PAYMENT-REQUIRED header to surface the verification error
    const paymentRequiredRetryHeader = paymentRes.headers.get("payment-required");
    if (paymentRequiredRetryHeader) {
      const pr = decodeBase64<PaymentRequired>(paymentRequiredRetryHeader);
      if (pr.error) {
        console.log(`  Verification error: ${pr.error}`);
      }
    }

    const paymentResponseHeader = paymentRes.headers.get("payment-response");
    if (paymentResponseHeader) {
      const paymentResponse = decodeBase64<Record<string, unknown>>(
        paymentResponseHeader,
      );
      console.log(
        "  PAYMENT-RESPONSE:",
        JSON.stringify(paymentResponse, null, 2),
      );
    }
  }

  console.log("");
  console.log("Done.");
}

// ═══════════════════════════════════════════════════════════════════════
// EIP-3009 signing
// ═══════════════════════════════════════════════════════════════════════

async function signEIP3009(
  wallet: ethers.Wallet,
  accepted: PaymentRequired["accepts"][0],
): Promise<Record<string, unknown>> {
  const chainId = parseInt(accepted.network.split(":")[1]!, 10);
  const nowSec = Math.floor(Date.now() / 1000);

  const authorization = {
    from: wallet.address,
    to: accepted.payTo,
    value: accepted.amount,
    validAfter: "0",
    validBefore: String(nowSec + accepted.maxTimeoutSeconds),
    nonce: "0x" + ethers.hexlify(ethers.randomBytes(32)).slice(2),
  };

  const domain: ethers.TypedDataDomain = {
    name: accepted.extra.name as string,
    version: accepted.extra.version as string,
    chainId,
    verifyingContract: accepted.asset,
  };

  const types = {
    TransferWithAuthorization: authorizationTypes.TransferWithAuthorization.map(
      (f) => ({ name: f.name, type: f.type }),
    ),
  };

  const message = {
    from: authorization.from,
    to: authorization.to,
    value: authorization.value,
    validAfter: authorization.validAfter,
    validBefore: authorization.validBefore,
    nonce: authorization.nonce,
  };

  const signature = await wallet.signTypedData(domain, types, message);

  return { signature, authorization };
}

// ═══════════════════════════════════════════════════════════════════════
// Permit2 signing
// ═══════════════════════════════════════════════════════════════════════

async function signPermit2(
  wallet: ethers.Wallet,
  accepted: PaymentRequired["accepts"][0],
): Promise<Record<string, unknown>> {
  const chainId = parseInt(accepted.network.split(":")[1]!, 10);
  const nowSec = Math.floor(Date.now() / 1000);

  const permit2Authorization = {
    from: wallet.address,
    permitted: {
      token: accepted.asset,
      amount: accepted.amount,
    },
    spender: x402ExactPermit2ProxyAddress,
    nonce: String(Math.floor(Math.random() * 1_000_000)),
    deadline: String(nowSec + accepted.maxTimeoutSeconds),
    witness: {
      to: accepted.payTo,
      validAfter: "0",
    },
  };

  const domain: ethers.TypedDataDomain = {
    name: "Permit2",
    verifyingContract: PERMIT2_ADDRESS,
    chainId,
  };

  const types: Record<string, Array<{ name: string; type: string }>> = {};
  for (const [key, fields] of Object.entries(permit2WitnessTypes)) {
    types[key] = fields.map((f: { name: string; type: string }) => ({
      name: f.name,
      type: f.type,
    }));
  }

  const message = {
    permitted: permit2Authorization.permitted,
    spender: permit2Authorization.spender,
    nonce: permit2Authorization.nonce,
    deadline: permit2Authorization.deadline,
    witness: permit2Authorization.witness,
  };

  const signature = await wallet.signTypedData(domain, types, message);

  return { signature, permit2Authorization };
}

// ═══════════════════════════════════════════════════════════════════════

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
