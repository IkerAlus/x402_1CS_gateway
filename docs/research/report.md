# Untitled

## 1. Component overview

The component we're designing — let's call it **x402-1CS Gateway** — acts as *both* the x402 resource server and the x402 facilitator in a single deployment. This is a deliberate architectural choice: since we control the settlement layer (1Click Swap API), there's no need to delegate verification and settlement to an external facilitator. The gateway handles the full lifecycle internally: quoting, 402 response construction, payment verification, on-chain settlement via 1CS, and status polling.

The key insight is that the standard `exact` EVM scheme is used *unmodified*. The buyer's wallet signs a `transferWithAuthorization` (EIP-3009) or `permitWitnessTransferFrom` (Permit2) exactly as it would for any x402 payment. The difference is entirely on the server side: instead of the facilitator broadcasting that signed authorization to the origin chain and waiting for confirmation, the gateway directs the funds to a 1CS deposit address and uses 1CS's cross-chain settlement engine to deliver the merchant's preferred asset on the destination chain.

![x402_1cs_gateway_architecture_v2.svg](Untitled/x402_1cs_gateway_architecture_v2.svg)

The architecture has five core modules within the gateway, plus two external systems. Let me detail each.

---

## 2. Internal modules

**Quote Engine** — Handles incoming `GET` requests to protected resources. When no `PAYMENT-SIGNATURE` header is present, it calls the 1CS `/v0/quote` endpoint with `EXACT_OUTPUT` to determine what the buyer needs to pay. It then constructs the `PaymentRequirements` object and returns `HTTP 402`.

**Verifier** — When the buyer retries with a `PAYMENT-SIGNATURE` header, this module performs standard EVM `exact` scheme verification: recovers the signer from the EIP-3009 authorization or Permit2 witness signature, checks the buyer's on-chain balance, validates amount/deadline/nonce, and simulates the `transferWithAuthorization` or `permitWitnessTransferFrom` call.

**Settler** — Broadcasts the signed transfer on the origin chain, directing funds to the 1CS `deposit_address`. Then enters a polling loop on the 1CS `/v0/status` endpoint until the swap reaches `SUCCESS` (or `FAILED`/`REFUNDED`). Only after `SUCCESS` does it return `200 OK` to the buyer.

**State Store** — Maps `deposit_address` → `{quoteId, paymentPayload, originTxHash, 1csStatus, timestamps}`. This is the correlation layer that ties the x402 payment flow to the 1CS swap lifecycle.

---

## 3. End-to-end workflow

Here's the complete sequence, step by step. I'll number each interaction to make the flow unambiguous.

![x402_1cs_sequence_flow.svg](Untitled/x402_1cs_sequence_flow.svg)

visualize show_widget

The workflow breaks into three phases:

**Phase 1 — Quote & 402 construction (steps 1–4).** The buyer requests a resource. The gateway calls 1CS `/v0/quote` with `swapType: EXACT_OUTPUT`, specifying the merchant's desired destination asset, destination chain, and recipient address. The 1CS response includes `deposit_address`, `maxAmountIn`, `minAmountIn`, and `deadline`. The gateway maps these into the x402 `PaymentRequirements` object and returns `HTTP 402`.

**Phase 2 — Signature & verification (steps 5–6).** The buyer's wallet signs an EIP-3009 `transferWithAuthorization` (for USDC) or a Permit2 `permitWitnessTransferFrom` (for other ERC-20s). The `to` / `witness.to` field is set to the 1CS `deposit_address` (which was provided as `payTo` in the 402 response). The gateway verifies this signature locally using standard `exact` EVM verification logic — no external facilitator needed.

**Phase 3 — Settlement via 1CS (steps 7–13).** The gateway broadcasts the signed transaction to the origin chain, sending funds to the `deposit_address`. It optionally calls `/v0/deposit` with the txHash to accelerate processing. Then it polls `/v0/status` until the 1CS swap reaches `SUCCESS`. Only then does the gateway respond `200 OK` with the `PAYMENT-RESPONSE` header and the requested resource.

---

## 4. Field mapping — `PaymentRequirements` construction

This is the critical translation layer. Here's exactly how each 1CS quote field maps to the x402 `PaymentRequirements` schema:

PaymentRequirements Field Mapping

Document

# PaymentRequirements field mapping: 1CS Quote → x402

## Core fields

| x402 field | Source | Derivation |
|---|---|---|
| `scheme` | Static | `"exact"` — standard EVM exact scheme, no custom scheme |
| `network` | Gateway config | CAIP-2 chain ID o

The field mapping above is the heart of the design. A few things worth calling out:

The `payTo` field is set to the 1CS `deposit_address`, *not* to the merchant's address. This is the fundamental trick: from the buyer's perspective, they're making a standard x402 payment to a `payTo` address. They have no idea (nor need to know) that this address is a 1CS deposit address that triggers a cross-chain swap. The `extra` fields carry informational context about what happens after the payment, but they don't affect the buyer's signing logic.

The `amount` uses `maxAmountIn` to ensure the signed authorization always has sufficient headroom. If the actual market execution is better, the excess is refunded by 1CS to the `refundTo` address.

---

## 5. 1CS API interaction details

The gateway uses three 1CS endpoints. Here's exactly how each is called:

**`POST /v0/quote`** — Called in Phase 1 when the buyer first requests the resource.

jsonc

`// Request
{
  "assetIn": "base:USDC",           // Buyer's origin asset
  "assetOut": "near:nUSDC",         // Merchant's desired asset
  "amount": "10000000",             // Merchant's desired amount (EXACT_OUTPUT)
  "swapType": "EXACT_OUTPUT",
  "slippageTolerance": 50,          // 0.5% in basis points
  "recipient": "merchant.near",     // Merchant's destination address
  "refundAddress": "0xBuyerAddr",   // Buyer's origin-chain address for refunds
  "refundTo": "0xBuyerAddr",
  "deadline": "2026-03-27T16:00:00Z",
  "dry": false                      // We need a real deposit_address
}`

The `refundAddress` / `refundTo` presents a design decision: at quote time the buyer hasn't identified themselves yet. Two approaches are possible. **Option A** (simpler): use a gateway-controlled refund address and handle refund routing internally. **Option B** (two-phase quote): do a `dry: true` quote first for the 402 response, then re-quote with the buyer's actual address after receiving the signed payment. I'll address this in the design decisions section below.

**`POST /v0/deposit`** — Called in Phase 3 after broadcasting the signed transfer.

jsonc

`{
  "depositAddress": "0x1CS_DEPOSIT_ADDRESS",
  "transactionHash": "0xOriginChainTxHash"
}`

This is optional but recommended — it tells 1CS to proactively look for the deposit rather than waiting for its own chain indexer to detect it, reducing settlement latency.

**`GET /v0/status?depositAddress=0x...`** — Called repeatedly in Phase 3.

Returns a status object with values like `PENDING_DEPOSIT`, `PROCESSING`, `SUCCESS`, `FAILED`, `REFUNDED`. The gateway polls this with exponential backoff (starting at 2s, max 30s) until a terminal state is reached.

---

## 6. Settlement response

When 1CS reports `SUCCESS`, the gateway constructs the x402 `SettlementResponse` and returns it in the `PAYMENT-RESPONSE` header (base64-encoded JSON):

jsonc

`{
  "success": true,
  "transaction": "0xOriginChainTxHash",
  "network": "eip155:8453",
  // Cross-chain settlement info in the extra field
  "extra": {
    "settlementType": "crosschain-1cs",
    "destinationTxHash": "...",     // from 1CS status response
    "destinationChain": "near",
    "destinationAmount": "10000000",
    "destinationAsset": "nUSDC",
    "swapStatus": "SUCCESS"
  }
}`

This is a key divergence from standard x402 behavior. Normally, the `SettlementResponse` is returned as soon as the origin chain confirms the transfer. Here, the response is held until the *entire cross-chain swap completes*. This means the buyer waits longer (potentially 30–120s depending on chains) but receives a stronger guarantee: the merchant has actually received their funds.

---

## 7. Key design decisions

Let me lay out the trade-offs that define this architecture:

![design_decisions_overview.svg](Untitled/design_decisions_overview.svg)

visualize show_widget

Let me expand on each decision:

**D1: Settlement timing** — This is the biggest departure from standard x402. In standard EVM x402, the facilitator broadcasts the signed transfer and waits for the origin chain to confirm (a few seconds on L2s). Here, we're waiting for the full cross-chain swap. The recommended approach (Option A) waits for 1CS `SUCCESS`, giving the merchant a guarantee that they've actually received funds on the destination chain. Option B would return `200 OK` after the origin-chain tx confirms (just like standard x402) and treat the cross-chain settlement as an internal process. Option B is simpler but means the merchant's resource is served before they've been paid on their preferred chain. Both options can coexist as a gateway configuration flag.

**D2: refundTo resolution** — The 1CS quote requires a `refundAddress` (where funds go if the swap fails), but the buyer hasn't identified themselves when the 402 response is constructed. The simplest v1 approach: use a gateway-controlled address as the refund target, and handle reimbursement to the actual buyer if a refund occurs (the buyer's address is known from the signed authorization). A more elegant future approach: return a `dry: true` quote in the 402, then re-quote with the actual buyer address when the signed payment arrives.

**D3: Deposit address TTL** — Each 1CS deposit address has a `deadline`. If the buyer takes too long to sign and submit, the address expires. The gateway should check this before attempting verification: if `deadline` has passed, discard the stale quote and return a fresh `402` with a new quote. The `maxTimeoutSeconds` field in the 402 response communicates this deadline to the buyer's client.

**D4: Multi-asset support** — The x402 `accepts` array can contain multiple `PaymentRequirements`, one per accepted asset/chain combination. The gateway could call 1CS `/v0/quote` for several origin assets in parallel (e.g. USDC on Base, USDC on Arbitrum, WETH on Ethereum) and return them all in a single 402 response. The buyer's client picks the one that matches their wallet. This is a natural extension of the architecture — each quote produces its own `deposit_address` and maps to its own `accepts` entry.

---

## 8. Error handling and edge cases

**Quote failure** — If 1CS `/v0/quote` returns an error (unsupported pair, insufficient liquidity), the gateway should return `HTTP 503 Service Unavailable` rather than a malformed 402.

**Swap failure / refund** — If 1CS status reaches `FAILED` or `REFUNDED`, the gateway returns `HTTP 502 Bad Gateway` with a `PAYMENT-RESPONSE` header containing `success: false` and refund details. The buyer's funds are refunded by 1CS to the `refundAddress`.

**Timeout** — If polling `/v0/status` exceeds a configurable maximum (e.g. 5 minutes), the gateway returns `HTTP 504 Gateway Timeout`. The buyer can retry or check the 1CS explorer using the `deposit_address`.

**Duplicate payments** — The state store must deduplicate by `deposit_address`. If the same signed authorization is submitted twice, the second request returns the cached settlement result.

**Nonce replay** — Standard EVM exact scheme verification handles this: the EIP-3009 nonce or Permit2 nonce ensures a signed authorization can only be used once on-chain.