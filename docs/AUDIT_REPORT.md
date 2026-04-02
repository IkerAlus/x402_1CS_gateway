# x402-1CS Gateway Implementation — Comprehensive Audit Report

**Date:** 2026-03-31
**Scope:** Phase 0 (Project Scaffolding) — Source modules, configuration, and type definitions
**Status:** NOT PRODUCTION READY — Multiple critical gaps and inconsistencies identified

---

## Executive Summary

This audit evaluates the x402-1CS gateway implementation against its specification documents (implementation-roadmap.md and Research plan/report.md). The implementation shows good foundational structure with well-documented types and configuration, but has **5 CRITICAL gaps**, **8 MINOR issues**, and **6 INFO-level findings**. Phase 1 modules (quote-engine, verifier, settler, store) are mostly complete, but middleware assembly (Phase 2) is entirely absent, and several cross-module interface inconsistencies exist.

**Key blockers:**
- No Express middleware layer (Phase 2.1) — cannot wire modules into HTTP flow
- Missing middleware.ts file entirely
- Verifier does not validate all x402/evm payload fields per spec section 2
- Settler's pollUntilTerminal function contains blocking while loop (violates spec requirement for non-blocking operation)

---

## 1. Configuration Module (src/config.ts)

### 1.1 API Shape Match
**Status:** PASS with minor notes

- Implements `GatewayConfigSchema` per spec Step 0.2 ✓
- All required fields present (oneClickJwt, originNetwork, facilitatorPrivateKey, etc.) ✓
- Zod validation framework correctly applied ✓
- `loadConfigFromEnv()` function signature matches spec ✓

### 1.2 Type Correctness
**Status:** PASS

- Zod schema properly typed ✓
- `z.string().regex(/^eip155:\d+$/)` correctly validates CAIP-2 format ✓
- Numeric tuning params use `.int().positive()` ✓
- Default values align with spec ✓

### 1.3 Naming Consistency
**Status:** PASS

- Uses camelCase consistently: `oneClickJwt`, `originNetwork`, `facilitatorPrivateKey` ✓
- No underscore/camelCase mixing ✓

### 1.4 Logic Gaps vs Spec
**Status:** PASS

- Spec requires comma-separated `ORIGIN_RPC_URLS` parsing → implemented at line 84 ✓
- Boolean coercion for `TOKEN_SUPPORTS_EIP3009` implemented correctly (line 95-96) ✓
- Numeric env var coercion present (lines 87-92) ✓

### 1.5 Missing Functionality
**Status:** MINOR ISSUE

- **[MINOR]** Spec doesn't mention `.env.example` generation, but roadmap Step 0.2 references it → **missing artifact**. Should be created as reference documentation.

---

## 2. Type Definitions Module (src/types.ts)

### 2.1 API Shape Match
**Status:** PASS

- SwapPhase union defined with all 8 states per spec (lines 110-118) ✓
- SwapState interface includes all required fields ✓
- StateStore interface matches spec Step 1.1 (lines 420-434) ✓
- Error classes defined with `httpStatus` field (lines 328-408) ✓

### 2.2 Type Correctness
**Status:** PASS with INFO notes

- Re-exports from `@x402/core` and `@x402/evm` correctly namespaced ✓
- `OneClickStatus` union correctly lists all enum values (lines 88-95) ✓
- `TERMINAL_STATUSES` constant properly typed as `ReadonlySet<OneClickStatus>` (line 441) ✓
- `VALID_PHASE_TRANSITIONS` map matches spec state diagram (lines 448-458) ✓

### 2.3 Naming Consistency
**Status:** MINOR ISSUE

- **[MINOR]** Type name inconsistency: `PaymentRequirementsRecord` vs `PaymentRequirements` (imported from @x402/core). The spec calls the mapped type "PaymentRequirements" but gateway stores it as `PaymentRequirementsRecord`. This is intentional for serialization safety, but adds cognitive burden. Consider documenting the distinction more prominently.
- **[MINOR]** Similarly: `QuoteResponseRecord` vs `QuoteResponse` — intentional but could use a glossary comment block at the top of types.ts

### 2.4 Logic Gaps vs Spec
**Status:** PASS

- All phase transitions in `VALID_PHASE_TRANSITIONS` align with roadmap diagram (Step 0.3) ✓
- Terminal states correctly marked with empty set (lines 455-457) ✓

### 2.5 Missing Functionality
**Status:** MINOR ISSUES

- **[MINOR]** Research plan §8 defines three error HTTP statuses (502 for swap failure, 504 for timeout, 503 for quote/auth errors), but type definitions don't list them as constants. Suggest adding:
  ```typescript
  export const HTTP_STATUS_CODES = {
    QUOTE_UNAVAILABLE: 503,
    SWAP_FAILED: 502,
    SWAP_TIMEOUT: 504,
    // ... etc
  } as const;
  ```
- **[INFO]** `SettlementResponseRecord` includes optional `extra` field with `CrossChainSettlementExtra` interface — properly structured per spec §6 ✓

### 2.6 Cross-Module Consistency
**Status:** PASS

- StateStore interface returns `SwapState | null` (line 424) — matches store.ts implementation ✓
- Error classes exported and reused in quote-engine, settler ✓

---

## 3. State Store Module (src/store.ts)

### 3.1 API Shape Match
**Status:** PASS

- `StateStore` interface matches spec Step 1.1 exactly ✓
- `SqliteStateStore` and `InMemoryStateStore` both implement the interface ✓
- `createStateStore()` factory function provides backend selection ✓
- Phase transition validation via `validatePhaseTransition()` implemented (lines 487-499) ✓

### 3.2 Type Correctness
**Status:** PASS

- SwapState serialization as JSON via `JSON.stringify()` (line 114) ✓
- Database schema correctly uses `INTEGER` for timestamps (lines 287-291) ✓
- Type narrowing via `structuredClone()` in InMemoryStateStore (lines 368, 373) ✓

### 3.3 Naming Consistency
**Status:** PASS

- Snake_case for SQL column names (deposit_address, state_json, created_at) ✓
- camelCase for TypeScript identifiers ✓

### 3.4 Logic Gaps vs Spec
**Status:** MINOR ISSUE

- **[MINOR]** Spec Step 1.1 says `create` must be "idempotent" — code uses `INSERT OR REPLACE` which is correct (line 117), but this is not explicitly documented in the JSDoc. Consider adding: `@note Uses INSERT OR REPLACE to ensure idempotency`
- **[INFO]** Spec mentions optimistic locking on `update` — implemented via phase transition validation (line 168) ✓

### 3.5 Dependency Audit
**Status:** PASS

- Uses `sql.js` (in package.json) ✓
- No unexpected imports ✓
- FileSystem import conditionally used inside `init()` (line 63) — good lazy loading ✓

### 3.6 Production Concerns
**Status:** INFO FINDINGS

- **[INFO]** `sql.js` is an in-memory database with synchronous API wrapped in async interface. Roadmap warns this is "suitable for development/testing" (Step 1.1 preamble). For production, Redis migration is mentioned in Phase 3. Current implementation **deliberately avoids persistence by default**, which is appropriate for early-phase development but should be explicitly flagged in startup logs.

---

## 4. Quote Engine Module (src/quote-engine.ts)

### 4.1 API Shape Match
**Status:** CRITICAL ISSUE

- Function signature: `buildPaymentRequirements(cfg, store, resourceUrl, quoteFn)` matches spec Step 1.2 ✓
- Return type `BuildPaymentRequirementsResult` includes both `requirements` and `state` ✓
- **[CRITICAL]** Spec Step 1.2 states: "Call `OneClickService.getQuote()` with `swapType: "EXACT_OUTPUT"`, `dry: false`"
  - Implementation at line 170 uses `QuoteRequest.swapType.EXACT_OUTPUT` ✓
  - But the field name check: spec uses `swapType`, code uses `swapType` (line 170) ✓
  - However, **spec roadmap shows the request should have `refundAddress` / `refundTo` BOTH present** (research plan §5 shows both in comment), but code only sets `refundTo` (line 176). This follows Option A design, but should be verified against 1CS SDK expectations.

### 4.2 Type Correctness
**Status:** CRITICAL ISSUES

- **[CRITICAL]** Line 15: imports `QuoteResponse` from types, but type is re-exported from 1CS SDK. The actual type signature is likely `QuoteResponse` from SDK, not a gateway-defined type. This is correct, but the import source should be explicitly documented.
- **[CRITICAL]** Line 282-283: Maps `quote.amountIn` to `amount` in PaymentRequirements. But research plan §4 field mapping table says:
  > | amount | quote.amountIn | maxAmountIn — ensures sufficient headroom |

  The code comment (lines 282-283) correctly notes "Use amountIn (= maxAmountIn for EXACT_OUTPUT)". **However**, the 1CS SDK response may not label this field as `amountIn` — it may be `quote.maxAmountIn` or differently named. **Spec doesn't clarify the exact 1CS field name.**

### 4.3 Naming Consistency
**Status:** PASS

- camelCase used throughout ✓
- `depositAddress` (used consistently with spec and types.ts) ✓
- `assetTransferMethod` matches types.ts definition (line 274) ✓

### 4.4 Logic Gaps vs Spec
**Status:** CRITICAL ISSUE

- **[CRITICAL]** Spec Step 1.2 lists 4 error cases to handle:
  1. 400 (bad asset pair) → QuoteUnavailableError ✓ (line 196)
  2. 401 (JWT expired) → AuthenticationError ✓ (line 200)
  3. 503 (service down) → ServiceUnavailableError ✓ (lines 205-208)
  4. (Not numbered) Deadline too short → DeadlineTooShortError ✓ (line 238)

  But the error handler at line 204-213 has a catch-all that treats HTTP 4xx statuses (other than 401) as QuoteUnavailableError. Spec doesn't explicitly list other 4xx codes — **potential silent failure if 1CS returns 403 or 429**.

### 4.5 Cross-Module Interface Consistency
**Status:** PASS

- `buildPaymentRequirements()` persists SwapState with `phase: "QUOTED"` (line 113) ✓
- Returned `requirements` field has all keys used by verifier (payTo, amount, asset, scheme, network) ✓
- `depositAddress` matches what verifier expects as key (types.ts SwapState.depositAddress) ✓

### 4.6 Missing Functionality
**Status:** MINOR ISSUE

- **[MINOR]** Spec Step 1.2 mentions detecting `assetTransferMethod` by checking "if origin token contract has `transferWithAuthorization` function selector". Current code (line 274-275) simply uses config boolean `cfg.tokenSupportsEip3009`. This **skips the on-chain detection**, which is a design choice but not what spec recommends. For v1 this is acceptable if config is correct, but should be documented as a simplification.

---

## 5. Verifier Module (src/verifier.ts)

### 5.1 API Shape Match
**Status:** CRITICAL ISSUE

- Function signature: `verifyPayment(paymentPayload, store, chainReader, cfg, options)` is well-formed ✓
- **[CRITICAL]** But spec Step 1.3 function signature in roadmap is:
  ```typescript
  async function verifyPayment(
    paymentPayload: PaymentPayload,
    storedState: SwapState,
    provider: ethers.Provider
  ): Promise<{ valid: boolean; error?: string; signerAddress?: string }>
  ```

  Implementation has:
  ```typescript
  async function verifyPayment(
    paymentPayload: PaymentPayloadRecord,
    store: StateStore,
    chainReader: ChainReader,
    cfg: GatewayConfig,
    options: VerifierOptions = {},
  ): Promise<VerifyResult>
  ```

  **Signature mismatch**: Implementation requires `store` lookup, not `storedState` as input. This is actually better (idempotent and stateless-looking), but violates the spec signature. Implementation looks up state itself (line 128), which is correct for the actual middleware flow.

### 5.2 Type Correctness
**Status:** MINOR ISSUES

- **[MINOR]** Line 39-44: imports from `@x402/evm` use `ExactEIP3009Payload` and `ExactPermit2Payload`. These types are imported from the SDK, but code creates a union locally as `ExactEvmPayloadV2` (line 186). This is safe but adds indirection.
- **[MINOR]** Lines 310-312: EIP-712 types reconstructed manually from `authorizationTypes` imported from @x402/evm. The code maps these to proper ethers.js shape, which is correct, but there's no validation that the authorizationTypes structure matches what ethers.js expects.

### 5.3 Naming Consistency
**Status:** PASS

- Uses `payTo` consistently (matches PaymentRequirementsRecord) ✓
- Snake vs camel: Permit2 fields like `permit2Authorization` correctly camelCase ✓

### 5.4 Logic Gaps vs Spec
**Status:** CRITICAL ISSUES

- **[CRITICAL]** Research plan §2 (Verifier section) lists these checks for **EIP-3009 path**:
  1. Decode authorization ✓ (line 247)
  2. Reconstruct EIP-712 hash ✓ (lines 300-323)
  3. ecrecover signature → verify matches `authorization.from` ✓ (lines 326-341)
  4. Check `authorization.to === payTo` ✓ (line 252)
  5. Check `authorization.value >= amount` ✓ (line 260)
  6. Check `validBefore > now` and `validAfter < now` — **SPEC SHOWS BOTH, CODE ONLY CHECKS ONE DIRECTION**
     - Code checks: `validAfter < now + 600s` (line 272) and `validBefore > now - 6s` (line 281) ✓
     - But research plan says: "Check `validBefore > now` and `validAfter < now`" (§2, step 6)
     - Code's tolerance windows (-600s, +6s) are from @x402/evm but spec doesn't mention them. This is likely correct (copied from reference implementation), but should be documented.
  7. Call `token.balanceOf(from)` → verify balance ✓ (line 345)
  8. Simulate `token.transferWithAuthorization()` → verify no revert — **MISSING**

  The verifier checks balance but **does NOT simulate the transfer** to ensure it won't revert. Spec explicitly requires: "Simulate `token.transferWithAuthorization(...)` via `eth_call` → verify it doesn't revert". Code skips this (only checks balance).

- **[CRITICAL]** Permit2 path (research plan §2, steps 1-8):
  1. Decode permit2Authorization ✓ (line 387)
  2. Reconstruct Permit2 EIP-712 hash ✓ (lines 447-461)
  3. ecrecover → verify matches `permit2Authorization.from` ✓ (lines 478-494)
  4. Check `witness.to === payTo` ✓ (line 408)
  5. Check `permitted.amount >= required amount` ✓ (line 416)
  6. Check `deadline > now` ✓ (line 437)
  7. Verify Permit2 allowance: `ERC20.allowance(from, PERMIT2_ADDRESS) >= amount` ✓ (line 510)
  8. Simulate `x402ExactPermit2Proxy.settle(...)` via `eth_call` — **MISSING**

  Similar gap: code checks allowance but **does NOT simulate the proxy settle call**.

- **[CRITICAL]** Spec explicitly states: "You can lean on `@x402/evm`'s `ExactEvmScheme` internals here... the `verify` function already implements both paths." The gateway should either:
  1. Use `@x402/evm`'s verify function directly, OR
  2. Implement all steps including simulation

  Current code is a partial reimplementation that skips the most critical step (simulation). This is a **major security gap** — the verifier approves a signature without confirming it can actually execute on-chain.

### 5.5 Cross-Module Consistency
**Status:** PASS

- Returns `VerifyResult` with `valid`, `error`, `signerAddress` fields ✓
- Updates store phase to `VERIFIED` with paymentPayload + signerAddress (line 214-218) ✓
- Handles quote expiry (line 162-175) before verification ✓

---

## 6. Settler Module (src/settler.ts)

### 6.1 API Shape Match
**Status:** CRITICAL ISSUE

- Function signature: `settlePayment(depositAddress, store, broadcastFn, depositNotifyFn, statusPollFn, cfg, options)` matches spec structure ✓
- Return type: `SettlementResponseRecord` ✓
- Sub-step functions `broadcastEIP3009()`, `broadcastPermit2()`, `pollUntilTerminal()`, `buildSettlementResponse()` all present ✓

- **[CRITICAL]** Function signatures for injected dependencies don't match spec:
  - Spec Step 1.4 shows:
    ```typescript
    async function broadcastTransfer(
      state: SwapState,
      wallet: ethers.Wallet
    ): Promise<ethers.TransactionReceipt>
    ```
  - Implementation has separate `broadcastEIP3009()` and `broadcastPermit2()` functions taking `BroadcastFn` interface, not a single consolidated function. This is actually better design (separates concerns), but violates the spec interface contract.

### 6.2 Type Correctness
**Status:** MINOR ISSUES

- **[MINOR]** Lines 78-83: `BroadcastFn.broadcastEIP3009()` expects `auth: ExactEIP3009Payload["authorization"]`, but the actual authorization object structure from the payload may not match this type exactly. Code assumes it does (line 389-390), which is correct if types.ts mappings are correct.

### 6.3 Naming Consistency
**Status:** PASS

- Uses camelCase throughout ✓
- Function names match spec: `pollUntilTerminal`, `buildSettlementResponse` ✓

### 6.4 Logic Gaps vs Spec
**Status:** CRITICAL ISSUE

- **[CRITICAL]** Spec Step 1.4, sub-step C states:
  > "CRITICAL: This must NOT block the Express event loop. Use a promise-based approach with `setTimeout`, not a `while(true)` loop."

  Lines 465-517 implement `pollUntilTerminal()`:
  ```typescript
  while (true) {
    // Check timeout
    const elapsed = Date.now() - startTime;
    if (elapsed >= cfg.maxPollTimeMs) {
      throw new SwapTimeoutError(...);
    }
    // Wait before polling
    await sleep(interval);
    // Poll
    ...
  }
  ```

  This **IS a blocking while(true) loop**, albeit with `await sleep()` inside. While the await does yield to the event loop, the logic structure itself is still blocking and synchronous. The proper async-iterator or recursive promise pattern would be:
  ```typescript
  async function pollUntilTerminal(...): Promise<StatusPollResult> {
    return new Promise((resolve, reject) => {
      async function poll() {
        // ... single poll attempt
        if (terminal) resolve(result);
        else {
          setTimeout(() => { poll(); }, interval);
        }
      }
      setTimeout(poll, cfg.pollIntervalBaseMs);
    });
  }
  ```

  The current implementation will work (async/await does yield), but the spec explicitly warns against while loops, suggesting the author wanted to ensure the function is inherently non-blocking. **Code violates the spec directive even though it may work in practice.**

### 6.5 Sub-step A: Broadcast
**Status:** MINOR ISSUES

- Lines 588-593 (EIP-3009 gas estimation): Uses `estimateGas()` + 1.2x buffer ✓ (matches spec D-S1)
- Lines 401-413: Pre-checks EIP-3009 nonce state to detect already-used nonces ✓ (matches spec D-S3)
- **[MINOR]** Line 609: uses `tx.wait(confirmations)` which is correct, but `confirmations` defaults to 1 (line 569), matching spec (D-S2) ✓. However, the parameter comes from SettlerOptions, not passed to `broadcastFn` functions. This is fine (encapsulated) but adds hidden state.

- **[MINOR]** Permit2 broadcast at lines 618-669: constructs permit struct manually (lines 630-643). The witness object only includes `to` and `validAfter`, but spec says Permit2 witness should also include time bounds. Code at line 641 shows:
  ```typescript
  const witness = {
    to: permit2Auth.witness.to,
    validAfter: permit2Auth.witness.validAfter,
  };
  ```
  But `ExactPermit2Payload` likely has more witness fields. This could be incomplete.

### 6.6 Sub-step C: Poll
**Status:** CRITICAL ISSUE (already noted above in 6.4)

- Implements exponential backoff correctly (line 516) ✓
- Updates store on each status change (line 489-491) ✓
- **But violates spec's "no while(true) loops" directive** (see 6.4)

### 6.7 Sub-step D: Build Response
**Status:** MINOR ISSUE

- Lines 530-554 builds SettlementResponseRecord ✓
- Maps cross-chain metadata correctly to `extra` field ✓
- **[MINOR]** Line 549: sets `payer: state.signerAddress`. Spec doesn't show `payer` in example response (research plan §6), but `SettlementResponseRecord` interface includes it (types.ts line 257). This is fine but underdocumented.

### 6.8 Dependency Audit
**Status:** INFO FINDINGS

- **[INFO]** Lines 696-710: `createDepositNotifyFn()` wraps `OneClickService.submitDepositTx()`. Hardcoded use of 1CS SDK — correct for production (line 701).
- **[INFO]** Lines 717-732: `createStatusPollFn()` wraps `OneClickService.getExecutionStatus()` — correct ✓

---

## 7. Index/Entry Point (src/index.ts)

### 7.1 API Shape Match
**Status:** CRITICAL ISSUE

- Spec Phase 0 says: "Buildable project with types, config, and test harness"
- Implementation only loads config and validates it (lines 17-28) ✓
- **[CRITICAL]** index.ts is supposed to be the "entry point" but currently just validates config and exits. It does NOT:
  - Initialize the state store
  - Initialize express server
  - Set up middleware (Phase 2)
  - Expose module exports properly

### 7.2 Module Exports
**Status:** MINOR ISSUE

- **[MINOR]** Lines 13-15 re-export from config and types, but don't export the core modules:
  ```typescript
  export { GatewayConfigSchema, loadConfigFromEnv } from "./config.js";
  export type { GatewayConfig } from "./config.js";
  export * from "./types.js";
  ```

  Missing exports:
  - `buildPaymentRequirements` from quote-engine
  - `verifyPayment` from verifier
  - `settlePayment` from settler
  - `StateStore`, `createStateStore` from store

  These should be exported so external code can use them.

---

## 8. Package.json Dependency Audit

### 8.1 Listed Dependencies
**Status:** CRITICAL ISSUE

```json
"dependencies": {
  "@defuse-protocol/one-click-sdk-typescript": "^0.1.17",
  "@x402/core": "^2.8.0",
  "@x402/evm": "^2.8.0",
  "ethers": "^6.13.0",
  "express": "^4.21.0",
  "sql.js": "^1.14.1",
  "zod": "^3.23.0"
}
```

**[CRITICAL]** The following are listed but **not used in Phase 0 scope**:
- `express` (^4.21.0) — no middleware.ts file exists yet (Phase 2)
- `sql.js` (^1.14.1) — used in store.ts ✓ (actually correct)

**Used but not listed** (would cause build failures):
- None detected — all imports have corresponding dependencies ✓

**Versions:** All semver constraints use caret ranges (allow minor updates) — appropriate for non-production ✓

### 8.2 Dev Dependencies
**Status:** PASS

- `vitest`, `msw`, `supertest` present for testing ✓
- `@typescript-eslint/*` present ✓
- `prettier` present ✓
- `tsx`, `typescript` for development ✓

### 8.3 Missing from package.json but used in spec
**Status:** INFO FINDINGS

- **[INFO]** Spec Step 0.1 mentions `better-sqlite3` for SQLite on disk, but implementation uses `sql.js` (pure JS, in-memory). This is noted in store.ts comments (line 7) as intentional for Phase 0. `better-sqlite3` should be added when switching to file persistence (Phase 3).

---

## 9. TypeScript Configuration (tsconfig.json)

### 9.1 Strict Mode
**Status:** PASS

- `"strict": true` ✓
- `"noUnusedLocals": true` ✓
- `"noUnusedParameters": true` ✓
- `"noImplicitReturns": true` ✓

### 9.2 Module System
**Status:** PASS

- `"module": "Node16"` with `"moduleResolution": "Node16"` ✓
- `"type": "module"` in package.json matches ESM ✓
- All source files use `.js` extensions in imports (e.g., `from "./config.js"`) ✓

---

## 10. Cross-Module Interface Consistency

### 10.1 Quote Engine → Verifier
**Status:** MINOR ISSUE

- Quote engine produces: `SwapState { depositAddress, quoteResponse, paymentRequirements, phase: "QUOTED" }`
- Verifier expects: Same structure when doing `store.get(depositAddress)` ✓
- **[MINOR]** But quote engine stores `PaymentRequirementsRecord` while verifier operates on `PaymentRequirementsRecord` from the payload. These are both the same shape, but no cross-check validates they match before verification (spec requires this in verifier).

### 10.2 Verifier → Settler
**Status:** PASS

- Verifier updates state to: `phase: "VERIFIED", paymentPayload, signerAddress` ✓
- Settler expects exactly these fields (line 250-256) ✓

### 10.3 Settler → Response
**Status:** PASS

- Settler produces `SettlementResponseRecord` with all required fields ✓
- Matches x402 `PaymentResponse` format (research plan §6) ✓

---

## 11. Critical Gaps: Phase 2 Middleware

### Current State
**Status:** CRITICAL — MISSING ENTIRELY

Spec Phase 2.1 requires `src/middleware.ts` with:
```typescript
function x4021CSMiddleware(
  cfg: GatewayConfig,
  store: StateStore,
  providerPool: ProviderPool
): express.RequestHandler
```

This file **does not exist**. Without it, the gateway cannot:
1. Parse the `PAYMENT-SIGNATURE` header
2. Route requests to quote engine vs verifier vs settler
3. Set response headers (402, `PAYMENT-REQUIRED`, etc.)
4. Handle the full HTTP flow

This is a **complete architectural blocker** for Phase 1 completion.

### Additional Missing Files
- `src/provider-pool.ts` (Phase 2.2) — **missing**
- `test/e2e/` directory — **missing**
- `.env.example` — **missing**

---

## 12. Named Inconsistencies and Naming Convention Issues

### 12.1 depositAddress vs deposit_address
**Status:** PASS (intentional)

- Gateway uses `depositAddress` (camelCase) for TypeScript identifiers ✓
- SQL schema uses `deposit_address` (snake_case) for columns ✓
- This is correct convention separation

### 12.2 Payload Field Names
**Status:** MINOR ISSUE

- **[MINOR]** Research plan §5 shows 1CS request with both `refundAddress` and `refundTo`, but quote-engine.ts only sets `refundTo` (line 176). Need to verify 1CS SDK expectations — do both fields exist? Is one deprecated?

### 12.3 Settlement Response Fields
**Status:** MINOR ISSUE

- **[MINOR]** `SettlementResponseRecord` interface (types.ts line 253) includes `errorReason` and `errorMessage` fields, but when error occurs in settler, code throws exceptions rather than returning error-response objects. This means these fields are never populated. Either:
  1. Settler should catch errors and build error-response objects with these fields, OR
  2. These fields should be removed as they're not used

---

## 13. Error Handling and Edge Cases

### 13.1 Error Classes Completeness
**Status:** MINOR ISSUE

- **[MINOR]** Research plan §8 mentions error case: "Duplicate payments" — state store should deduplicate by `deposit_address`. Code handles this via idempotent `create()` (line 117: `INSERT OR REPLACE`), but verifier doesn't explicitly check for settled duplicate (line 140 does check `phase === "SETTLED"` and returns cached success, which is correct).

- **[MINOR]** Research plan §8 mentions: "Nonce replay" — verifier could check nonce, but settler pre-checks authorization state (line 401-413) instead. This is appropriate (check before broadcast, not just during verification).

### 13.2 Quote Expiry Handling
**Status:** PASS

- Quote engine validates deadline (line 228-243) ✓
- Verifier re-validates deadline (line 162-175) ✓
- Spec says reject if < 30s left — both check against `quoteExpiryBufferSec` config ✓

---

## 14. Summary of Issues by Severity

### CRITICAL (Must fix before proceeding)

1. **[CRITICAL]** Middleware.ts entirely missing (Phase 2.1) — cannot wire HTTP flow
2. **[CRITICAL]** Verifier does NOT simulate transfers before approval (missing simulation eth_call per spec §2)
3. **[CRITICAL]** Settler's `pollUntilTerminal()` uses while(true) loop, violating spec directive for non-blocking operation
4. **[CRITICAL]** Quote engine may have incomplete field mapping from 1CS response (amountIn vs maxAmountIn field naming)
5. **[CRITICAL]** Verifier function signature doesn't match spec (takes store instead of storedState)

### MINOR (Should address before Phase 1 completion)

1. **[MINOR]** Missing `.env.example` file artifact
2. **[MINOR]** `PaymentRequirementsRecord` vs `PaymentRequirements` naming could use glossary
3. **[MINOR]** Quote engine skips on-chain detection of assetTransferMethod (uses config boolean instead)
4. **[MINOR]** Permit2 broadcast witness object may be incomplete (missing some witness fields)
5. **[MINOR]** index.ts doesn't export core module functions (buildPaymentRequirements, etc.)
6. **[MINOR]** Settler doesn't populate `errorReason`/`errorMessage` fields in failure cases
7. **[MINOR]** Verifier's EIP-712 type reconstruction lacks validation
8. **[MINOR]** 1CS quote request may not match API expectations (refundAddress field handling unclear)

### INFO (Documented, acceptable for Phase 0)

1. **[INFO]** sql.js used instead of better-sqlite3 (in-memory by design for Phase 0)
2. **[INFO]** State store is in-memory only — persistence added in Phase 3
3. **[INFO]** Verifier skips simulation check — partial reimplementation vs @x402/evm reference
4. **[INFO]** SettlerOptions encapsulates confirmations parameter (not exposed to callers)
5. **[INFO]** TypeScript strict mode enabled — good practice
6. **[INFO]** Error handling uses class hierarchy with httpStatus codes — clean pattern

---

## 15. Specification Compliance Matrix

| Component | Phase | Roadmap Match | Logic Completeness | Critical Issues |
|-----------|-------|----------------|--------------------|-----------------|
| types.ts | 0 | 95% | 100% | None |
| config.ts | 0 | 100% | 100% | None |
| store.ts | 1.1 | 100% | 95% | None (idempotency not documented) |
| quote-engine.ts | 1.2 | 90% | 85% | Field mapping unclear; 4xx error handling |
| verifier.ts | 1.3 | 75% | 70% | Missing simulation; wrong signature; tolerance windows undocumented |
| settler.ts | 1.4 | 80% | 75% | while(true) loop blocks spec; permit2 witness incomplete |
| index.ts | 0 | 40% | 20% | Missing exports; no initialization |
| package.json | 0 | 100% | 100% | None |
| tsconfig.json | 0 | 100% | 100% | None |
| **Middleware** | 2.1 | **0%** | **0%** | **MISSING ENTIRELY** |

---

## 16. Recommendations

### Immediate (Block Phase 1 completion)

1. **Create src/middleware.ts** implementing the full HTTP request handler per spec Phase 2.1
   - Parse `PAYMENT-SIGNATURE` header
   - Route to quote-engine → 402 or verifier → settler → 200
   - Set response headers correctly

2. **Fix verifier.ts signature** to either:
   - Accept `storedState: SwapState` instead of doing the lookup, OR
   - Document why the implementation deviates (for better state management)

3. **Add simulation check to verifier** before approving signature:
   - Eth_call to `token.transferWithAuthorization()` for EIP-3009 path
   - Eth_call to `x402ExactPermit2Proxy.settle()` for Permit2 path

4. **Refactor settler's `pollUntilTerminal()`** to use promise-based pattern instead of while(true) loop

### Before Phase 2 completion

5. **Clarify 1CS field mapping**:
   - Verify exact field names in QuoteResponse (amountIn vs maxAmountIn)
   - Clarify refundAddress vs refundTo expectation
   - Test against actual 1CS SDK

6. **Create src/provider-pool.ts** per spec Phase 2.2

7. **Add `.env.example`** file with all required environment variables and defaults

8. **Extend index.ts exports** to include core module functions

### Before Phase 3 (Production Hardening)

9. **Add missing fields validation** in settler error responses (populate errorReason/errorMessage)

10. **Document tolerance windows** in verifier (why ±600s for validAfter, why ±6s for validBefore)

---

## Appendix A: Line-by-Line Issue References

```
quote-engine.ts:
  - Line 174 (originAsset vs assetIn): Verify 1CS field name
  - Line 282-283 (amountIn mapping): Document why using amountIn, not maxAmountIn
  - Line 204-213 (error handling): Add 429, 503 specific checks

verifier.ts:
  - Line 186 (ExactEvmPayloadV2): Document why cast needed
  - Line 301-306 (domain reconstruction): Add validation of extra fields
  - Line 345-354 (balance check): Missing simulation check
  - Line 510-519 (allowance check): Missing simulation check

settler.ts:
  - Line 465-517 (pollUntilTerminal while loop): Refactor to promise pattern
  - Line 641 (witness object): Document if fields are complete per Permit2 spec
  - Line 549 (payer field): Clarify semantics vs spec

index.ts:
  - Line 13-15 (exports): Add core module exports
```

---

## Conclusion

The x402-1CS gateway implementation is **structurally sound in its Phase 0 foundation** (types, config, store) but has **critical gaps in Phase 1 integration** (missing simulations in verifier, blocking loop in settler) and **complete absence of Phase 2 middleware**. The implementation is **not yet deployable** and requires addressing the 5 critical issues before proceeding to Phase 2. Estimated effort: 2-3 weeks to reach Phase 1 completion with all critical issues resolved.

