# x402-1CS Gateway — Production Readiness TODO

**Date:** 2026-04-02
**Based on:** Full codebase audit + 283 passing tests (266 mocked + 17 live)
**Target:** Prototype deployment for a small number of users

---

## Current Status

| Area | Status |
|------|--------|
| Core protocol (402 → sign → settle) | Working |
| EIP-3009 / Permit2 signing & verification | Working |
| 1CS integration (quote, deposit, poll) | Working |
| Rate limiting (per-IP + settlement cap + GC) | Working |
| RPC provider pool with failover | Working |
| TypeScript compilation | Clean |
| Test suite (283 tests) | 100% pass |
| npm audit (production deps) | No vulnerabilities |

---

## BLOCKERS — Must fix before any real user touches it

### 1. Add HTTPS / TLS termination

**Risk:** Payment signatures (`PAYMENT-SIGNATURE` header) travel in plaintext over HTTP. Any network observer can intercept and replay them.

**Fix:** Terminate TLS via one of:
- Reverse proxy (nginx, Caddy, Cloudflare Tunnel) — recommended
- Node.js `https` module with a cert

**Files:** `src/server.ts`, or infrastructure-level (nginx/Caddy config)

---

### 2. Add request body size limit

**Risk:** `express.json()` at `server.ts:101` accepts unlimited payloads. A single oversized POST can exhaust process memory.

**Fix:**
```typescript
app.use(express.json({ limit: '1mb' }));
```

**File:** `src/server.ts:101`

---

### 3. Add security headers and CORS

**Risk:** No `helmet` (missing X-Frame-Options, X-Content-Type-Options, etc.). No CORS headers — browser-based clients from different origins are blocked.

**Fix:**
```bash
npm install helmet cors
```
```typescript
import helmet from 'helmet';
import cors from 'cors';

app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') }));
```

**File:** `src/server.ts`

---

### 4. Graceful shutdown must wait for in-flight settlements

**Risk:** `server.ts:152-156` calls `process.exit(0)` immediately on SIGTERM. If a settlement is mid-polling (buyer already paid on-chain), the state is lost forever — buyer paid but merchant never received.

**Current code:**
```typescript
const shutdown = () => {
  console.log("\n[x402-1CS] Shutting down...");
  destroyRateLimiting(rateLimiting);
  providerPool.destroy();
  process.exit(0);  // <-- immediate exit, no waiting
};
```

**Fix:** Track in-flight settlement count. On SIGTERM:
1. Stop accepting new requests (close the HTTP server)
2. Wait up to 30s for in-flight settlements to reach a terminal state
3. Then exit

**File:** `src/server.ts:151-159`

---

### 5. Add unhandledRejection / uncaughtException handlers

**Risk:** If any promise rejects outside Express middleware (e.g., in the quote GC background timer or rate limiter sweep), the process crashes silently with no log.

**Fix:**
```typescript
process.on('unhandledRejection', (reason) => {
  console.error('[x402-1CS] Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[x402-1CS] Uncaught exception:', err);
  process.exit(1);
});
```

**File:** `src/server.ts` (top of `main()`)

---

### 6. Enable file-based state persistence

**Risk:** The default `SqliteStateStore` runs in-memory. A crash or deploy wipes all swap states. Any settlement in `BROADCASTING` or `POLLING` phase is irrecoverable — the buyer's on-chain transfer happened but the gateway forgot about it.

**Fix:**
- Add `STORE_FILE_PATH` and `STORE_SAVE_INTERVAL_MS` env vars to `config.ts`
- Pass them to `SqliteStateStore` constructor in `server.ts`
- Document in `.env.example` and deployment guide

**Files:** `src/config.ts`, `src/server.ts`, `.env.example`

---

### 7. Recover in-flight settlements on restart

**Risk:** Even with file persistence, if the process restarts while a settlement is in `POLLING`, nobody resumes polling 1CS. The swap may complete on the 1CS side but the gateway never learns the result. Buyer funds are stuck.

**Fix:** On startup, scan the store for non-terminal states (`BROADCASTING`, `BROADCAST`, `POLLING`) and either:
- Resume polling for each (preferred)
- Mark them `FAILED` and log for manual operator intervention

**File:** `src/server.ts` (new startup recovery step), `src/settler.ts` (expose a resume function)

---

## STRONGLY RECOMMENDED — Important for a stable prototype

### 8. Add structured logging

**Current:** All logging is bare `console.log` — no timestamps, no correlation IDs, no JSON format.

**Impact:** When debugging a failed settlement, you need to grep logs for a deposit address. Currently there's no way to trace a request through its lifecycle.

**Fix:** Add at minimum `[timestamp] [depositAddress] [phase]` to every state transition. Optionally adopt a structured logger (`pino`, `winston`) for JSON output.

**Files:** `src/settler.ts`, `src/middleware.ts`, `src/quote-engine.ts`, `src/server.ts`

---

### 9. Add gateway authentication

**Current:** Anyone who discovers the gateway URL can trigger 402 flows, consuming 1CS quotes (rate-limited by your JWT).

**Fix:** Add an API key middleware or restrict to known client IPs. Options:
- `X-API-Key` header checked against an env var
- Mutual TLS (mTLS)
- IP allowlist

**File:** `src/server.ts` (new middleware before routes)

---

### 10. Add HTTP request timeout

**Current:** No server-level timeout. A slow client can hold a connection open forever, exhausting the connection pool.

**Fix:**
```typescript
const server = app.listen(port, () => { ... });
server.setTimeout(30_000);
```

**File:** `src/server.ts`

---

### 11. Fix IP rate limiting behind proxy

**Current:** `req.ip` returns the proxy's IP when behind nginx/Cloudflare/ALB. All clients appear as one IP, sharing a single rate limit bucket.

**Fix:**
```typescript
app.set('trust proxy', 1);  // trust first proxy hop
```
Or use `X-Forwarded-For` parsing with validation.

**File:** `src/server.ts`

---

### 12. Check 1CS JWT expiry at startup

**Current:** If the JWT expires, every quote request fails with 401 and there's no warning.

**Fix:** Decode the JWT at startup (it's a standard JWT — base64 decode the payload), extract `exp`, and:
- Log the expiry date
- Warn if < 7 days remaining
- Fail fast if already expired

**File:** `src/server.ts` (startup checks)

---

### 13. Log deposit notification failures prominently

**Current:** `settler.ts` calls `depositNotifyFn` and proceeds "optimistically" if it fails. If 1CS never receives the notification, the swap might not process.

**Fix:** Log as `console.warn` or `console.error` with the deposit address, not silently swallow.

**File:** `src/settler.ts` (deposit notify catch block)

---

### 14. Validate RPC reachability at startup

**Current:** If all RPC URLs are unreachable, the server starts fine but every settlement fails at broadcast time.

**Fix:** On startup, call `eth_blockNumber` on the primary RPC. If it fails, try fallbacks. If all fail, refuse to start (fail fast).

**File:** `src/server.ts` (startup checks)

---

## NICE-TO-HAVE — Can wait for production hardening

### 15. Prometheus `/metrics` endpoint

Expose settlement latency histograms, error rate counters, 1CS quote success rates, and active settlement gauges for monitoring dashboards.

---

### 16. Circuit breaker for RPC failures

Currently retries the RPC rotation blindly. A circuit breaker (e.g., `cockatiel` or `opossum` library) would back off after N consecutive failures instead of hammering a dead RPC.

---

### 17. Automatic buyer refund on 1CS failure

When 1CS reports `FAILED` after the on-chain `transferWithAuthorization` succeeded, the buyer's USDC is at the 1CS deposit address. Currently, refunds go to `GATEWAY_REFUND_ADDRESS` and the operator must manually return funds. Automate this path.

---

### 18. Request correlation IDs

Generate a unique ID per request (`X-Request-Id` header), propagate through all logs and state transitions. Essential for distributed tracing.

---

### 19. Replace `sql.js` with `better-sqlite3`

`sql.js` is pure-JS SQLite (slower, larger memory footprint). `better-sqlite3` is a native binding — synchronous, faster, and battle-tested for Node.js server workloads.

---

### 20. Key rotation without restart

Currently, changing the facilitator private key requires a full service restart. Add a SIGHUP handler or admin endpoint that reloads the key from the secrets manager.

---

### 21. Health endpoint authentication

`/health` currently exposes in-flight settlement count, rate limiter state, and provider health to anyone. Consider requiring an API key or restricting access by IP.

---

## Priority Roadmap

```
Phase 1 — Go-live minimum (blockers 1-7)
  ├── #2  Body size limit          (~5 min)
  ├── #3  Helmet + CORS            (~15 min)
  ├── #5  Unhandled rejection      (~10 min)
  ├── #1  TLS termination          (~30 min, infra)
  ├── #6  File-based persistence   (~30 min)
  ├── #4  Graceful shutdown        (~1-2 hrs)
  └── #7  In-flight recovery       (~2-3 hrs)

Phase 2 — Stable prototype (items 8-14)
  ├── #8  Structured logging       (~2 hrs)
  ├── #10 Request timeout          (~5 min)
  ├── #11 Proxy-aware rate limit   (~10 min)
  ├── #12 JWT expiry check         (~20 min)
  ├── #13 Deposit notify logging   (~10 min)
  ├── #14 RPC startup validation   (~20 min)
  └── #9  Gateway authentication   (~1 hr)

Phase 3 — Production hardening (items 15-21)
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
| Security Audit (plan) | Conducted 2026-04-02 (see conversation history) |
