# x402-1CS Gateway — Test Results Report

**Date:** 2026-04-14
**Vitest version:** 2.1.9
**Node environment:** node
**Platform:** macOS (Darwin 24.5.0)

---

## 1. Mocked Test Suite (Unit + Integration)

**Result: 278 passed | 0 failed | 17 skipped (live-only)**
**Duration: ~1.7s total**

| File | Tests | Duration | Description |
|------|------:|----------|-------------|
| `src/store.test.ts` | 49 | 193ms | InMemoryStateStore CRUD, concurrency, TTL |
| `src/verifier.test.ts` | 34 | 350ms | EIP-712 signature verification (EIP-3009 + Permit2) |
| `src/settler.test.ts` | 33 | 136ms | Broadcast, polling, settlement, timeout, deposit-notify logging |
| `src/quote-engine.test.ts` | 26 | 10ms | 1CS quote translation to x402 PaymentRequirements |
| `src/rate-limiter.test.ts` | 23 | 150ms | Per-IP quote rate limiting, settlement limiter, quote GC |
| `src/types.test.ts` | 22 | 8ms | Type guards, CAIP-2 parsing, error classes |
| `src/client/x402-client.test.ts` | 18 | 220ms | Full x402 client protocol against mocked gateway |
| `src/e2e.test.ts` | 14 | 236ms | HTTP protocol compliance (402 -> sign -> 200) |
| `src/mocks/integration.test.ts` | 14 | 167ms | Multi-chain parametrized flow (NEAR, Arbitrum, Ethereum, Polygon, Stellar, Solana) |
| `src/middleware.test.ts` | 12 | 90ms | Express middleware request/response handling |
| `src/client/signer.test.ts` | 12 | 46ms | EIP-3009 and Permit2 signing, chain ID extraction |
| `src/provider-pool.test.ts` | 11 | 30ms | RPC provider rotation and failover |
| `src/config.test.ts` | 10 | 10ms | Zod schema validation, env var parsing |

### Performance Notes

- Total collection time: ~9s (TypeScript transform + module resolution)
- Actual test execution: ~1.5s for 278 tests (~5.4ms per test average)
- Slowest file: `src/verifier.test.ts` (422ms) — involves EIP-712 cryptographic signature verification
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
| Unit + Integration (mocked) | 278 | 100% | ~1.5s |
| Live 1CS API | 17 | 100% | ~71s |
| **Total** | **295** | **100%** | **~72s** |

### Test distribution by module

| Module | Mocked Tests | Live Tests | Total |
|--------|------------:|----------:|------:|
| State store | 49 | 1 | 50 |
| Verifier | 34 | 0 | 34 |
| Settler | 33 | 2 | 35 |
| Quote engine | 26 | 6 | 32 |
| Rate limiter | 23 | 0 | 23 |
| Types | 22 | 0 | 22 |
| Client (x402-client) | 18 | 1 | 19 |
| E2E protocol | 14 | 0 | 14 |
| Middleware | 12 | 0 | 12 |
| Client (signer) | 12 | 0 | 12 |
| Provider pool | 11 | 0 | 11 |
| Config | 10 | 0 | 10 |
| Mock integration | 14 | 0 | 14 |
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
