# x402-1CS Gateway — Test Results Report

**Date:** 2026-04-21
**Vitest version:** 2.1.9
**Node environment:** node
**Platform:** macOS (Darwin 24.5.0)

---

## 1. Mocked Test Suite (Unit + Integration)

**Result: 438 passed | 0 failed | 17 skipped (live-only)**
**Duration: ~2.0s total**

| File | Tests | Duration | Description |
|------|------:|----------|-------------|
| `src/store.test.ts` | 61 | 238ms | InMemoryStateStore CRUD, concurrency, TTL, listByPhase, `listExpired` phase-filter |
| `src/settler.test.ts` | 45 | 610ms | Broadcast, polling, settlement, timeout, deposit-notify, **recovery** |
| `src/verifier.test.ts` | 34 | 394ms | EIP-712 signature verification (EIP-3009 + Permit2) |
| `src/quote-engine.test.ts` | 40 | 43ms | 1CS quote translation to x402 PaymentRequirements, recipient/asset diagnosis, error-context threading |
| `src/ownership-proof.test.ts` | 28 | 99ms | x402scan canonical message, URL normalisation, EIP-191 sign/recover round-trip, startup validation |
| `src/config.test.ts` | 27 | 65ms | Zod schema validation, env var parsing, CORS allowlist parsing, recipient-format warnings, discovery env vars |
| `src/rate-limiter.test.ts` | 25 | 237ms | Per-IP quote rate limiting, settlement limiter, quote GC (never deletes in-flight) |
| `src/openapi.test.ts` | 24 | 33ms | OpenAPI 3.1 document structure, `x-payment-info`, `x-discovery`, x402 security scheme, per-operation responses |
| `src/types.test.ts` | 22 | 11ms | Type guards, CAIP-2 parsing, error classes |
| `src/protected-routes.test.ts` | 21 | 22ms | Route shape validation, pricing modes, factory binding, invocability invariants |
| `src/middleware.test.ts` | 19 | 315ms | Express middleware request/response handling + client-facing error sanitization + correlation IDs + server-side context logging |
| `src/client/x402-client.test.ts` | 18 | 438ms | Full x402 client protocol against mocked gateway |
| `src/discovery.test.ts` | 14 | 26ms | `/.well-known/x402` document shape, absolute URL joining, proof filtering |
| `src/e2e.test.ts` | 14 | 422ms | HTTP protocol compliance (402 -> sign -> 200) |
| `src/mocks/integration.test.ts` | 14 | 356ms | Multi-chain parametrized flow (NEAR, Arbitrum, Ethereum, Polygon, Stellar, Solana) |
| `src/client/signer.test.ts` | 12 | 25ms | EIP-3009 and Permit2 signing, chain ID extraction |
| `src/provider-pool.test.ts` | 11 | 29ms | RPC provider rotation and failover |
| `src/server.test.ts` | 9 | 41ms | CORS preflight, header exposure, origin allowlist enforcement, discovery endpoints (well-known + OpenAPI) |

### Performance Notes

- Total collection time: ~10s (TypeScript transform + module resolution)
- Actual test execution: ~2.4s for 438 tests (~5.5ms per test average)
- Slowest file: `src/settler.test.ts` (610ms) — includes recovery tests with async background tasks
- All tests run in-process with mocked external dependencies (no network, no RPC)

---

## 2. Live 1CS API Test Suite

**Result: 17 passed | 0 failed**
**Duration: 71.34s total (70.69s test execution)**
**API endpoint:** `https://1click.chaindefuser.com`

| # | Test | Duration | Description |
|---|------|----------|-------------|
| 1 | Authentication | 3,365ms | JWT accepted, dry quote returned |
| 2 | Dry quote structure | 3,171ms | EXACT_OUTPUT dry quote has all expected fields |
| 3 | Real quote (non-dry) | 3,163ms | Non-dry quote returns a deposit address |
| 4 | Quote pricing sanity | 3,294ms | USDC-to-USDC swap fees < 5% |
| 5 | Gateway 402 flow | 3,260ms | Real 1CS quote produces valid 402 response |
| 6 | Deposit address uniqueness | 6,451ms | Two sequential quotes yield different deposit addresses |
| 7 | Full 402 -> sign -> settle (supertest) | 17,223ms | Complete flow using supertest + mock signers |
| 8 | X402Client.payAndFetch (client library) | 17,328ms | Complete flow using `X402Client` class |
| 9 | Small amount (0.01 USDC) | 3,338ms | 10,000 units (6 decimals) |
| 10 | Large amount (100 USDC) | 3,223ms | 100,000,000 units (6 decimals) |
| 11 | State store persistence | 3,220ms | Real 1CS quote stored and retrievable |
| 12 | Concurrent quotes | 3,254ms | 3 parallel quote requests succeed |

### Performance Analysis

| Metric | Value |
|--------|-------|
| **Average 1CS API latency** | ~3.2s per quote request |
| **Full settlement flow** | ~17.3s (quote + sign + broadcast + poll) |
| **Concurrent quote throughput** | 3 requests in 3.3s (batched, not 3x serial) |
| **Deposit address generation** | 2 unique addresses in 6.5s (~3.2s each) |

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
| Unit + Integration (mocked) | 438 | 100% | ~2.4s |
| Live 1CS API | 17 | 100% | ~71s |
| **Total** | **455** | **100%** | **~73s** |

### Test distribution by module

| Module | Mocked Tests | Live Tests | Total |
|--------|------------:|----------:|------:|
| State store | 61 | 1 | 62 |
| Settler | 45 | 2 | 47 |
| Quote engine | 40 | 6 | 46 |
| Verifier | 34 | 0 | 34 |
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
| Error handling | 0 | 2 | 2 |
| Amount sizing | 0 | 2 | 2 |
| Concurrency | 0 | 1 | 1 |
| Authentication | 0 | 1 | 1 |
| Deposit uniqueness | 0 | 1 | 1 |

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
