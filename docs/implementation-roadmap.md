# x402-1CS gateway — Implementation roadmap

## Phase 0: Project scaffolding
**Goal:** Buildable project with types, config, and test harness.

### Step 0.1 — Repository setup
- Init monorepo or single package with `tsconfig.json` (strict mode), ESLint, Prettier
- Dependencies: `@x402/core`, `@x402/evm`, `@defuse-protocol/one-click-sdk-typescript`, `ethers@6`, `express`, `zod` (for config/input validation)
- Dev dependencies: `vitest`, `supertest`, `msw` (for mocking 1CS and RPC)
- Environment: `.env.example` with all required vars (see config below)

### Step 0.2 — Configuration schema
Define and validate config at startup using zod:
```typescript
const GatewayConfigSchema = z.object({
  // 1CS
  oneClickJwt: z.string().min(1),
  oneClickBaseUrl: z.string().url().default("https://1click.chaindefuser.com"),
  
  // Merchant
  merchantRecipient: z.string().min(1),       // e.g. "merchant.near"
  merchantAssetOut: z.string().min(1),         // e.g. "near:nUSDC"
  merchantAmountOut: z.string().min(1),        // price in destination asset smallest unit
  
  // Origin chain
  originNetwork: z.string().regex(/^eip155:\d+$/),  // CAIP-2
  originAssetIn: z.string().min(1),                  // 1CS asset ID
  originTokenAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  originRpcUrls: z.array(z.string().url()).min(1),   // multiple for fallback
  
  // Gateway operations
  facilitatorPrivateKey: z.string().min(1),
  gatewayRefundAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  
  // Tuning
  maxPollTimeMs: z.number().default(300_000),
  pollIntervalBaseMs: z.number().default(2_000),
  pollIntervalMaxMs: z.number().default(30_000),
  quoteExpiryBufferSec: z.number().default(30),  // reject if <30s left on quote
  
  // Token metadata (for x402 extra fields)
  tokenName: z.string().default("USDC"),
  tokenVersion: z.string().default("2"),
  tokenSupportsEip3009: z.boolean().default(true),
});
```
**Deliverable:** `src/config.ts` — parse env vars, throw on invalid config at boot.

### Step 0.3 — Type definitions
```typescript
// src/types.ts

// Internal swap lifecycle
type SwapPhase = 
  | "QUOTED"       // 1CS quote obtained, 402 returned to buyer
  | "VERIFIED"     // Buyer signature verified
  | "BROADCASTING" // Tx submitted to origin chain
  | "BROADCAST"    // Tx confirmed on origin chain
  | "POLLING"      // Waiting for 1CS SUCCESS
  | "SETTLED"      // 1CS SUCCESS, 200 returned
  | "FAILED"       // 1CS FAILED/REFUNDED or timeout
  | "EXPIRED";     // Quote deadline passed before buyer signed

interface SwapState {
  depositAddress: string;
  quoteResponse: OneClickQuoteResponse;
  paymentRequirements: PaymentRequirements;  // The x402 object we returned in 402
  paymentPayload?: PaymentPayload;           // What the buyer sent back
  originTxHash?: string;
  oneClickStatus?: string;
  phase: SwapPhase;
  createdAt: number;
  updatedAt: number;
  settledAt?: number;
  settlementResponse?: SettlementResponse;
  error?: string;
}
```
**Deliverable:** `src/types.ts` with all internal and x402-aligned type definitions.

---

## Phase 1: Core modules (the critical path)
**Goal:** Each module works in isolation with unit tests.

### Step 1.1 — State store (persistent)
Replace the in-memory `Map` with a durable store. Two options depending on deployment:
- **SQLite** (via `better-sqlite3`) for single-instance deployments
- **Redis** for multi-instance / serverless

Interface:
```typescript
interface StateStore {
  create(depositAddress: string, state: SwapState): Promise<void>;
  get(depositAddress: string): Promise<SwapState | null>;
  update(depositAddress: string, patch: Partial<SwapState>): Promise<void>;
  
  // Cleanup
  listExpired(olderThanMs: number): Promise<string[]>;
  delete(depositAddress: string): Promise<void>;
}
```

Key behaviors:
- `create` must be idempotent (re-quoting same resource shouldn't create orphans)
- `update` uses optimistic locking (check phase transition is valid before writing)
- Background job prunes states older than 24h

**Deliverable:** `src/store.ts` + `src/store.test.ts`

### Step 1.2 — Quote engine
This module calls 1CS `/v0/quote` and transforms the response into an x402 `PaymentRequirements` object.

```typescript
// src/quote-engine.ts

async function buildPaymentRequirements(
  cfg: GatewayConfig,
  resourceUrl: string
): Promise<{ requirements: PaymentRequirements; state: SwapState }>
```

Implementation details:
- Call `OneClickService.getQuote()` with `swapType: "EXACT_OUTPUT"`, `dry: false`
- Map response fields per the field-mapping table (payTo = depositAddress, amount = maxAmountIn, etc.)
- Calculate `maxTimeoutSeconds` from 1CS `deadline`, subtract `quoteExpiryBufferSec` for safety margin
- Detect `assetTransferMethod`: check if origin token contract has `transferWithAuthorization` function selector; if yes → `"eip3009"`, else → `"permit2"`
- Persist new `SwapState` with phase `"QUOTED"` to store
- Return both the `PaymentRequirements` (for the 402 response) and the `SwapState`

Error cases to handle:
- 1CS returns 400 (bad asset pair) → throw `QuoteUnavailableError`
- 1CS returns 401 (JWT expired) → throw `AuthenticationError`
- 1CS returns 503 (service down) → throw `ServiceUnavailableError`
- Deadline is too short (< `quoteExpiryBufferSec`) → throw `DeadlineTooShortError`

**Deliverable:** `src/quote-engine.ts` + `src/quote-engine.test.ts` (mock 1CS with msw)

### Step 1.3 — Verifier
This module validates the buyer's `PAYMENT-SIGNATURE` payload against the stored `PaymentRequirements`.

```typescript
// src/verifier.ts

async function verifyPayment(
  paymentPayload: PaymentPayload,
  storedState: SwapState,
  provider: ethers.Provider
): Promise<{ valid: boolean; error?: string; signerAddress?: string }>
```

Implementation — **must handle both asset transfer methods**:

**EIP-3009 path:**
1. Decode `payload.authorization` from the `PaymentPayload`
2. Reconstruct the EIP-712 typed data hash for `TransferWithAuthorization`
3. `ecrecover` the signature → verify it matches `authorization.from`
4. Check `authorization.to === storedState.paymentRequirements.payTo` (the deposit address)
5. Check `authorization.value >= storedState.paymentRequirements.amount`
6. Check `validBefore > now` and `validAfter < now`
7. Call `token.balanceOf(from)` on-chain → verify sufficient balance
8. Simulate `token.transferWithAuthorization(...)` via `eth_call` → verify it doesn't revert

**Permit2 path:**
1. Decode `payload.permit2Authorization` from the `PaymentPayload`
2. Reconstruct the Permit2 `PermitWitnessTransferFrom` typed data hash
3. `ecrecover` → verify matches `permit2Authorization.from`
4. Check `witness.to === storedState.paymentRequirements.payTo`
5. Check `permitted.amount >= storedState.paymentRequirements.amount`
6. Check `deadline > now`
7. Verify Permit2 allowance: `ERC20.allowance(from, PERMIT2_ADDRESS) >= amount`
8. Simulate `x402ExactPermit2Proxy.settle(...)` via `eth_call`

**Important:** You can lean on `@x402/evm`'s `ExactEvmScheme` internals here. Study `typescript/packages/evm/src/exact/` in the x402 repo — the `verify` function already implements both paths. The key adaptation is ensuring you pass the *correct* `PaymentRequirements` object (the one you stored, not the raw 1CS quote).

After verification, update store: `phase → "VERIFIED"`, save `paymentPayload` and `signerAddress`.

**Deliverable:** `src/verifier.ts` + `src/verifier.test.ts`

### Step 1.4 — Settler
The most complex module. Handles on-chain broadcast, 1CS notification, and status polling.

```typescript
// src/settler.ts

async function settle(
  depositAddress: string,
  store: StateStore,
  cfg: GatewayConfig
): Promise<SettlementResult>

type SettlementResult = 
  | { success: true; response: SettlementResponse }
  | { success: false; error: string; refundInfo?: RefundInfo }
```

Sub-steps, each with its own error handling:

**Step A — Broadcast transaction:**
```typescript
// Must support both EIP-3009 and Permit2
async function broadcastTransfer(
  state: SwapState,
  wallet: ethers.Wallet
): Promise<ethers.TransactionReceipt>
```
- For EIP-3009: call `token.transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, signature)`
- For Permit2: call `x402ExactPermit2Proxy.settle(permit, transferDetails, owner, witness, signature)`
- Gas estimation: use `estimateGas()` with 20% buffer; if facilitator wallet balance < estimated gas → abort with `InsufficientGasError`
- Wait for receipt with configurable confirmations (1 for L2s, 2 for L1)
- On tx revert: check revert reason (nonce already used? → duplicate; insufficient balance? → stale quote)

**Step B — Notify 1CS:**
```typescript
async function notifyDeposit(
  depositAddress: string, 
  txHash: string
): Promise<void>  // fire-and-forget, non-fatal
```

**Step C — Poll 1CS status:**
```typescript
async function pollUntilTerminal(
  depositAddress: string,
  cfg: GatewayConfig,
  onStatusChange?: (status: string) => void
): Promise<OneClickStatus>
```
- Exponential backoff: `interval = min(base * 1.5^attempt, maxInterval)`
- Total timeout: `maxPollTimeMs` from config
- Terminal states: `SUCCESS`, `FAILED`, `REFUNDED`
- On each poll, update store with latest status
- **CRITICAL: This must NOT block the Express event loop.** Use a promise-based approach with `setTimeout`, not a `while(true)` loop. The middleware `await`s this promise, which is fine since Express handles each request in its own async context — but make sure no synchronous blocking occurs inside the loop.

**Step D — Build settlement response:**
Map 1CS terminal status to x402 `SettlementResponse`.

**Deliverable:** `src/settler.ts` + `src/settler.test.ts` (mock both RPC and 1CS)

---

## Phase 2: Integration layer
**Goal:** Wire modules into Express middleware, end-to-end flow works.

### Step 2.1 — Middleware assembly
```typescript
// src/middleware.ts

function x4021CSMiddleware(
  cfg: GatewayConfig,
  store: StateStore,
  providerPool: ProviderPool
): express.RequestHandler
```

Request flow:
1. Check `PAYMENT-SIGNATURE` header
2. **No header →** call Quote Engine → set `PAYMENT-REQUIRED` header → return 402
3. **Header present →** decode payload → look up `SwapState` by `payTo` (deposit address)
   - State not found → return 402 with fresh quote
   - State found but expired → delete state, return 402 with fresh quote
   - State found and valid → call Verifier
4. **Verification fails →** return 402 with error details
5. **Verification passes →** call Settler (async, but we await the result)
6. **Settlement succeeds →** set `PAYMENT-RESPONSE` header → call `next()`
7. **Settlement fails →** set `PAYMENT-RESPONSE` header with failure → return 502

Edge case: if the store already has this deposit address at phase `"SETTLED"` (buyer retried after timeout but settlement actually completed), return cached 200.

**Deliverable:** `src/middleware.ts`

### Step 2.2 — RPC provider pool
```typescript
// src/provider-pool.ts

class ProviderPool {
  constructor(rpcUrls: string[]);
  getProvider(): ethers.JsonRpcProvider;    // round-robin with health checks
  getWallet(pk: string): ethers.Wallet;    // wallet bound to healthy provider
}
```
- Health check: periodic `eth_blockNumber` call
- Automatic failover if primary RPC is down
- Connection reuse (don't create new providers per request)

**Deliverable:** `src/provider-pool.ts`

### Step 2.3 — End-to-end integration tests
Using `supertest` + `msw`:
- Mock 1CS API responses (quote, deposit, status transitions)
- Mock EVM RPC (balance checks, tx simulation, tx broadcast)
- Test the full flow: GET → 402 → GET with signature → 200
- Test error paths: expired quote, failed swap, refund, timeout

**Deliverable:** `test/e2e/` directory

---

## Phase 3: Production hardening
**Goal:** Safe to deploy behind real traffic.

### Step 3.1 — Gas management
- Monitor facilitator wallet balance on startup and periodically
- Alert (log/webhook) when balance drops below threshold
- Reject new settlements (return 503) if gas balance is critically low
- Track gas spent per settlement for cost accounting

### Step 3.2 — Observability
- Structured logging (pino or winston) with correlation ID per request
- Metrics: quote latency, settlement latency, 1CS poll count, success/fail ratio
- Health endpoint: `/health` returns facilitator balance, 1CS connectivity, RPC status

### Step 3.3 — Rate limiting and abuse prevention
- Per-IP rate limit on quote generation (each quote creates a real 1CS deposit address)
- Configurable max concurrent settlements
- Quote garbage collection: background job deletes `QUOTED` states older than `deadline + 5min`

### Step 3.4 — Refund routing (v1)
When 1CS returns `REFUNDED`:
- Funds are at `gatewayRefundAddress` (the gateway's own address)
- Look up `signerAddress` from the stored `SwapState`
- Queue an ERC-20 transfer from gateway refund address to buyer's signer address
- Log and alert — this is an edge case that needs manual monitoring initially

### Step 3.5 — Graceful shutdown
- On SIGTERM: stop accepting new requests
- Wait for in-flight settlements to complete (up to `maxPollTimeMs`)
- For settlements that can't complete: persist their state, pick them up on restart
- The persistent state store (Step 1.1) makes this possible

---

## Phase 4: Extensions (post-launch)
**Goal:** Feature completeness per the architecture doc.

### Step 4.1 — Multi-asset accepts
- Accept config as array of `{originNetwork, originAssetIn, originTokenAddress}`
- On quote, call 1CS in parallel for each origin asset
- Return multiple entries in the `accepts` array
- Verifier and Settler dispatch on `paymentPayload.accepted.network`

### Step 4.2 — Two-phase quote (solving refundTo properly)
- Phase 1: return `dry: true` quote in 402 (no deposit address yet)
- When buyer submits payment: extract `from` address from signature
- Phase 2: call 1CS with `dry: false` and `refundTo: from`
- Verify the buyer's signed authorization covers the new (potentially different) `maxAmountIn`
- This eliminates the gateway-as-refund-intermediary pattern

### Step 4.3 — Fast-settle mode (Option B from architecture)
- Config flag: `settlementMode: "full" | "fast"`
- Fast mode: return 200 after origin-chain tx confirmation (standard x402 behavior)
- Poll 1CS in background, log failures for manual resolution
- Useful for low-value resources where speed matters more than cross-chain guarantee

### Step 4.4 — Quote endpoint as standalone API
- Expose `GET /x402-1cs/quote?assetIn=...&amount=...` as a public endpoint
- Returns the `PaymentRequirements` object without requiring a protected resource
- Useful for clients that want to pre-fetch pricing before committing to a request
