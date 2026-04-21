# x402-1CS Gateway — Test Results Report

**Date:** 2026-04-21 (updated after Tranche E — test-suite cleanup)
**Vitest version:** 2.1.9
**Node environment:** node
**Platform:** macOS (Darwin 24.5.0)

---

## 1. Mocked Test Suite (Unit + Integration)

**Result: 467 passed | 0 failed | 11 skipped (live-only)**
**Duration: ~2.5s total**

| File | Tests | Duration | Description |
|------|------:|----------|-------------|
| `src/store.test.ts` | 61 | 329ms | InMemoryStateStore CRUD, concurrency, TTL, listByPhase, `listExpired` phase-filter |
| `src/settler.test.ts` | 45 | 244ms | Broadcast, polling, settlement, timeout, deposit-notify, **recovery** (deterministic via `tasks[]` — no real-timer sleeps) |
| `src/quote-engine.test.ts` | 40 | 21ms | 1CS quote translation to x402 PaymentRequirements, recipient/asset diagnosis, error-context threading |
| `src/verifier.test.ts` | 34 | 202ms | EIP-712 signature verification (EIP-3009 + Permit2) |
| `src/chain-prefixes.test.ts` | 29 | 8ms | NEP-141 chain prefix extraction, NEAR account format (implicit + named), OMFT vs NEAR-native, list invariants |
| `src/ownership-proof.test.ts` | 28 | 60ms | x402scan canonical message, URL normalisation, EIP-191 sign/recover round-trip, startup validation |
| `src/config.test.ts` | 27 | 53ms | Zod schema validation, env var parsing, CORS allowlist parsing, recipient-format warnings, discovery env vars |
| `src/rate-limiter.test.ts` | 25 | 149ms | Per-IP quote rate limiting, settlement limiter, quote GC (never deletes in-flight) |
| `src/openapi.test.ts` | 24 | 48ms | OpenAPI 3.1 document structure, `x-payment-info`, `x-discovery`, x402 security scheme, per-operation responses |
| `src/types.test.ts` | 22 | 32ms | Type guards, CAIP-2 parsing, error classes |
| `src/protected-routes.test.ts` | 21 | 17ms | Route shape validation, pricing modes, factory binding, invocability invariants |
| `src/middleware.test.ts` | 19 | 156ms | Express middleware request/response handling + client-facing error sanitization + correlation IDs + server-side context logging |
| `src/client/x402-client.test.ts` | 18 | 220ms | Full x402 client protocol against mocked gateway |
| `src/discovery.test.ts` | 14 | 68ms | `/.well-known/x402` document shape, absolute URL joining, proof filtering |
| `src/e2e.test.ts` | 14 | 239ms | HTTP protocol compliance (402 -> sign -> 200) |
| `src/mocks/integration.test.ts` | 14 | 161ms | Multi-chain parametrized flow (NEAR, Arbitrum, Ethereum, Polygon, Stellar, Solana) |
| `src/client/signer.test.ts` | 12 | 37ms | EIP-3009 and Permit2 signing, chain ID extraction |
| `src/provider-pool.test.ts` | 11 | 26ms | RPC provider rotation and failover |
| `src/server.test.ts` | 9 | 62ms | CORS preflight, header exposure, origin allowlist enforcement, discovery endpoints (well-known + OpenAPI) |

### Performance Notes

- Total collection time: ~13s (TypeScript transform + module resolution)
- Actual test execution: ~2.5s for 467 tests (~5.3ms per test average)
- Slowest file: `src/store.test.ts` (329ms) — SQLite init dominates. `src/settler.test.ts` dropped from ~610ms to 244ms after Tranche E removed two `setTimeout(r, 200)` real-timer sleeps in favour of awaiting `recoverInFlightSettlements`'s returned `tasks[]` directly.
- All tests run in-process with mocked external dependencies (no network, no RPC)

---

## 2. Live 1CS API Test Suite

**Result: 11 passed | 0 failed**
**Duration: 48.36s total (47.79s test execution)**
**API endpoint:** `https://1click.chaindefuser.com`

Tranche E trimmed this suite from 17 → 11 tests. The six deletions either duplicated mocked coverage or exercised 1CS-side invariants that were not gateway behaviour — see "What was removed (Tranche E)" below.

| # | Test | Duration | Description |
|---|------|----------|-------------|
| 1 | Authentication | ~3.3s | JWT accepted, dry quote returned |
| 2 | Dry quote structure | ~3.1s | EXACT_OUTPUT dry quote has all expected fields |
| 3 | Real quote (non-dry) | ~3.2s | Non-dry quote returns a deposit address |
| 4 | Invalid origin asset rejected | ~3.2s | 1CS 400 maps through the gateway to 503 |
| 5 | Expired deadline rejected | ~3.2s | Gateway refuses quotes with too-short deadline |
| 6 | Gateway 402 flow with real 1CS quote | ~3.2s | Full 402 envelope assembled from live quote |
| 7 | Full 402 → sign → settle (supertest) | ~17.2s | Complete flow using supertest + mocked broadcast |
| 8 | X402Client.payAndFetch (client library) | ~17.4s | Complete flow using `X402Client` class |
| 9 | Maps 1CS 401 to gateway 503 | ~3.2s | Bad JWT surfaces as `AUTHENTICATION_ERROR` |
| 10 | Maps 1CS 400 to gateway 503 | ~3.2s | Bad asset surfaces as `QUOTE_UNAVAILABLE` |
| 11 | Status endpoint reachability | ~3.2s | `/v0/status/{addr}` responds (200 or 404) |

### Performance Analysis

| Metric | Value |
|--------|-------|
| **Average 1CS API latency** | ~3.2s per quote request |
| **Full settlement flow** | ~17.3s (quote + sign + mocked broadcast + mocked poll) |
| **Live-suite runtime** | 48s (down from 71s before Tranche E trim) |

### What was removed (Tranche E)

Six tests were deleted from the live suite because they added no confidence that the mocked suite doesn't already provide:

- **Quote pricing sanity (`< 5%` fee check)** — exercises 1CS pricing math, not gateway code.
- **Deposit-address uniqueness across two sequential quotes** — a 1CS invariant, not ours.
- **Small amount / large amount (0.01 / 100 USDC)** — covered by `mapToPaymentRequirements` unit tests.
- **State-store persistence of real 1CS quote response** — covered by `store.test.ts` + `middleware.test.ts` at the shape level; live-calling 1CS to re-assert the same fields added cost without confidence.
- **3 concurrent quote requests** — tests 1CS-side concurrency, not gateway behaviour.

### What the live tests cover

- **Real 1CS API calls**: Authentication, quoting (dry + non-dry), deposit address generation
- **Real EIP-712 signing**: Buyer wallet produces actual cryptographic signatures
- **Real header encoding**: Client and gateway encode/decode x402 headers via `@x402/core/http`
- **Mocked on-chain broadcast**: Transaction broadcast is stubbed (no real ETH spent)
- **Mocked 1CS polling**: Settlement polling returns mock SUCCESS sequence (no real swap executed)

### What is NOT tested live

- Actual on-chain token transfers (would require funded wallets)
- Real 1CS swap execution and settlement (would require real deposits)
- Production RPC provider failover under load

---

## 3. Test Coverage Summary

| Category | Tests | Pass Rate | Execution Time |
|----------|------:|----------:|---------------:|
| Unit + Integration (mocked) | 467 | 100% | ~2.5s |
| Live 1CS API | 11 | 100% | ~48s |
| **Total** | **478** | **100%** | **~51s** |

### Test distribution by module

| Module | Mocked Tests | Live Tests | Total |
|--------|------------:|----------:|------:|
| State store | 61 | 0 | 61 |
| Settler | 45 | 2 | 47 |
| Quote engine | 40 | 4 | 44 |
| Verifier | 34 | 0 | 34 |
| Chain prefixes | 29 | 0 | 29 |
| Ownership proof | 28 | 0 | 28 |
| Config | 27 | 0 | 27 |
| Rate limiter | 25 | 0 | 25 |
| OpenAPI builder | 24 | 0 | 24 |
| Types | 22 | 0 | 22 |
| Protected routes | 21 | 0 | 21 |
| Middleware | 19 | 0 | 19 |
| Client (x402-client) | 18 | 1 | 19 |
| Discovery builder | 14 | 0 | 14 |
| E2E protocol | 14 | 0 | 14 |
| Mock integration | 14 | 0 | 14 |
| Client (signer) | 12 | 0 | 12 |
| Provider pool | 11 | 0 | 11 |
| Server (CORS + helmet + discovery) | 9 | 0 | 9 |
| Authentication | 0 | 1 | 1 |
| Status endpoint | 0 | 1 | 1 |
| Error handling (1CS mapping) | 0 | 2 | 2 |

---

## 4. How to Reproduce

```bash
# Mocked tests (no API key needed)
npm test

# Live tests (requires .env.test with ONE_CLICK_JWT)
set -a && source .env.test && set +a && npm run test:live

# TypeScript compilation check
npx tsc --noEmit
```
