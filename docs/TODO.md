# x402-1CS Gateway — Production Readiness TODO

**Date:** 2026-04-21 (updated for x402scan discovery integration)
**Based on:** Full codebase audit + 478 passing tests (467 mocked + 11 live) + typecheck clean
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
| In-flight settlement recovery on restart | Working |
| Test suite (478 tests) | 100% pass |
| Error response sanitization (no raw internals leaked to clients) | Working |
| Address-mistake diagnosis (startup warnings + runtime error context) | Working |
| x402scan discovery surfaces (`/openapi.json` + `/.well-known/x402` + ownership proofs) | Working (Phases 1-4 of `docs/X402SCAN_PLAN.md`) |
| ESLint | 0 errors, 61 pre-existing warnings (intentional `no-console` + unused imports in tests) |

---

## Recently Completed (since 2026-04-02)

- **Chain agnosticism** — `NEP141_CHAIN_PREFIX_MAP` expanded from 8 to 30+ chains (EVM + Stellar/Solana/Bitcoin/etc.); unknown prefixes now return raw prefix string instead of defaulting to `"near"`.
- **Non-EVM recipient validation** — `validateRecipientFormat()` in `config.ts` now detects non-EVM destinations and warns about format mismatches.
- **Server timeout fix** — Set `headersTimeout`/`requestTimeout`/`setTimeout` tied to `cfg.maxPollTimeMs + 120s`; fixes mid-settlement socket drops (`SocketError: other side closed`).
- **Manual receipt polling** — Replaced ethers `tx.wait()` with `waitForReceipt()` polling `getTransactionReceipt` every 2s. Resolves hangs on L2 RPCs where ethers v6 block-subscription stalls.
- **Broadcast timeout** — Bumped from 30s → 60s default; made configurable via `SettlerOptions.broadcastTimeoutMs`.
- **Error handlers** — `unhandledRejection` logs; `uncaughtException` uses delayed exit (`setTimeout(..., 5000).unref()`) so in-flight settlements can finish.
- **Trust proxy + body limit** — `app.set("trust proxy", 1)` + `express.json({ limit: "1mb" })`.
- **Deposit-notify logging** — Catch block now actually emits `console.warn` with deposit address + tx hash. Notify outcome is threaded into `SwapTimeoutError` so operators can tell whether 1CS acknowledged the deposit.
- **Phase-transition logging** — `settlePayment()` now logs at each phase change: `▶ Broadcasting`, `✓ Origin tx broadcast` (with tx hash + block), `⏳ Polling 1CS status` (with poll budget), `✅ Settled` (with 1CS status + destination chain).
- **402-issued logging** — `returnPaymentRequired()` now logs `[x402] 402 issued for <url> → deposit=<addr>, amount=<amount>` for every quote handed out.
- **Test-client deposit address** — `scripts/test-client.ts` now prints the deposit address in Steps 3 and 4 (success + failure paths) for easier correlation with gateway logs.
- **`.env.stellar` preset** — New pre-filled env file for Base USDC → Stellar USDC merchant destinations.
- **CORS + helmet** — Gateway now installs `helmet()` for baseline HTTP hardening and `cors()` with `exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"]` and `allowedHeaders: ["Content-Type", "PAYMENT-SIGNATURE"]` so browser-based x402 clients can read / send the custom headers. Origin allowlist is configurable via `ALLOWED_ORIGINS` env var; undefined means "reflect any origin". Startup log prints the active policy.
- **In-flight settlement recovery** — On startup, `recoverInFlightSettlements()` scans the store for swaps stuck in `BROADCASTING`, `BROADCAST`, or `POLLING` phases and resumes them in the background. BROADCASTING swaps without an `originTxHash` are marked FAILED (safe default — no re-broadcast). BROADCAST swaps are re-notified to 1CS then polled. POLLING swaps resume polling directly. Recovery tasks hold `SettlementLimiter` slots; swaps that can't acquire a slot are left in place for the next restart. `listByPhase()` promoted to the `StateStore` interface. 18 new tests (12 recovery + 6 store).
- **GC no longer deletes in-flight settlements** — `QuoteGarbageCollector.sweep()` previously called `store.listExpired(cutoffMs)` with no phase filter (`src/rate-limiter.ts:285`), so any swap older than `quoteGcGracePeriodMs` (default 5 min) was deleted — including swaps still in `BROADCASTING`/`BROADCAST`/`POLLING`. Since `maxPollTimeMs` is also 5 min by default, a slow 1CS route would collide exactly with the GC window, breaking the buyer's HTTP response mid-settlement (1CS still processed the swap independently — not fund loss, but silently broken UX). Fix: introduced `GC_ELIGIBLE_PHASES` (`QUOTED`, `EXPIRED`, `SETTLED`, `FAILED`) in `types.ts` and extended `StateStore.listExpired(olderThanMs, phases?)` with an optional phase filter. The GC passes `GC_ELIGIBLE_PHASES`, so in-flight states are never touched. 8 new tests (6 store × both implementations + 2 rate-limiter integration).
- **Error response sanitization + correlation IDs** — The middleware previously forwarded raw `err.message` (for both `GatewayError` and unknown errors) straight into HTTP 500/503/502/504 responses, leaking internals (upstream 1CS error bodies, facilitator wallet balances, RPC URLs with keys, file paths). Fix: `handleError()` in `src/middleware.ts` now maps each `GatewayError.code` to a curated client-safe message via `CLIENT_SAFE_MESSAGES`, returns a fixed generic message for any non-`GatewayError`, and attaches an 8-char hex `correlationId` to every error response body (and to the sanitized `PAYMENT-RESPONSE` `errorMessage` for 502/504). The full error detail — name, code, HTTP status, message, stack, method, path, IP — is written server-side via `logServerError()` under the same correlation ID so operators can grep for one specific request. 5 new tests in `src/middleware.test.ts` cover: 1CS trace leak stripped, facilitator wei balance stripped, non-`GatewayError` returns generic 500, sanitized `PAYMENT-RESPONSE` header, per-response unique correlation IDs.
- **Server-side diagnosis of recipient / asset mistakes** — A live payment failure with `MERCHANT_RECIPIENT=merchantx402.nea` (typo: `.nea` instead of `.near`) landed with a generic `1CS quote rejected (400): Internal server error` in the server log, giving the operator no indication that it was an address typo. Fix: `GatewayError` now carries an optional `context: ErrorContext` bag used for server-log enrichment (never client-facing). A new `diagnoseQuoteRequest()` helper in `src/quote-engine.ts` inspects outgoing quote fields for known-bad patterns — invalid NEAR account (missing `.near`/`.tg` TLA), EVM-vs-NEAR/Stellar/Solana recipient mismatch, whitespace or `#` characters (from `.env` leading-space or inline-comment bugs), and unknown chain prefixes. `requestQuote()` attaches `{ originAsset, destinationAsset, recipient, amount, refundTo, upstreamStatus, hints[] }` as `context` on every error it throws (400 / 401 / 5xx / network). The middleware's `logServerError()` emits this context as a pretty-printed JSON second stderr line under the same correlation ID so operators see the likely cause immediately. The same diagnoser runs at startup (`config.validateRecipientFormat()`) and warns when any hint fires against the configured merchant values — catching typos before the first buyer arrives. Chain-prefix constants + helpers (`EVM_CHAIN_PREFIXES`, `NON_EVM_CHAIN_PREFIXES`, `extractChainPrefix`, `isValidNearAccount`, `isNearNativeAsset`) are extracted into a shared `src/chain-prefixes.ts` leaf module. Bonus fix: `requestQuote` now passes through `GatewayError` instances from injected `quoteFn`s rather than re-wrapping as `ServiceUnavailableError`. 23 new tests (7 config, 14 quote-engine diagnose + context-threading, 2 middleware log-context).
- **x402scan discovery surfaces** — The gateway is now discoverable by [x402scan](https://www.x402scan.com/) and the IETF `_x402` TXT-record ecosystem. Four phases of `docs/X402SCAN_PLAN.md` landed (Phase 5 Bazaar `extensions.bazaar.info` is intentionally deferred — see the re-assessment in the plan doc; current OpenAPI schemas cover the invocability requirement). Additions:
  - `src/protected-routes.ts` — single-source-of-truth registry (`ProtectedRoute` + `FixedPricing`/`DynamicPricing` + `validateProtectedRoutes` + `buildProtectedRoutes(cfg)` factory). All paid routes now come from this registry; `server.ts` mounts them in a loop instead of hardcoding `/api/premium`.
  - `src/ownership-proof.ts` — EIP-191 canonical message `x402 ownership of <normalised URL>`, shape validation, recovery helper, and `validateOwnershipProofs()` used by `config.ts` at startup. The signing key never touches the request path.
  - `src/discovery.ts` — pure builder for `GET /.well-known/x402` (`version`, `resources[]`, `ownershipProofs[]`). Joins the public base URL with each route path (supports subpath deployments, drops default ports, etc).
  - `src/openapi.ts` — pure builder for `GET /openapi.json` (OpenAPI 3.1 with `x-payment-info`, `x-discovery.ownershipProofs`, per-route `security: [{x402: []}]`, `responses.402`, requestBody for POST routes with `inputSchema`, responses.200 schema from `outputSchema`).
  - `src/config.ts` — two new env vars: `PUBLIC_BASE_URL` (optional, normalised for use in both documents) and `OWNERSHIP_PROOFS` (comma-separated list). Startup validation warns on malformed proofs and logs the recovered signer of each valid one so the operator can verify at a glance.
  - `scripts/generate-ownership-proof.ts` — stand-alone CLI that signs the canonical message and prints the signature ready to paste into `.env`. Self-verifies by recovering the signer before printing.
  - `docs/X402SCAN.md` — new operator guide: 5-step registration walkthrough, multi-key setups, subpath deployments, troubleshooting matrix, DNS `_x402` notes.
  - `docs/X402SCAN_PLAN.md` — integration design notes (7 phases, execution order, verification checklist).
  - 101 new tests: 21 `protected-routes.test.ts`, 28 `ownership-proof.test.ts`, 14 `discovery.test.ts`, 24 `openapi.test.ts`, 8 config discovery tests, 6 server.test.ts discovery-endpoint tests. All endpoints unauthenticated and served above the paid-routes loop so crawlers never hit a 402.
- **Test-suite cleanup (Tranche E)** — A focused pass on redundancy, flake risk, and live-suite cost, informed by a parallel read-only audit. Five changes landed:
  - **CI-flake fix** — `recoverInFlightSettlements` now returns a `RecoveryResult` with an added `tasks: Promise<void>[]` field. Production (`server.ts`) ignores it to preserve fire-and-forget semantics; tests `await Promise.all(result.tasks)` for deterministic completion instead of `setTimeout(r, 200)` sleeps. Replaced two real-timer races in `settler.test.ts`. Settler suite runtime: **610 ms → 244 ms**.
  - **New `src/chain-prefixes.test.ts` (29 tests)** — direct unit coverage for `extractChainPrefix`, `isValidNearAccount`, `isNearNativeAsset`. These helpers gate recipient-format validation at startup and runtime; previously they had only transitive coverage through `diagnoseQuoteRequest`. Notable cases: the `.nea` typo, implicit-account (64-hex) handling, OMFT vs NEAR-native differentiation, and a disjoint-list invariant between EVM and non-EVM prefix lists.
  - **Verifier test fixture dedupe** — `testConfig()` in `verifier.test.ts` now delegates to `mockGatewayConfig()` from the shared mocks library; ~27 lines of drift-prone duplication removed. The file's specialised inline `signEIP3009`/`signPermit2`/`mockChainReader` helpers stay — they deliberately expose invalid-signature construction for error-path tests, which the library's "always valid" helpers can't do.
  - **Live suite trimmed 17 → 11 tests** — removed live tests that duplicated mocked coverage or tested 1CS-side invariants rather than gateway behaviour: quote-pricing-sanity, deposit-address uniqueness, small/large amount variants, state-store persistence, concurrent quotes. Live CI time: **71 s → 48 s (-32%)**. Retained: authentication, dry-quote shape, real quote with deposit address, invalid-asset / expired-deadline rejection, full 402→sign→settle flow, `X402Client.payAndFetch`, 1CS 401/400 error mapping, status endpoint.
  - **Explicit non-goal** — settler-internal helpers (`withTimeout` timeout branch, `waitForReceipt` max-attempts branch) remained untested. Reaching them would require either exporting file-private helpers or ~50 lines of mock-provider scaffolding for ~3 lines of guard logic; net test theatre.
  - Totals after E: **478 tests** (467 mocked + 11 live) across **19 mocked test files** + live-1cs.test.ts. Total CI time **~51 s**, down from ~73 s.

---

## BLOCKERS — Must fix before any real user touches it

### 1. Add HTTPS / TLS termination

**Risk:** Payment signatures (`PAYMENT-SIGNATURE` header) travel in plaintext over HTTP. Any network observer can intercept and replay them.

**Fix:** Terminate TLS via one of:
- Reverse proxy (nginx, Caddy, Cloudflare Tunnel) — recommended
- Node.js `https` module with a cert

**Files:** Infrastructure-level (nginx/Caddy), or `src/server.ts` if self-hosted TLS.

---

### 2. Enable file-based state persistence

**Risk:** The default `SqliteStateStore` runs in-memory (see `src/server.ts:48`). A crash or deploy wipes all swap states. Any settlement in `BROADCASTING` or `POLLING` phase is irrecoverable — the buyer's on-chain transfer happened but the gateway forgot about it.

**Fix:**
- Add `STORE_FILE_PATH` and `STORE_SAVE_INTERVAL_MS` env vars to `config.ts`
- Pass them to `SqliteStateStore` constructor in `server.ts`
- Document in `.env.example` and deployment guide

**Files:** `src/config.ts`, `src/server.ts`, `.env.example`.

---

### 3. Graceful shutdown — wait for in-flight settlements

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

### 4. Validate RPC reachability at startup

**Current:** If all RPC URLs are unreachable, the server starts fine but every settlement fails at broadcast time. There's a facilitator balance check (`src/server.ts:62-79`) but it's non-blocking — only logs a warning.

**Fix:** On startup, call `eth_blockNumber` on the primary RPC. If all configured RPCs fail, refuse to start (fail-fast).

**File:** `src/server.ts` (startup checks using `providerPool`).

---

### 5. Check 1CS JWT expiry at startup

**Current:** If the JWT expires, every quote request fails with 401 and there's no warning.

**Fix:** Decode the JWT payload (base64 decode), extract `exp`:
- Log the expiry date at startup
- Warn if < 7 days remaining
- Fail fast if already expired

**File:** `src/server.ts` (startup checks).

---

### 6. Add structured logging

**Current:** All logging is bare `console.log`/`console.warn` — no timestamps, no correlation IDs, no JSON format. The `no-console` ESLint warnings flag 22 occurrences in `server.ts` alone.

**Impact:** Debugging a failed settlement requires grepping by deposit address.

**Fix:**
- Minimum: add `[timestamp] [depositAddress] [phase]` prefix to every state transition log.
- Better: adopt `pino` for JSON output with per-request correlation IDs.

**Files:** `src/settler.ts`, `src/middleware.ts`, `src/quote-engine.ts`, `src/server.ts`.

---

### 7. Add gateway authentication

**Current:** Anyone who discovers the gateway URL can trigger 402 flows, consuming 1CS quotes (rate-limited by your JWT).

**Fix:** Add an API key middleware or IP allowlist. Options:
- `X-API-Key` header checked against an env var (simplest)
- Mutual TLS (mTLS)
- IP allowlist

**File:** `src/server.ts` (new middleware before routes).

---

### 8. Test coverage for recent additions

**Current gaps:**
- `waitForReceipt()` in `src/settler.ts` is not exported and has no direct tests. Needs: timeout after `maxAttempts`, reverted receipt (`status === 0`), provider error during polling.
- `validateRecipientFormat()` in `src/config.ts` has zero direct tests (~15 scenarios missing: EVM/non-EVM/NEAR recipient pairings, unknown chain prefix, etc.).
- `SettlerOptions.broadcastTimeoutMs` is not covered by `settler.test.ts`.
- `ChainReader` RPC timeout during `verifyPayment` — no test simulates RPC failure.

**Files:** `src/settler.test.ts`, `src/config.test.ts`, `src/verifier.test.ts`.

---

## NICE-TO-HAVE — Production hardening

### 9. Prometheus `/metrics` endpoint

Expose settlement-latency histograms, error-rate counters, 1CS quote success rates, and active-settlement gauges for monitoring dashboards.

### 10. Circuit breaker for RPC failures

Currently retries the RPC rotation blindly. A circuit breaker (e.g., `cockatiel`, `opossum`) would back off after N consecutive failures instead of hammering a dead RPC.

### 11. Automatic buyer refund on 1CS failure

When 1CS reports `FAILED` after the on-chain `transferWithAuthorization` succeeded, the buyer's USDC is at the 1CS deposit address. Currently, refunds go to `GATEWAY_REFUND_ADDRESS` and the operator must manually return funds. Automate this path.

### 12. Request correlation IDs

Generate a unique ID per request (`X-Request-Id` header), propagate through all logs and state transitions. Essential for distributed tracing.

### 13. Replace `sql.js` with `better-sqlite3`

`sql.js` is pure-JS SQLite (slower, larger memory footprint). `better-sqlite3` is a native binding — synchronous, faster, battle-tested for Node.js server workloads.

### 14. Key rotation without restart

Currently, changing the facilitator private key requires a full service restart. Add a SIGHUP handler or admin endpoint that reloads the key from the secrets manager.

### 15. Health endpoint authentication

`/health` currently exposes in-flight settlement count, rate-limiter state, and provider health to anyone. Consider requiring an API key or restricting access by IP.

### 16. Lint cleanup

46 ESLint warnings — mostly intentional `no-console` in `server.ts` (22) and unused test imports (14). Fix the unused-import warnings in a single cleanup pass (they're easy wins). Leave the `no-console` warnings — they're intentional until structured logging (#6) lands.

---

## Priority Roadmap

```
Phase 1 — Go-live minimum (blockers 1-3)
  ├── #1  TLS termination           (~30 min, infra)
  ├── #2  File-based persistence    (~30 min)
  └── #3  Graceful shutdown (wait)  (~1-2 hrs)

Phase 2 — Stable prototype (items 4-8)
  ├── #4  RPC startup validation    (~20 min)
  ├── #5  JWT expiry check          (~20 min)
  ├── #7  Gateway authentication    (~1 hr)
  ├── #8  Test coverage for new code (~2 hrs)
  └── #6  Structured logging        (~2 hrs)

Phase 3 — Production hardening (items 9-16)
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
