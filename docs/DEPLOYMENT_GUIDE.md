# x402-1CS Gateway — Deployment & Testing Guide

This guide walks you through deploying and testing the gateway against the **real 1Click Swap API** on Base mainnet. It covers API key verification, dry 402 testing (no funds needed), full end-to-end payment testing (requires funded wallets), and programmatic client usage via the `src/client/` library.

---

## Prerequisites

- **Node.js >= 20** and npm
- **A 1CS JWT token** — request one at https://docs.near-intents.org (needed for non-dry quotes with deposit addresses)
- For full payment testing:
  - A **buyer wallet** funded with USDC on Base
  - A **facilitator wallet** funded with ETH on Base (for gas)

## 1. Install dependencies

```bash
cd x402_1CS_gateway
npm install
```

If you hit the `@rollup/rollup-darwin-arm64` error, run:

```bash
npm install @rollup/rollup-darwin-arm64 --save-optional
```

## 2. Configure environment

Copy the example file and fill in real values:

```bash
cp .env.example .env
```

Edit `.env` with the values below.

### Required fields

All 10 of these must be set (no defaults):

| Field | Format | Example |
|-------|--------|---------|
| `ONE_CLICK_JWT` | JWT string | `eyJhbGciOiJS...` |
| `MERCHANT_RECIPIENT` | NEAR account | `merchant.near` |
| `MERCHANT_ASSET_OUT` | NEP-141 asset ID | `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` |
| `MERCHANT_AMOUNT_OUT` | Integer (smallest unit) | `1000000` (= 1 USDC) |
| `ORIGIN_NETWORK` | CAIP-2 string | `eip155:8453` |
| `ORIGIN_ASSET_IN` | NEP-141 asset ID | `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near` |
| `ORIGIN_TOKEN_ADDRESS` | EVM address (0x + 40 hex) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| `ORIGIN_RPC_URLS` | Comma-separated URLs | `https://mainnet.base.org` |
| `FACILITATOR_PRIVATE_KEY` | EVM private key (0x + 64 hex) | `0x59c6995e998f97a5a...` |
| `GATEWAY_REFUND_ADDRESS` | EVM address (0x + 40 hex) | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` |

> **IMPORTANT**: `GATEWAY_REFUND_ADDRESS` must be a valid 42-character hex address (e.g. `0x70997970C51812dc3A010C7d01b50e0d17dc79C8`). Placeholder values like `0xYourRefundAddress` will fail Zod validation at startup.

### Minimal .env for dry 402 testing (no funds needed)

For testing just the quote/402 flow, you only need a JWT and a facilitator key (can be any private key — it won't be used for transactions):

```bash
# .env — minimal for dry 402 testing
ONE_CLICK_JWT=your-real-jwt-token
MERCHANT_RECIPIENT=merchant.near
MERCHANT_ASSET_OUT=nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1
MERCHANT_AMOUNT_OUT=1000000

ORIGIN_NETWORK=eip155:8453
ORIGIN_ASSET_IN=nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near
ORIGIN_TOKEN_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
ORIGIN_RPC_URLS=https://mainnet.base.org

# Any private key works for dry testing — this is Hardhat's well-known test key #1
FACILITATOR_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
GATEWAY_REFUND_ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
```

### Full .env for real payment testing

For a real end-to-end payment, replace the facilitator key and refund address with funded wallets:

```bash
# .env — full payment testing
ONE_CLICK_JWT=your-real-jwt-token
MERCHANT_RECIPIENT=your-merchant.near
MERCHANT_ASSET_OUT=nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1
MERCHANT_AMOUNT_OUT=1000000

ORIGIN_NETWORK=eip155:8453
ORIGIN_ASSET_IN=nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near
ORIGIN_TOKEN_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
ORIGIN_RPC_URLS=https://mainnet.base.org,https://base.drpc.org

# REAL funded wallets — replace with your own
FACILITATOR_PRIVATE_KEY=0x_your_facilitator_key_with_ETH_on_Base
GATEWAY_REFUND_ADDRESS=0x_your_facilitator_address_here

# EIP-712 metadata — these MUST match the on-chain token
TOKEN_NAME=USD Coin
TOKEN_VERSION=2
TOKEN_SUPPORTS_EIP3009=true
```

### Optional fields (all have defaults)

These are already set to sensible defaults. Override only if needed:

| Field | Default | Description |
|-------|---------|-------------|
| `ONE_CLICK_BASE_URL` | `https://1click.chaindefuser.com` | 1CS API base URL |
| `TOKEN_NAME` | `USD Coin` | EIP-712 domain name (must match on-chain) |
| `TOKEN_VERSION` | `2` | EIP-712 domain version |
| `TOKEN_SUPPORTS_EIP3009` | `true` | Token supports transferWithAuthorization |
| `MAX_POLL_TIME_MS` | `300000` | Max 1CS polling time (5 min) |
| `POLL_INTERVAL_BASE_MS` | `2000` | Initial poll interval |
| `POLL_INTERVAL_MAX_MS` | `30000` | Max poll interval after backoff |
| `QUOTE_EXPIRY_BUFFER_SEC` | `30` | Min remaining time on a quote |
| `RATE_LIMIT_QUOTES_PER_WINDOW` | `20` | Max 402 requests per IP per window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit sliding window (1 min) |
| `MAX_CONCURRENT_SETTLEMENTS` | `10` | Max in-flight settlements |
| `QUOTE_GC_INTERVAL_MS` | `60000` | GC sweep interval (0 = disabled) |
| `QUOTE_GC_GRACE_PERIOD_MS` | `300000` | Grace period before GC prunes quotes |
| `PORT` | `3402` | Server listen port |

### Critical note: asset ID formats

The 1CS API uses the `nep141:` prefix format for all assets. The two asset IDs you need are:

**USDC on Base (origin — what the buyer pays)**:
```
nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near
```

**USDC on NEAR (destination — what the merchant receives)**:
```
nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1
```

The old `base:0x...` and `near:nUSDC` formats are **not accepted** by the 1CS API. You can verify the correct IDs by calling `GET https://1click.chaindefuser.com/v0/tokens` and searching for USDC, or running:

```bash
chmod +x scripts/test-1cs-quote.sh
./scripts/test-1cs-quote.sh
```

### Critical note: TOKEN_NAME

The EIP-712 domain name for USDC on Base is `"USD Coin"`, **not** `"USDC"`. If this is wrong, signature verification will fail with a signer mismatch error. You can verify the on-chain value by calling:

```bash
cast call 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 "name()(string)" --rpc-url https://mainnet.base.org
# Returns: "USD Coin"
```

(Requires Foundry's `cast` — or check on Basescan.)

## 3. Verify your API key

Before starting the gateway, confirm your 1CS JWT is valid:

```bash
ONE_CLICK_JWT="your-jwt" npm run verify-key
```

This runs `scripts/verify-api-key.ts`, which sends a dry quote, a real (non-dry) quote, and checks the status endpoint. It reports the response structure for each call and exits with code 0 on success, 1 on failure.

## 4. Start the gateway

The `.env` file contains `TOKEN_NAME=USD Coin` which has a space. Standard shell `source .env` will break on this. Use one of these methods instead:

### Recommended: env-cmd (no global install needed)

```bash
npx env-cmd npx tsx src/server.ts
```

### Alternative: dotenv-cli

```bash
npm install -g dotenv-cli
dotenv -- npx tsx src/server.ts
```

### Alternative: export each variable manually

```bash
export ONE_CLICK_JWT="your-jwt"
export MERCHANT_RECIPIENT="merchant.near"
export MERCHANT_ASSET_OUT="nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
export MERCHANT_AMOUNT_OUT="1000000"
export ORIGIN_NETWORK="eip155:8453"
export ORIGIN_ASSET_IN="nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"
export ORIGIN_TOKEN_ADDRESS="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
export ORIGIN_RPC_URLS="https://mainnet.base.org"
export FACILITATOR_PRIVATE_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
export GATEWAY_REFUND_ADDRESS="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
export TOKEN_NAME="USD Coin"
export TOKEN_VERSION="2"
export TOKEN_SUPPORTS_EIP3009="true"
npx tsx src/server.ts
```

You should see:

```
[x402-1CS] Loading configuration...
[x402-1CS] Config OK — network=eip155:8453, merchant=merchant.near, asset=nep141:17208628f...
[x402-1CS] State store initialized (SQLite in-memory)
[x402-1CS] Provider pool ready — 1 RPC endpoint(s)
[x402-1CS] Facilitator wallet: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
[x402-1CS] Facilitator gas balance: 0.000000 ETH
[x402-1CS] Rate limiting — 20 quotes/60000ms per IP, 10 max concurrent settlements
[x402-1CS] Quote GC — sweep every 60000ms, grace period 300000ms

═══════════════════════════════════════════════════════
  x402-1CS Gateway running on http://localhost:3402

  Endpoints:
    GET /health       — health check (no payment)
    GET /api/premium  — x402 protected resource

  To test the 402 flow:
    curl -i http://localhost:3402/api/premium
═══════════════════════════════════════════════════════
```

If env vars are missing or malformed, the gateway will exit with a descriptive Zod validation error listing exactly which field failed.

## 5. Test the 402 flow (no funds needed)

### Health check

```bash
curl http://localhost:3402/health
```

Returns:

```json
{
  "status": "ok",
  "network": "eip155:8453",
  "facilitator": "0x70997970...",
  "rpcEndpoints": 1,
  "healthyProviders": 1,
  "settlements": {
    "inFlight": 0,
    "capacity": 10
  },
  "rateLimiter": {
    "trackedIPs": 0,
    "quotesPerWindow": 20,
    "windowMs": 60000
  }
}
```

### Get a 402 response

```bash
curl -i http://localhost:3402/api/premium
```

Expected output:

```
HTTP/1.1 402 Payment Required
X-RateLimit-Limit: 20
X-RateLimit-Remaining: 19
X-RateLimit-Reset: 1775120907
PAYMENT-REQUIRED: eyJ4NDAyVmVyc2lvbiI6Miw...  (base64)
Content-Type: application/json

{}
```

### Decode the 402 header

```bash
curl -s http://localhost:3402/api/premium -D - -o /dev/null 2>/dev/null | \
  grep -i payment-required | \
  sed 's/PAYMENT-REQUIRED: //' | \
  base64 -d | python3 -m json.tool
```

This should show a JSON object like:

```json
{
  "x402Version": 2,
  "resource": { "url": "/api/premium", "description": "x402-1CS protected resource" },
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:8453",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "amount": "1006482",
    "payTo": "0x9A6AFBA07b35ad1defd19E9D7f2306e64FeD01fc",
    "maxTimeoutSeconds": 86370,
    "extra": {
      "name": "USD Coin",
      "version": "2",
      "assetTransferMethod": "eip3009"
    }
  }]
}
```

Key things to verify:

- `payTo` is a real 1CS deposit address (not a mock) — this confirms the live API was called
- `amount` reflects the EXACT_OUTPUT upper bound (slightly more than `MERCHANT_AMOUNT_OUT`)
- `maxTimeoutSeconds` is > 0
- `extra.name` is `"USD Coin"` and `extra.version` is `"2"`

### Use the test client (dry run)

```bash
npx tsx scripts/test-client.ts
```

This simulates a buyer wallet, decodes the 402, and shows exactly what it would sign. In dry-run mode (the default), it stops before actually sending a payment.

## 6. Full payment test (requires funded wallets)

### What you need

1. **Buyer wallet** — an EVM address with USDC on Base. Even 2 USDC is enough for a test with `MERCHANT_AMOUNT_OUT=1000000` (1 USDC).

2. **Facilitator wallet** — needs a small amount of ETH on Base for gas. 0.001 ETH is plenty for a single test. This is the wallet whose private key is `FACILITATOR_PRIVATE_KEY`.

3. **Merchant account** — a NEAR account (`MERCHANT_RECIPIENT`) that will receive the funds. Can be any valid NEAR account.

### Fund the wallets

The easiest way to fund wallets on Base:

- **USDC**: Bridge from Ethereum or buy on a DEX. USDC on Base: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- **ETH for gas**: Bridge ETH to Base via https://bridge.base.org or a cross-chain bridge

### Run the full flow

```bash
DRY_RUN=false BUYER_PRIVATE_KEY=0xyour_buyer_key npx tsx scripts/test-client.ts
```

What happens step by step:

1. Client sends `GET /api/premium` -> receives 402
2. Client decodes PAYMENT-REQUIRED, signs an EIP-3009 `transferWithAuthorization` with the buyer wallet
3. Client sends `GET /api/premium` with `PAYMENT-SIGNATURE` header
4. **Gateway verifies** the signature, checks on-chain balance
5. **Gateway broadcasts** `transferWithAuthorization` to Base (facilitator pays gas)
6. USDC moves from buyer -> 1CS deposit address (on-chain, visible on Basescan)
7. **Gateway notifies** 1CS via `POST /v0/deposit/submit`
8. **Gateway polls** `GET /v0/status` every 2s with exponential backoff
9. 1CS executes the cross-chain swap (Base USDC -> NEAR USDC)
10. 1CS returns `SUCCESS` -> gateway responds with 200 + `PAYMENT-RESPONSE` header

Expected output (after 30-60 seconds):

```
Step 4: GET with PAYMENT-SIGNATURE -> awaiting settlement...
  (This may take 30-60 seconds for the cross-chain swap...)
  Status: 200 (took 34.2s)
  Payment accepted!

  PAYMENT-RESPONSE:
    success:     true
    transaction: 0xabc123...
    network:     eip155:8453
    payer:       0xBuyerAddress...
    extensions:  { "crossChain": { "settlementType": "crosschain-1cs", ... } }

  Resource body: { "message": "You've paid! Here is your premium content." }
```

## 7. Programmatic client (src/client/)

The `src/client/` module provides a TypeScript client library that implements the full x402 protocol flow programmatically. Use it to build applications or services that pay for x402-protected resources.

### Quick start

```ts
import { ethers } from "ethers";
import { X402Client } from "./src/client/index.js";

const wallet = new ethers.Wallet("0xYourBuyerPrivateKey");
const client = new X402Client({ gatewayUrl: "http://localhost:3402" });

// One-call: request -> sign -> pay -> get resource
const result = await client.payAndFetch(wallet, "/api/premium");

if (result.success) {
  console.log("Resource:", result.body);
  console.log("Settlement:", result.paymentResponse);
} else {
  console.log("Failed:", result.error);
}
```

### Step-by-step usage

For more control over each protocol step:

```ts
import { X402Client, signPayment } from "./src/client/index.js";

const client = new X402Client({ gatewayUrl: "http://localhost:3402" });

// 1. Request resource — get 402 with payment requirements
const resource = await client.requestResource("/api/premium");
if (resource.kind !== "payment-required") throw new Error("Expected 402");

// 2. Select a payment option
const requirements = client.selectPaymentOption(resource.paymentRequired);

// 3. Sign the payment (EIP-3009 or Permit2, auto-detected)
const payload = await client.signPayment(wallet, requirements, "/api/premium");

// 4. Submit signed payment — gateway verifies, broadcasts, settles
const result = await client.submitPayment("/api/premium", payload);
```

### Exported API

The client module (`src/client/index.ts`) exports:

- **`X402Client`** — main class with `requestResource`, `selectPaymentOption`, `signPayment`, `submitPayment`, and `payAndFetch`
- **`signPayment`** / **`signEIP3009`** / **`signPermit2`** — standalone signing functions for advanced usage
- **`extractChainId`** — parses a CAIP-2 network string into a numeric chain ID
- All TypeScript types: `PaymentRequired`, `PaymentRequirements`, `PaymentPayload`, `PaymentResponse`, `ResourceRequestResult`, `PaymentResult`, `PayAndFetchResult`, etc.

### Custom fetch

The `X402Client` accepts an injectable `fetch` function for use in test environments or custom HTTP stacks:

```ts
const client = new X402Client({
  gatewayUrl: "http://localhost:3402",
  fetch: myCustomFetch,
});
```

## 8. Running the test suite

The current numbers — total tests, per-file breakdown, live-suite runtime — live in **[docs/TEST_RESULTS.md](./TEST_RESULTS.md)**, which is refreshed whenever the suite changes. This section documents *how* to run tests; for *what* gets run, see that file.

### npm scripts

```bash
npm test              # Run all unit & integration tests (vitest)
npm run test:live     # Run live 1CS API tests (needs ONE_CLICK_JWT)
npm run test:watch    # Watch mode
npm run typecheck     # TypeScript compilation check (tsc --noEmit)
npm run verify-key    # Verify 1CS API key (scripts/verify-api-key.ts)
npm run lint          # ESLint
npm run format:check  # Prettier check
```

### Unit & integration tests

```bash
npm test
```

Fully mocked — no API key, funds, or network access required. Per-file counts and module coverage are listed in `docs/TEST_RESULTS.md` § "Mocked Test Suite".

### Live 1CS API tests

```bash
# Option 1: inline env var
ONE_CLICK_JWT="your-jwt" npm run test:live

# Option 2: source the .env.test file (created during setup)
set -a && source .env.test && set +a && npm run test:live
```

Runs the live-only tests gated by `ONE_CLICK_JWT` against the real 1CS API. Authentication, quote pairs (dry + real), error mapping, the full gateway `402 → sign → settle` flow (via supertest), and `X402Client.payAndFetch` are all exercised with real quotes but mocked on-chain broadcast — no funds are spent. See `docs/TEST_RESULTS.md` § "Live 1CS API Test Suite" for the current list and per-test durations.

The `.env.test` file (gitignored) stores the JWT so you don't have to paste it every time:

```
ONE_CLICK_JWT=<your JWT>
ONE_CLICK_BASE_URL=https://1click.chaindefuser.com
```

## 9. Troubleshooting

### Gateway exits with Zod validation error

A required environment variable is missing or malformed. The error message tells you which field failed. Common causes:

- **`GATEWAY_REFUND_ADDRESS`**: Must be exactly `0x` + 40 hex characters (e.g. `0x70997970C51812dc3A010C7d01b50e0d17dc79C8`). Placeholder values like `0xYourRefundAddress` will fail.
- **`ORIGIN_TOKEN_ADDRESS`**: Same format — `0x` + 40 hex characters.
- **`ORIGIN_RPC_URLS`**: Must be valid URLs, comma-separated.

Compare your `.env` file with `.env.example` field by field.

### "source .env" breaks with TOKEN_NAME

`TOKEN_NAME=USD Coin` has a space, which breaks `source .env` in most shells. Use `npx env-cmd npx tsx src/server.ts` instead.

### "1CS quote rejected (400): tokenIn is not valid"

Your `ORIGIN_ASSET_IN` or `MERCHANT_ASSET_OUT` uses the wrong format. 1CS expects the `nep141:` prefix format:

```
# Wrong:
ORIGIN_ASSET_IN=base:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
MERCHANT_ASSET_OUT=near:nUSDC

# Correct:
ORIGIN_ASSET_IN=nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near
MERCHANT_ASSET_OUT=nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1
```

Run `scripts/test-1cs-quote.sh` to discover the correct asset IDs from the live API.

### "Signer mismatch: signature recovers to 0x..."

The EIP-712 domain name/version doesn't match the on-chain token. For USDC on Base, the values must be:

```
TOKEN_NAME=USD Coin    # NOT "USDC"
TOKEN_VERSION=2
```

### "Facilitator gas balance too low"

The facilitator wallet needs ETH on Base to pay for the `transferWithAuthorization` transaction. Send ~0.001 ETH to the facilitator address shown in the gateway startup logs.

### "1CS authentication failed (401)"

Your JWT is expired or invalid. Run `npm run verify-key` to test it, or request a fresh one at https://docs.near-intents.org.

### "1CS status polling timed out"

The cross-chain swap didn't complete within `MAX_POLL_TIME_MS` (default: 5 minutes). This can happen if 1CS is congested or the swap amount is very large. Check the 1CS explorer or status API directly:

```bash
curl https://1click.chaindefuser.com/v0/status?depositAddress=0xTheDepositAddress
```

### "Quote deadline too short"

The 1CS quote's deadline is about to expire. This can happen if the gateway is slow to process. Increase `QUOTE_EXPIRY_BUFFER_SEC` or check network latency.

### Rate limiting (429 Too Many Requests)

The gateway rate-limits 402 requests per IP (default: 20 per minute). If you hit the limit, the response includes a `Retry-After` header with seconds to wait. Adjust `RATE_LIMIT_QUOTES_PER_WINDOW` and `RATE_LIMIT_WINDOW_MS` in `.env` if needed.

### Settlement capacity (503 Service Unavailable)

The gateway limits concurrent in-flight settlements (default: 10). If all slots are occupied, new payment submissions return 503. Adjust `MAX_CONCURRENT_SETTLEMENTS` in `.env` if needed.

## 10. Architecture overview

### Component real vs mocked matrix

| Component | Live tests | Unit / integration tests |
|-----------|-----------|--------------------------|
| 1CS Quote API (`/v0/quote`) | **Real** — calls live API | Mocked via `QuoteFn` |
| 1CS Deposit Notify (`/v0/deposit/submit`) | **Mocked** via `DepositNotifyFn` | Mocked via `DepositNotifyFn` |
| 1CS Status Polling (`/v0/status`) | **Mocked** via `StatusPollFn` | Mocked via `StatusPollFn` |
| EVM RPC (Base) | **Mocked** via `ChainReader` | Mocked via `ChainReader` |
| On-chain broadcast | **Mocked** via `BroadcastFn` | Mocked via `BroadcastFn` |
| EIP-712 signatures | **Real** (`ethers.Wallet`) | **Real** (`ethers.Wallet`) |
| State store | `InMemoryStateStore` | `InMemoryStateStore` |
| Express HTTP | **Real** (supertest + live `X402Client`) | **Real** (supertest) |
| Client library (`src/client/`) | **Real** — `payAndFetch()` in live test #8 | Tests against real Express with mocked deps |
| Rate limiter | **Real** (integrated in middleware) | **Real** (23 dedicated tests) |

### Project structure

See **[README.md § Project structure](../README.md#project-structure)** for the canonical file map. Keeping it in one place prevents drift — previous copies of the tree under `docs/` and `CLAUDE.local.md` were all stale by at least four new source files.

## 11. Cost estimate for a test

For a minimal test with `MERCHANT_AMOUNT_OUT=1000000` (1 USDC):

- **Buyer pays**: ~1.05 USDC (the extra covers 1CS fees + slippage buffer; any excess is refunded to the gateway refund address)
- **Facilitator pays**: ~0.0001 ETH gas (~$0.02 at typical Base gas prices)
- **Merchant receives**: 1 USDC (as USDC on NEAR)

Total cost: roughly **$1.10** per test.
