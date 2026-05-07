# What this gateway is — and when to actually use it

> **Audience:** anyone evaluating whether to deploy the `x402_1CS_gateway` instead of (or alongside) a canonical x402 setup. Operators, integrators, technical merchants.
>
> **Premise of this doc:** assume the gateway is production-ready. We're judging the *design*, not the polish.

---

## TL;DR

This service is **not a competitor to canonical x402** and not a "better x402." It is a **bridge** that does one specific thing: it takes a standard x402 payment denominated in USDC on an EVM chain (Base, Arbitrum, Polygon, etc.) and **delivers the value to a merchant on a different chain in a different asset** — NEAR, Solana, Stellar, Bitcoin, Tron, XRP, Cosmos chains, or any of the 30+ networks NEAR Intents supports.

If the merchant lives on the same chain the buyer is paying on, **don't use this gateway**. Use canonical x402 with a hosted facilitator (Coinbase's, or self-hosted). It's strictly simpler, faster, cheaper, and has a smaller trust surface.

The gateway exists for the cases canonical x402 cannot serve: a merchant whose treasury, accounting, or product lives outside EVM-USDC-on-Base, but who still wants to monetise HTTP endpoints via the x402 protocol.

---

## 1. The two flows side by side

### Canonical x402 (e.g., Coinbase's facilitator on Base)

```
Buyer (USDC on Base)  ──signs EIP-3009──►  Merchant wallet on Base
                          │
                          └─► Facilitator broadcasts the on-chain transfer to USDC contract
                              Settlement: ~2–5 s. Single chain. No swap. No quote. No slippage.
```

What the merchant runs: an Express middleware (`@x402/express` or equivalent) configured with their Base wallet address. That's it. The hosted facilitator does the verification + broadcast.

### This gateway

```
Buyer (USDC on Base)  ──signs EIP-3009──►  1CS deposit address (one-shot, per-request)
                                             │
Gateway broadcasts the transfer  ────────────┘
                          │
                          ▼
                    1CS detects deposit
                          │
                          ▼
            Cross-chain swap via NEAR Intents
                          │
                          ▼
       Merchant on NEAR / Solana / Stellar / Bitcoin / etc.
       receives the merchant's preferred asset
       Settlement: ~10–30 s typical, 5 min worst case.
```

What the merchant runs: this Express service, a funded facilitator wallet on the buyer's chain (for gas), an RPC pool, a SQLite state store, and a 1CS API key. It quotes 1CS per request, presents the **deposit address as `payTo`**, and polls 1CS until the cross-chain swap settles before returning 200.

---

## 2. The trick that makes it work

The single non-obvious move in this codebase is in `src/payment/quote-engine.ts`:

> The `payTo` field of the x402 `PaymentRequirements` envelope — which is normally the merchant's address — is set to the **1CS deposit address** instead.

That deposit address is one-shot, generated per-request by 1CS, and bound to a specific routing instruction ("when funds arrive here, swap them and send them to merchant X on chain Y"). The buyer's signature authorises a transfer to *that* address. From the buyer's wallet's perspective, this is a completely standard EIP-3009 `transferWithAuthorization` — they cannot tell anything special is happening. 1CS does the cross-chain leg automatically once it sees the deposit on-chain.

Everything else in the gateway exists to support that: quoting, state-machine tracking, broadcast, polling, refund accounting, error mapping, discovery surfaces.

---

## 3. Honest comparison — merchant perspective

| Dimension | Canonical x402 | This gateway |
|---|---|---|
| **Settlement chain options** | Whichever chain the buyer pays on (typically Base for USDC) | Any of 30+ NEAR Intents-supported chains |
| **Settlement asset options** | USDC (or whatever ERC-3009 token the chain has) | Anything 1CS supports — NEAR, SOL, USDC on N chains, ETH, BTC, XLM, XRP, ATOM, etc. |
| **Operator footprint** | Effectively none if using a hosted facilitator. A wallet address + the middleware. | Full Node.js service: facilitator wallet (gas), RPC pool, SQLite, 1CS account, env config (~15 vars), TLS termination. |
| **Settlement latency** | 2–5 s on Base | 10–30 s typical (cross-chain hop), bounded at 5 min |
| **Per-request cost** | Buyer pays exact `amount`. Merchant receives exact `amount` minus gas (paid by facilitator, sometimes recharged). | Buyer authorises `amountIn` (upper bound including slippage buffer, often ~5%). Merchant receives configured `MERCHANT_AMOUNT_OUT`. Excess refunds to the operator's `GATEWAY_REFUND_ADDRESS`, *not* the buyer. |
| **Pricing predictability** | Exact: signed = received | Range: signed = upper bound; received = exact merchant amount; difference = slippage refund to gateway |
| **Counterparty / trust surface** | The facilitator (whoever it is); the chain; USDC issuer. | All of the above **plus** 1CS as a centralised routing service that holds funds during the cross-chain leg. |
| **Liveness dependency** | Buyer's chain RPC + facilitator | Buyer's chain RPC + facilitator + 1CS API + destination chain availability |
| **Refund handling on failure** | Tx either succeeds or doesn't. No middle state. | If 1CS fails the swap mid-flight, funds refund to the gateway operator's `GATEWAY_REFUND_ADDRESS`. The operator must manually forward to the buyer. There is no on-protocol refund path back to the buyer. |
| **Discovery (x402scan, etc.)** | Standard `/openapi.json`, `/.well-known/x402` — both ecosystems are aligned. | Identical surfaces, plus a `extra.crossChain` informational block on the 402 envelope advertising the 1CS metadata. Spec-compliant; ignored by clients that don't care. |
| **Operator gas exposure** | Often zero (the hosted facilitator pays). | The operator funds a hot wallet on the buyer's chain. They pay every broadcast. Roughly $0.02 / request on Base today. |

### Why a merchant would still pick this gateway

Three honest reasons:

1. **They live off-EVM.** A NEAR-native dApp, a Solana program team, a Stellar issuer, a Bitcoin-treasury company. They want to monetise an HTTP API but they don't want to add EVM-USDC-on-Base to their accounting stack just to receive payments. With canonical x402, that's the only option. With this gateway, they keep their books in their native asset.

2. **They want one currency for accounting, regardless of where buyers are.** Imagine a NEAR-native AI agent platform that wants to accept payments from buyers paying in USDC on Base, USDC on Arbitrum, USDC on Polygon, ETH, SOL — all of them. Canonical x402 means the merchant ends up with seven different asset positions on seven different chains and has to reconcile/swap manually. This gateway lets the merchant configure *one* `MERCHANT_ASSET_OUT` (e.g., USDC on NEAR) and 1CS deals with the routing.

3. **They're already in the NEAR Intents ecosystem.** They have a NEAR account, they use 1CS for treasury or product flows, they want HTTP payments to plug into the same rails. The gateway is the path of least resistance.

### Why a merchant should *not* pick this gateway

Equally honest:

1. **They live on Base (or any USDC-on-EVM chain) and want USDC on Base.** Use canonical x402. There is no upside to adding 1CS as a hop — it's pure overhead: longer latency, more failure modes, slippage that the operator (not buyer) absorbs, gas the operator pays, a JWT to manage, an SQLite to back up.

2. **They run latency-sensitive endpoints.** Real-time inference, websocket-style streaming, anything where the user is staring at a spinner. 10–30 seconds of cross-chain settlement before returning 200 is a UX problem. Canonical x402 is sub-5-second.

3. **They need trust-minimised settlement.** This gateway adds 1CS as a centralised service that briefly custodies funds during the cross-chain leg. If your product premise is "trustless payments end-to-end," that's a regression. Canonical x402 settles on-chain only.

4. **They want hosted SaaS.** Pingpay (their Section 2 work) and similar services will offer x402-with-cross-chain-settlement as a managed product. A merchant who doesn't want to run anything themselves should probably wait for or use that, not deploy this code. This gateway is for operators who want to *own the rails* — no platform margin, full control, single-tenant ops.

---

## 4. Honest comparison — buyer / agent perspective

From the buyer's side, **the gateway is indistinguishable from canonical x402 at the wire level**. Same v2 envelope, same EIP-3009 (or Permit2) signing flow, same headers. A buyer using `@x402/core` or any standard x402 client SDK pays this gateway with no special-case code. That's by design and it is the most important piece of buyer-side news in the whole report.

But there are three real differences a thoughtful buyer would notice:

1. **The signed amount is an upper bound, not the exact amount.** The 402 envelope's `amount` field is `amountIn` — a slippage-buffered ceiling. If the swap executes at a better rate than quoted, the difference is refunded to the operator's `GATEWAY_REFUND_ADDRESS`, not the buyer. A user reading their wallet history will see a slightly larger USDC outflow than the merchant's stated price. The `extra.crossChain.amountOutUsd` field on the 402 envelope advertises the *value the merchant will receive*, so a transparent client can show both.

2. **The wait between sign-and-send and 200-response is longer.** ~10–30 seconds typical. Buyers wired for instant responses on Base may see this as a "did it work?" moment. The gateway returns the standard 200 + `PAYMENT-RESPONSE` once 1CS confirms settlement; clients that show a spinner during that window will be fine. Clients that timeout aggressively will fail.

3. **The trust assumption is broader.** The buyer is implicitly trusting (a) the gateway operator not to silently drop the cross-chain settlement, and (b) 1CS to honour the swap quote. In canonical x402, the buyer trusts only the chain and the facilitator's broadcast. This is rarely an issue in practice — both sides are economically incentivised to settle correctly — but it's a real change in the trust graph and worth naming.

---

## 5. Where this gateway sits in the ecosystem

It is best understood as **a specialised x402 facilitator that happens to do cross-chain currency conversion in-line with settlement**. It is not a replacement for canonical x402; it is a *route* a merchant chooses to expose if they want a non-EVM destination.

The directly-comparable products in the broader landscape:

- **Coinbase x402 (canonical):** same-chain settlement on Base. The gold standard for the simple case. We are not trying to compete here.
- **Pingpay §2 (hosted x402+1CS):** the *same idea as this gateway*, but as a managed multi-tenant SaaS. They take a margin; we take none. They own the merchant relationship; the operator of this gateway owns it themselves. Two delivery models for the same underlying primitive.
- **Pingpay's Toll:** an aggregator-marketplace fronting third-party APIs with a Pingpay margin. Not a facilitator — a reseller. Different category.
- **Generic facilitators (community-run, self-hosted x402 facilitator):** these handle on-chain broadcast for a merchant on the buyer's chain, but do not do cross-chain routing. This gateway is what you'd build if you took such a facilitator and added a 1CS swap leg.

The honest pitch for this gateway:

> *"You're a merchant who wants the agentic-payments distribution that x402 gives you, but you want to receive the funds wherever your treasury already is — without learning EVM, without holding bridge USDC, without manually swapping. You also don't want to depend on a hosted SaaS that charges per-payment. Run this and you get both."*

That is a real demand pocket. It is not a huge one in absolute terms (most merchants are happy on Base), but it is exactly the merchants the NEAR ecosystem is trying to attract, plus any non-EVM-native team building agentic-payment surfaces. For that audience, this is a good fit.

---

## 6. The compromise no one talks about

The x402 protocol was designed under an assumption — same-chain, same-asset, atomic settlement. The gateway loosens all three of those assumptions and the cost shows up in three specific places:

1. **The slippage refund goes to the operator, not the buyer.** This is a structural artifact of EXACT_OUTPUT swaps, not a bug. But it is a surface a thoughtful merchant has to be honest with their buyers about, especially in agentic flows where the agent might be making purchase decisions on a budget. The gateway emits the merchant's expected `amountOut` in the 402's `extra.crossChain.amountOut` block, but it's the merchant's responsibility to make that visible if they care.

2. **Settlement is no longer atomic with the HTTP response.** In canonical x402, the on-chain tx is broadcast and the HTTP 200 returns roughly together. In the gateway, the buyer's tx broadcast is fast, but the merchant only receives funds after 1CS completes the cross-chain leg. The gateway hides this by polling 1CS before returning 200 — but that means the HTTP request hangs for ~10–30 s. The protocol works; the latency is real.

3. **A new failure mode: cross-chain hang.** 1CS occasionally fails or times out. The state machine has a `FAILED` terminal state and recovery-on-restart logic, but operationally an operator has to handle "buyer sent funds, swap failed, refund stuck on the gateway's address" — manually forward to buyer or write tooling. Canonical x402 has no such failure mode.

None of these are dealbreakers. They are the price the design pays for unlocking cross-chain settlement, and they are explicit and well-documented in the codebase. A merchant choosing this gateway should choose it with eyes open on these three points.

---

## 7. Closing assessment

This service is **a competent, focused implementation of a narrow but real idea** — extend x402 to non-EVM merchant destinations via NEAR Intents 1CS. The codebase is well-organised, well-tested, and honest about its compromises. The one-trick architecture (`payTo` = deposit address) is elegant and protocol-compliant.

The merchant value proposition is real but specific:
- **Right buyer:** non-EVM-native team, NEAR-ecosystem-aligned, wants ownership of the rail, willing to operate a Node service.
- **Wrong buyer:** USDC-on-Base merchant, latency-sensitive use case, wants hosted SaaS, requires trust-minimised settlement.

For the right buyer, this is the most direct path to "x402 payments that settle in my preferred asset, without writing a bridge, without paying a platform margin." For the wrong buyer, canonical x402 is strictly better. The gateway is honest about which one you are.
