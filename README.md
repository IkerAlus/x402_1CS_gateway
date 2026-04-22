# x402_1CS_gateway
x402-1CS Gateway is an Express server that implements the x402 HTTP payment protocol, translating standard x402 "pay for a resource" flows into cross-chain swaps via the NEAR Intents 1Click Swap API. A buyer on an EVM chain (Base) pays USDC, the gateway handles signature verification, on-chain broadcast, and 1CS swap orchestration, and the merchant receives the required amount on any of the 32+ destination chains supported by the 1CS API (EVM chains, NEAR, Solana, Stellar, Bitcoin, and more).

Token flow: Buyer → 1CS Deposit Address → cross-chain swap → Merchant

## ⚠️ WARNING ⚠️
This is project is in alpha state. Check the [TODO](docs/TODO.md) list for what is still missing to be a live service with real usage.

## Project structure

```
x402_1CS_gateway/
├── src/
│   ├── server.ts              # HTTP entry point
│   ├── config.ts              # Zod-validated env config
│   ├── cors-options.ts        # CORS options builder (helmet+cors wired in server.ts)
│   ├── middleware.ts           # Express x402 middleware
│   ├── quote-engine.ts        # 1CS quote building + diagnoseQuoteRequest
│   ├── verifier.ts            # EIP-3009/Permit2 signature verification
│   ├── settler.ts             # Broadcast, deposit notify, status polling
│   ├── store.ts               # State store (SQLite / in-memory)
│   ├── provider-pool.ts       # RPC endpoint pool with failover
│   ├── rate-limiter.ts        # Per-IP rate limiting, settlement cap, quote GC
│   ├── chain-prefixes.ts      # Shared NEP-141 chain metadata + helpers
│   ├── protected-routes.ts    # Registry of paid routes (single source of truth)
│   ├── discovery.ts           # /.well-known/x402 document builder
│   ├── openapi.ts             # /openapi.json document builder
│   ├── ownership-proof.ts     # x402scan ownership-proof canonical message + EIP-191 helpers
│   ├── types.ts               # Shared type definitions (including ErrorContext)
│   ├── index.ts               # Library entry point
│   ├── server.test.ts         # CORS + helmet + discovery endpoint tests (9)
│   ├── client/                # Buyer-side client library
│   │   ├── index.ts           #    Public API re-exports
│   │   ├── types.ts           #    Client-side type definitions
│   │   ├── signer.ts          #    EIP-3009 & Permit2 signing
│   │   ├── x402-client.ts     #    X402Client class
│   │   ├── signer.test.ts     #    Signing tests (12)
│   │   └── x402-client.test.ts#    Client integration tests (18)
│   ├── mocks/                 # Shared test mocks
│   └── *.test.ts              # Unit & integration tests
├── scripts/
│   ├── test-client.ts                   # CLI test client (dry-run / live)
│   ├── verify-api-key.ts                # 1CS JWT verification
│   ├── generate-ownership-proof.ts      # x402scan ownership-proof signer CLI
│   └── test-1cs-quote.sh                # Shell script for raw quote testing
├── docs/
│   ├── TODO.md                # Production-readiness checklist
│   ├── DEPLOYMENT_GUIDE.md    # Deployment and production setup
│   ├── USER_GUIDE.md          # Buyer-facing usage guide
│   ├── X402SCAN.md            # x402scan registration guide
│   ├── X402SCAN_PLAN.md       # x402scan integration design notes
│   ├── Facilitator_keys_guidance.md  # Facilitator key management guide
│   ├── TEST_RESULTS.md        # Latest test run results
│   ├── verifier-flow.svg
├── .env.example               # Environment variable template
├── .env.stellar               # Pre-filled config for Stellar merchant destination
├── vitest.config.ts           # Test runner configuration
├── tsconfig.json              # TypeScript configuration
└── package.json
```

---

## Prerequisites

- **Node.js >= 20** and npm
- **A 1CS JWT token** — request one at https://docs.near-intents.org (needed for non-dry quotes with deposit addresses)
- For full payment testing:
  - A **buyer wallet** funded with USDC on Base
  - A **facilitator wallet** funded with ETH on Base (for gas)

## 1. Install dependencies

```bash
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
| `MERCHANT_RECIPIENT` | NEAR account or EVM address | `merchant.near` or `0x1234...abcd` |
| `MERCHANT_ASSET_OUT` | NEP-141 asset ID | `nep141:17208628f84f5...` (NEAR) or `nep141:arb-0xaf88...omft.near` (Arbitrum) |
| `MERCHANT_AMOUNT_OUT` | Integer (smallest unit) | `1000000` (= 1 USDC) |
| `ORIGIN_NETWORK` | CAIP-2 string | `eip155:8453` |
| `ORIGIN_ASSET_IN` | NEP-141 asset ID | `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near` |
| `ORIGIN_TOKEN_ADDRESS` | EVM address (0x + 40 hex) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| `ORIGIN_RPC_URLS` | Comma-separated URLs | `https://mainnet.base.org` |
| `FACILITATOR_PRIVATE_KEY` | EVM private key (0x + 64 hex) | `0x59c6995e998f97a5a...` |
| `GATEWAY_REFUND_ADDRESS` | EVM address (0x + 40 hex) | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` |

### Optional fields

| Field | Format | Default | Notes |
|-------|--------|---------|-------|
| `ALLOWED_ORIGINS` | Comma-separated origins | unset (reflects any origin) | CORS allowlist. Required when a browser-based x402 client needs to read `PAYMENT-REQUIRED` / `PAYMENT-RESPONSE`. Example: `https://buyer.example.com,https://app.example.com`. |

All other tuning knobs (rate limits, poll intervals, token metadata, etc.) have safe defaults; see `.env.example` for the full list.

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
MERCHANT_ASSET_OUT=destination-asset-id-near-intents-format
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
Note: The facilitator handle private keys that authorize moving funds of users. Check in detail the [Facilitator Key Management Guide](docs/Facilitator_keys_guidance.md) beforehand.

### Critical note: asset ID formats

The 1CS API uses the `nep141:` prefix format for all assets. The origin asset ID is:

**USDC on Base (origin — what the buyer pays)**:
```
nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near
```

The old `base:0x...` and `near:nUSDC` formats are **not accepted** by the 1CS API. You can verify the correct IDs by calling `GET https://1click.chaindefuser.com/v0/tokens` and searching for USDC, or running:

```bash
chmod +x scripts/test-1cs-quote.sh
./scripts/test-1cs-quote.sh
```

### Merchant destination chains

The merchant can receive on **any of the 32+ chains supported by the 1CS API**, including EVM chains (Ethereum, Arbitrum, Polygon, etc.), NEAR, and non-EVM chains (Solana, Stellar, Bitcoin, TON, and more). The destination is configured via `MERCHANT_RECIPIENT` and `MERCHANT_ASSET_OUT`. The recipient format must match the destination chain.

For the full list of supported chains and assets, see: https://docs.near-intents.org/resources/asset-support

**EVM destination examples:**

| Destination | `MERCHANT_RECIPIENT` | `MERCHANT_ASSET_OUT` |
|-------------|---------------------|---------------------|
| **Ethereum** | `0xYourEthAddress` | `nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near` |
| **Arbitrum** | `0xYourArbAddress` | `nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near` |
| **Polygon** | `0xYourPolyAddress` | `nep141:polygon-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359.omft.near` |
| **Optimism** | `0xYourOpAddress` | `nep141:op-0x0b2c639c533813f4aa9d7837caf62653d097ff85.omft.near` |
| **Avalanche** | `0xYourAvaxAddress` | `nep141:avax-0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e.omft.near` |
| **BSC** | `0xYourBscAddress` | `nep141:bsc-0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d.omft.near` |

**Non-EVM destination examples:**

| Destination | `MERCHANT_RECIPIENT` | `MERCHANT_ASSET_OUT` |
|-------------|---------------------|---------------------|
| **NEAR** | `merchant.near` | `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` |
| **Stellar** | Stellar address (G...) | `nep141:stellar-<token>.omft.near` |
| **Solana** | Solana public key | `nep141:solana-<token>.omft.near` |
| **Bitcoin** | Bitcoin address | `nep141:bitcoin-<token>.omft.near` |

The gateway validates at startup that the recipient format matches the destination chain and warns if there's a mismatch. For chains not yet in the gateway's known chain list, it logs an informational message but still processes swaps normally — the 1CS API handles all cross-chain routing.

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
[x402-1CS] CORS: open (reflect any origin); helmet: enabled

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

3. **Merchant account** — a NEAR account or EVM address (`MERCHANT_RECIPIENT`) that will receive the funds. The format must match the destination chain configured in `MERCHANT_ASSET_OUT`.

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
9. 1CS executes the cross-chain swap (Base USDC → merchant's destination chain)
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

## 8. Discovery (x402scan, /.well-known, OpenAPI)

The gateway exposes three surfaces that discovery crawlers like [x402scan](https://www.x402scan.com/) use to index paid resources:

| Path | Contents |
|---|---|
| `GET /openapi.json` | OpenAPI 3.1 document with `x-payment-info`, `x-discovery.ownershipProofs`, per-route `security: [{x402: []}]` |
| `GET /.well-known/x402` | Fan-out JSON (`version`, `resources[]`, `ownershipProofs[]`) — fallback surface and DNS `_x402` target |
| Every paid route | Runtime x402 `PAYMENT-REQUIRED` envelope (v2) on the 402 response |

Both discovery endpoints are unauthenticated and always served — including during local development — so crawlers can probe them without credentials. A single registry (`src/protected-routes.ts`) drives all three surfaces: add one entry and OpenAPI, `/.well-known/x402`, and the Express mount pick it up automatically.

### Enable discovery

Set two env vars:

```bash
PUBLIC_BASE_URL=https://gateway.example.com
OWNERSHIP_PROOFS=0x...         # generated with scripts/generate-ownership-proof.ts
```

The gateway emits absolute resource URLs and includes your proofs in both documents. See **[docs/X402SCAN.md](./docs/X402SCAN.md)** for the full step-by-step registration guide, including proof generation, multi-key setups, subpath deployments, and a troubleshooting matrix.

### Verify locally

```bash
curl -s http://localhost:3402/.well-known/x402 | jq
curl -s http://localhost:3402/openapi.json | jq '{openapi, info, paths: (.paths|keys)}'
```

## 9. Running the test suite

The project has 466 unit/integration tests plus 11 live API tests (skipped by default). See `docs/TEST_RESULTS.md` for the latest run results.

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

Runs 466 tests across 19 test files with fully mocked external dependencies (a 20th file, `live-1cs.test.ts`, runs only when `ONE_CLICK_JWT` is set). No API key, funds, or network access required. Covers:

- **State store** (61 tests) — CRUD, TTL, concurrency, phase transitions, listByPhase, `listExpired` phase-filter
- **Settler** (45 tests) — broadcast, deposit notification, status polling, timeout, **in-flight recovery** (deterministic via `tasks[]`)
- **Quote engine** (40 tests) — quote building, deadline validation, fee calculation, recipient/asset diagnosis, error-context threading
- **Verifier** (34 tests) — EIP-3009 and Permit2 signature recovery, balance checks, nonce replay, timing
- **Chain prefixes** (29 tests) — NEP-141 chain prefix extraction, NEAR account format (implicit + named), OMFT vs NEAR-native, list invariants
- **Ownership proof** (28 tests) — canonical message, URL normalisation, EIP-191 sign/recover round-trip, startup validation
- **Config** (27 tests) — Zod validation, defaults, environment loading, CORS allowlist parsing, recipient-format warnings, discovery env vars
- **Rate limiter** (25 tests) — per-IP quote limiting, settlement concurrency cap, quote GC (never deletes in-flight)
- **OpenAPI builder** (24 tests) — OpenAPI 3.1 document structure, `x-payment-info`, `x-discovery`, x402 security scheme, per-operation responses
- **Types** (22 tests) — type guards, CAIP-2 parsing, error classes
- **Protected routes registry** (21 tests) — route shape validation, pricing modes, factory binding, invocability invariants
- **Middleware** (19 tests) — Express middleware request/response handling, error mapping, error sanitization + correlation IDs, server-side context logging
- **Client X402Client** (18 tests) — full protocol flow against real Express gateway with mocked chain deps
- **Discovery builder** (14 tests) — `/.well-known/x402` document shape, absolute URL joining, proof filtering
- **E2E** (14 tests) — full gateway HTTP protocol compliance (402 -> sign -> 200)
- **Mock integration** (14 tests) — multi-chain parametrized flow (NEAR, Arbitrum, Ethereum, Polygon, Stellar, Solana)
- **Client signer** (12 tests) — EIP-3009/Permit2 signature round-trips, nonce uniqueness, chain ID parsing
- **Provider pool** (11 tests) — RPC rotation, failover, health checks
- **Server** (9 tests) — CORS preflight, header exposure, origin allowlist enforcement, discovery endpoints (well-known + OpenAPI)

### Live 1CS API tests

```bash
# Option 1: inline env var
ONE_CLICK_JWT="your-jwt" npm run test:live

# Option 2: source the .env.test file (created during setup)
set -a && source .env.test && set +a && npm run test:live
```

Runs 17 tests against the **real 1CS API** (skipped unless `ONE_CLICK_JWT` is set). These tests exercise authentication, dry quotes, real quotes with deposit addresses, pricing sanity checks, error handling, the full gateway 402->sign->settle flow (via supertest), and an end-to-end `X402Client.payAndFetch()` flow — both using real 1CS quotes but mocked on-chain broadcast. No funds are spent — deposit addresses are generated but never funded.

The `.env.test` file (gitignored) stores the JWT so you don't have to paste it every time:

```
ONE_CLICK_JWT=<your JWT>
ONE_CLICK_BASE_URL=https://1click.chaindefuser.com
```

## 10. Troubleshooting

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

### "MERCHANT_RECIPIENT does not look like an EVM address"

This startup warning means `MERCHANT_ASSET_OUT` targets an EVM chain (e.g., Arbitrum, Ethereum) but `MERCHANT_RECIPIENT` is not an EVM address (0x...). Update `MERCHANT_RECIPIENT` to match the destination chain format. Similarly, if you see a warning about an EVM address targeting a non-EVM chain (Stellar, Solana, etc.), make sure the recipient format is correct for that chain. See the "Merchant destination chains" section above.

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

## 11. Architecture overview

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
