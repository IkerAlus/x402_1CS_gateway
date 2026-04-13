# x402-1CS Gateway — Production Readiness TODO

**Date:** 2026-04-13
**Based on:** Full codebase audit + 295 passing tests (278 mocked + 17 live) + typecheck clean
**Target:** Prototype deployment for a small number of users

---

## Current Status

| Area | Status |
|------|--------|
| Core protocol (402 → sign → settle) | Working (live-verified on Base mainnet) |
| EIP-3009 / Permit2 signing & verification | Working |
| 1CS integration (quote, deposit, poll) | Working |
| Multi-chain destinations (32+ chains, EVM + non-EVM) | Working |
| Rate limiting (per-IP + settlement cap + GC) | Working |
| RPC provider pool with failover | Working |
| HTTP server timeouts (broadcast + polling budget) | Working |
| Manual receipt polling (resilient to ethers `tx.wait()` stalls) | Working |
| TypeScript compilation | Clean |
| Test suite (295 tests) | 100% pass |
| ESLint | 0 errors, 46 pre-existing warnings (intentional `no-console` + unused imports in tests) |

---

## Recently Completed (since 2026-04-02)

- **Chain agnosticism** — `NEP141_CHAIN_PREFIX_MAP` expanded from 8 to 30+ chains (EVM + Stellar/Solana/Bitcoin/etc.); unknown prefixes now return raw prefix string instead of defaulting to `"near"`.
- **Non-EVM recipient validation** — `validateRecipientFormat()` in `config.ts` now detects non-EVM destinations and warns about format mismatches.
- **Server timeout fix** — Set `headersTimeout`/`requestTimeout`/`setTimeout` tied to `cfg.maxPollTimeMs + 120s`; fixes mid-settlement socket drops (`SocketError: other side closed`).
- **Manual receipt polling** — Replaced ethers `tx.wait()` with `waitForReceipt()` polling `getTransactionReceipt` every 2s. Resolves hangs on L2 RPCs where ethers v6 block-subscription stalls.
- **Broadcast timeout** — Bumped from 30s → 60s default; made configurable via `SettlerOptions.broadcastTimeoutMs`.
- **Error handlers** — `unhandledRejection` logs; `uncaughtException` uses delayed exit (`setTimeout(..., 5000).unref()`) so in-flight settlements can finish.
- **Trust proxy + body limit** — `app.set("trust proxy", 1)` + `express.json({ limit: "1mb" })`.
- **Deposit-notify logging** — Catch block now actually emits `console.warn` with deposit address + tx hash.

---

## BLOCKERS — Must fix before any real user touches it

### 1. Add HTTPS / TLS termination

**Risk:** Payment signatures (`PAYMENT-SIGNATURE` header) travel in plaintext over HTTP. Any network observer can intercept and replay them.

**Fix:** Terminate TLS via one of:
- Reverse proxy (nginx, Caddy, Cloudflare Tunnel) — recommended
- Node.js `https` module with a cert

**Files:** Infrastructure-level (nginx/Caddy), or `src/server.ts` if self-hosted TLS.

---

### 2. Add security headers and CORS

**Risk:** No `helmet` (missing X-Frame-Options, X-Content-Type-Options, CSP, etc.). No CORS policy — browser-based clients from different origins are blocked.

**Fix:**
```bash
npm install helmet cors
```
```typescript
import helmet from "helmet";
import cors from "cors";
app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(",") ?? "*" }));
```

**Files:** `src/server.ts`, `package.json`, `.env.example` (add `ALLOWED_ORIGINS`).

---

### 3. Enable file-based state persistence

**Risk:** The default `SqliteStateStore` runs in-memory (see `src/server.ts:48`). A crash or deploy wipes all swap states. Any settlement in `BROADCASTING` or `POLLING` phase is irrecoverable — the buyer's on-chain transfer happened but the gateway forgot about it.

**Fix:**
- Add `STORE_FILE_PATH` and `STORE_SAVE_INTERVAL_MS` env vars to `config.ts`
- Pass them to `SqliteStateStore` constructor in `server.ts`
- Document in `.env.example` and deployment guide

**Files:** `src/config.ts`, `src/server.ts`, `.env.example`.

---

### 4. Recover in-flight settlements on restart

**Risk:** Even with file persistence (#3), if the process restarts while a settlement is in `POLLING`, nobody resumes polling 1CS. The swap may complete on the 1CS side but the gateway never learns the result. Buyer funds stuck.

**Fix:** On startup, scan the store for non-terminal phases (`BROADCASTING`, `BROADCAST`, `POLLING`) and either:
- Resume polling for each (preferred)
- Mark them `FAILED` and log for manual operator intervention

**File:** `src/server.ts` (new startup recovery step), `src/settler.ts` (expose resume helper).

---

### 5. Graceful shutdown — wait for in-flight settlements

**Risk:** Current shutdown (`src/server.ts:172-196`) calls `server.close()` then `process.exit(0)` after a 1-second grace period. If a settlement is in `POLLING` (can take up to 5 min), the Node.js process exits mid-way, corrupting state. Buyer paid but merchant never received.

**Current code:**
```typescript
server.close();
// ...cleanup...
setTimeout(() => process.exit(0), 1000).unref();
```

**Fix:** Track in-flight settlement count (via `SettlementLimiter.active()` or dedicated counter). On SIGTERM:
1. Stop accepting new requests (`server.close()` — already done)
2. Poll the in-flight count; wait up to 30s for it to reach zero
3. Then run cleanup + exit

**File:** `src/server.ts:172-196`, possibly `src/rate-limiter.ts` (expose active count).

---

## STRONGLY RECOMMENDED — Important for a stable prototype

### 6. Validate RPC reachability at startup

**Current:** If all RPC URLs are unreachable, the server starts fine but every settlement fails at broadcast time. There's a facilitator balance check (`src/server.ts:62-79`) but it's non-blocking — only logs a warning.

**Fix:** On startup, call `eth_blockNumber` on the primary RPC. If all configured RPCs fail, refuse to start (fail-fast).

**File:** `src/server.ts` (startup checks using `providerPool`).

---

### 7. Check 1CS JWT expiry at startup

**Current:** If the JWT expires, every quote request fails with 401 and there's no warning.

**Fix:** Decode the JWT payload (base64 decode), extract `exp`:
- Log the expiry date at startup
- Warn if < 7 days remaining
- Fail fast if already expired

**File:** `src/server.ts` (startup checks).

---

### 8. Add structured logging

**Current:** All logging is bare `console.log`/`console.warn` — no timestamps, no correlation IDs, no JSON format. The `no-console` ESLint warnings flag 22 occurrences in `server.ts` alone.

**Impact:** Debugging a failed settlement requires grepping by deposit address.

**Fix:**
- Minimum: add `[timestamp] [depositAddress] [phase]` prefix to every state transition log.
- Better: adopt `pino` for JSON output with per-request correlation IDs.

**Files:** `src/settler.ts`, `src/middleware.ts`, `src/quote-engine.ts`, `src/server.ts`.

---

### 9. Add gateway authentication

**Current:** Anyone who discovers the gateway URL can trigger 402 flows, consuming 1CS quotes (rate-limited by your JWT).

**Fix:** Add an API key middleware or IP allowlist. Options:
- `X-API-Key` header checked against an env var (simplest)
- Mutual TLS (mTLS)
- IP allowlist

**File:** `src/server.ts` (new middleware before routes).

---

### 10. Test coverage for recent additions

**Current gaps:**
- `waitForReceipt()` in `src/settler.ts` is not exported and has no direct tests. Needs: timeout after `maxAttempts`, reverted receipt (`status === 0`), provider error during polling.
- `validateRecipientFormat()` in `src/config.ts` has zero direct tests (~15 scenarios missing: EVM/non-EVM/NEAR recipient pairings, unknown chain prefix, etc.).
- `SettlerOptions.broadcastTimeoutMs` is not covered by `settler.test.ts`.
- `ChainReader` RPC timeout during `verifyPayment` — no test simulates RPC failure.

**Files:** `src/settler.test.ts`, `src/config.test.ts`, `src/verifier.test.ts`.

---

## NICE-TO-HAVE — Production hardening

### 11. Prometheus `/metrics` endpoint

Expose settlement-latency histograms, error-rate counters, 1CS quote success rates, and active-settlement gauges for monitoring dashboards.

### 12. Circuit breaker for RPC failures

Currently retries the RPC rotation blindly. A circuit breaker (e.g., `cockatiel`, `opossum`) would back off after N consecutive failures instead of hammering a dead RPC.

### 13. Automatic buyer refund on 1CS failure

When 1CS reports `FAILED` after the on-chain `transferWithAuthorization` succeeded, the buyer's USDC is at the 1CS deposit address. Currently, refunds go to `GATEWAY_REFUND_ADDRESS` and the operator must manually return funds. Automate this path.

### 14. Request correlation IDs

Generate a unique ID per request (`X-Request-Id` header), propagate through all logs and state transitions. Essential for distributed tracing.

### 15. Replace `sql.js` with `better-sqlite3`

`sql.js` is pure-JS SQLite (slower, larger memory footprint). `better-sqlite3` is a native binding — synchronous, faster, battle-tested for Node.js server workloads.

### 16. Key rotation without restart

Currently, changing the facilitator private key requires a full service restart. Add a SIGHUP handler or admin endpoint that reloads the key from the secrets manager.

### 17. Health endpoint authentication

`/health` currently exposes in-flight settlement count, rate-limiter state, and provider health to anyone. Consider requiring an API key or restricting access by IP.

### 18. Lint cleanup

46 ESLint warnings — mostly intentional `no-console` in `server.ts` (22) and unused test imports (14). Fix the unused-import warnings in a single cleanup pass (they're easy wins). Leave the `no-console` warnings — they're intentional until structured logging (#8) lands.

---

## Priority Roadmap

```
Phase 1 — Go-live minimum (blockers 1-5)
  ├── #2  Helmet + CORS             (~15 min)
  ├── #1  TLS termination           (~30 min, infra)
  ├── #3  File-based persistence    (~30 min)
  ├── #5  Graceful shutdown (wait)  (~1-2 hrs)
  └── #4  In-flight recovery        (~2-3 hrs)

Phase 2 — Stable prototype (items 6-10)
  ├── #6  RPC startup validation    (~20 min)
  ├── #7  JWT expiry check          (~20 min)
  ├── #9  Gateway authentication    (~1 hr)
  ├── #10 Test coverage for new code (~2 hrs)
  └── #8  Structured logging        (~2 hrs)

Phase 3 — Production hardening (items 11-18)
  └── As needed based on scale and operational experience
```

---

## Reference

| Document | Path |
|----------|------|
| Deployment Guide | `docs/DEPLOYMENT_GUIDE.md` |
| User Guide | `docs/USER_GUIDE.md` |
| Test Results | `docs/TEST_RESULTS.md` |
| Facilitator Key Guidance | `docs/Facilitator_keys_guidance.md` |
