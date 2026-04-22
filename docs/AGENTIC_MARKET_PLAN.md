# Agentic.Market Integration — Implementation Plan

**Date drafted:** 2026-04-22
**Target:** list this gateway on [Agentic.Market](https://agentic.market/), Coinbase's public x402 service marketplace (launched 2026-04-20).
**Related:** [X402SCAN_PLAN.md](./X402SCAN_PLAN.md) — complementary crawler-based discovery (Phases 1-4 shipped). The Bazaar work shared with this plan is Phase 5 of that doc (deferred).

---

## What Agentic.Market is (from Coinbase's own announcement)

> "Agentic.Market is a public directory of x402-enabled services. It's designed to be the default starting point for anyone — human or machine — to discover what's available in the agentic economy."
> — [Introducing Agentic.Market, 2026-04-20](https://www.coinbase.com/developer-platform/discover/launches/agentic-market)

Two consumption surfaces, same data:

| Surface | Audience | Access |
|---|---|---|
| [agentic.market](https://agentic.market/) | Developers, humans evaluating services | Web UI — category filter, semantic search, service profiles, integration guides |
| **BazaarMCP** | AI agents | MCP server — programmatic search/filter/evaluate at runtime |

No account, no login, no saved state. Launch scale: 165M+ tx, ~$50M+ volume, 480K+ transacting agents, 70 curated services across inference / data / media / search / social / infrastructure / trading.

### Agentic.Market ↔ x402 Bazaar

Agentic.Market is the **marketplace UI + MCP**. [x402 Bazaar](https://docs.cdp.coinbase.com/x402/bazaar) is the **backend index** that powers it. Every path into Agentic.Market documented by Coinbase today routes through Bazaar — there is no separate "submit to Agentic.Market" endpoint, portal, or form.

So: **integrating with Agentic.Market = getting our resources into Bazaar's index = either (a) curation by Coinbase or (b) automatic indexing via a CDP Facilitator that sees our Bazaar-extension metadata.**

---

## What Agentic.Market shows per service

From the launch post, a service profile carries:

- **Live metrics from real transaction data:**
  - Total calls
  - Unique payers
  - Pricing
  - Last-active timestamp
- **Endpoint shape:**
  - URL + HTTP method
  - Supported networks
  - Pricing ranges
- **Category tag** (Inference, Data, Media, Search, Social, Infrastructure, Trading)
- **For curated services only:** human-readable enrichment, higher sort position

All metrics except the static endpoint shape are **derived from chain activity**, not self-reported. A service that receives zero payments has a profile card but no trust signals.

**Implication for us:** to get meaningful visibility, we need both (a) the resource to be in the index with correct static metadata, and (b) a facilitator that sees our settlements so chain-derived metrics accumulate against our listing.

---

## The two listing tiers

The launch post is explicit about a tiered model:

> "Services are indexed automatically. When the CDP Facilitator processes a payment on an endpoint with the Bazaar discovery extension enabled, it extracts metadata and indexes the resource, with no separate registration step required. **Curated services are enriched with human-readable metadata and sort above the rest.**"

### Tier 1 — Automatic indexing (self-serve)

**Prerequisites:**
1. Service emits the Bazaar extension on its x402 challenge (`extensions.bazaar.info` with at minimum `name`, `description`, `inputSchema`, `outputSchema`)
2. Service's payments route through the CDP Facilitator (so it sees the metadata during `verify` / `settle`)
3. CDP supports the origin network (Base, Polygon, Arbitrum, World, Solana-SPL today)

Trigger: first payment on the endpoint after the extension is enabled. Listing is automatic from that point; profile updates continuously from live transaction data.

### Tier 2 — Curated (by Coinbase)

70 services at launch. Coinbase-selected, enriched with handwritten descriptions, sort above auto-indexed entries in search. No published application process — appears to be outbound partnership by Coinbase (OpenAI, Anthropic, Alchemy, CoinGecko, etc.).

For a gateway like ours with a differentiated value prop (cross-chain destination via 1CS), curation is the more valuable slot — it explains what the service actually does to a human reader and outranks commodity services. But it's not a self-serve path.

---

## Why this gateway is a non-obvious fit for Tier 1

Every architectural decision in this gateway flows from one choice: `PaymentRequirements.payTo` is the **1CS deposit address**, not the merchant. The gateway must control the broadcast path to keep that substitution working cross-chain:

- Buyer signs EIP-3009/Permit2 authorization to the 1CS deposit address
- Gateway broadcasts `transferWithAuthorization` on Base ([settler.ts](../src/settler.ts))
- Gateway calls `/v0/deposit/submit` on 1CS with the tx hash ([settler.ts](../src/settler.ts))
- 1CS cross-chain-routes to the merchant's actual chain

Tier 1 requires the **CDP Facilitator** to process the payment. Structurally that could still work — CDP's `settle` just broadcasts `transferWithAuthorization` to the address in the authorization (the 1CS deposit address), so the on-chain transfer lands correctly. But:

- The `/v0/deposit/submit` notification has no natural hook in a CDP-driven flow. Gateway would need to observe settlement and still call 1CS itself — adding a fragile race condition to the hot path.
- CDP may impose allowlists on `payTo` (fraud/compliance screening). Unverified.
- CDP costs: 1k tx/month free, then $0.001/tx. The gateway operator absorbs this.
- Hard dependency on a hosted third-party for every payment. Today the gateway is dependency-free on the broadcast side.

See the "Integration Paths" section below for how to proceed given these tradeoffs.

---

## Readiness Assessment

### Already in place

- ✅ v2 `PAYMENT-REQUIRED` envelope with correct `accepts[]` shape ([middleware.ts](../src/middleware.ts))
- ✅ Protected-routes registry carrying `inputSchema` / `outputSchema` / `description` per route ([protected-routes.ts](../src/protected-routes.ts)) — **ready to emit as Bazaar metadata; just needs plumbing**
- ✅ x402scan discovery surfaces ([openapi.ts](../src/openapi.ts), [discovery.ts](../src/discovery.ts)) and EIP-191 ownership proofs ([ownership-proof.ts](../src/ownership-proof.ts))
- ✅ A facilitator EVM key + balance check already in the request path
- ✅ Category mapping is trivial — "Infrastructure" fits this gateway's value prop

### Gap Analysis

| Agentic.Market Requirement | Source | Current State | Gap | Severity |
|---|---|---|---|---|
| `extensions.bazaar.info` on the 402 challenge | [Bazaar spec](https://docs.cdp.coinbase.com/x402/bazaar) | **Not emitted** — Phase 5 of [X402SCAN_PLAN.md](./X402SCAN_PLAN.md) deferred (see [docs/TODO.md:50](./TODO.md)) | Wire `route.summary` / `route.description` / `route.inputSchema` / `route.outputSchema` from the registry into the envelope | **Blocker** for any automatic indexing |
| Payments route through CDP Facilitator | Announcement quote | **None** — gateway self-facilitates via `FACILITATOR_PRIVATE_KEY` | Implement hybrid or full CDP delegation (see Paths B/C) | **Blocker** for Tier 1 |
| CDP supports origin network | [CDP Facilitator docs](https://docs.cdp.coinbase.com/x402/core-concepts/facilitator) | Our origin is Base — ✅ supported | None | N/A |
| Service profile metadata (name, description, inputSchema, outputSchema, pricing) | Implied by UX fields | All present in [protected-routes.ts](../src/protected-routes.ts) | None for data; plumbing missing | Low |
| Supported-networks field | UX fields | We can derive from `cfg.originNetwork` | Need to emit it consistently in Bazaar metadata | Low |
| Curation (Tier 2) | Announcement | Not approached | Reach out to Coinbase DevRel | **Blocker only if targeting Tier 2** |
| Public HTTPS domain | Implicit | Local/dev only | Deploy-time blocker, not code | Handled out of band |

---

## Open Questions

Resolve these before committing engineering time to Paths B or C. Path A and Path E (curation ask) are safe to pursue now.

### Q1. Does CDP Facilitator settle to arbitrary `payTo` addresses?

The 1CS deposit address is a fresh, randomly-generated EVM address per quote. Does CDP's `settle` endpoint:
- Accept any valid address?
- Impose allowlists / block-lists?
- Flag high-velocity to-different-addresses patterns as suspicious?

**How to resolve:** wire a single request through CDP's `verify` (and ideally `settle`) in a staging deploy. If `verify` accepts, `settle` will — the contract call is the same shape.

### Q2. Can CDP `verify` be called standalone, without committing to CDP `settle`?

If yes, this enables a hybrid: we call CDP `verify` for its metadata-cataloging side effect, then continue to broadcast via our own key. If no, we're forced into full delegation (Path C) for Tier 1 listing.

**How to resolve:** read the CDP Facilitator API docs end to end, or open a support ticket.

### Q3. Does Bazaar catalog a resource on `verify` alone, or does it require a successful `settle`?

The announcement says "when the CDP Facilitator processes a payment" — ambiguous. If `settle` is required for indexing, the hybrid in Q2 is not useful for listing even if it's technically possible.

**How to resolve:** inspect Agentic.Market for listings of services whose `verify` succeeded but whose settlements happen outside CDP. Or ask in x402 community channels.

### Q4. Is `@x402/extensions/bazaar` compatible with our custom middleware?

Our [middleware.ts](../src/middleware.ts) is a custom Express implementation, not the SDK's `paymentMiddleware()`. Need to check:
- Is the extension a drop-in builder we can call with a `ProtectedRoute`, or does it assume the SDK's middleware shape?
- Version availability: the extension launched with Agentic.Market weeks ago; stability unclear.

**How to resolve:** `npm view @x402/extensions/bazaar` + read its README. If incompatible, hand-roll the envelope shape (it's just a JSON blob — not risky).

### Q5. Will 1CS / NEAR Intents eventually operate a Bazaar-aware facilitator?

The cleanest architecture: 1CS itself exposes `/discovery/resources` and catalogs gateway integrations automatically. Then we'd need zero CDP coupling.

**How to resolve:** ask the NEAR Intents team directly (user is on that team — iker.alustiza@nearone.org).

### Q6. Does Coinbase DevRel curate on request, or is curation outbound-only?

Curation is the higher-value listing tier (human description, above-the-fold sort). Coinbase doesn't publish an application form. But the 70 launch partners are high-profile services Coinbase actively recruited — it's plausible they accept inbound requests from credible operators.

**How to resolve:** direct outreach to Coinbase DevRel (Nick Prince / Danny Organ, announcement authors). Timing matters — better to reach out after our service has production traffic and a clear differentiation story.

### Q7. How is chain activity attributed to our listing if we don't use CDP Facilitator?

If we're listed via curation (Tier 2) but our settlements don't flow through CDP, Bazaar can't derive usage metrics. Our profile would show zero calls / zero payers regardless of real traffic. This defeats the point of listing.

**How to resolve:** understand (Q3) whether Bazaar can attribute on-chain payments to a listing via `payTo` address matching (unlikely given our rotating deposit addresses), or whether it hard-requires CDP Facilitator touch.

---

## Integration Paths (ranked)

### Path A — **Emit Bazaar metadata, don't change facilitation yet** (always do this first)

Implement server-side Bazaar metadata (`extensions.bazaar.info` on the 402 envelope) without changing the settlement path. This is Phase 5 of [X402SCAN_PLAN.md](./X402SCAN_PLAN.md), already scoped and deferred.

**Pros:**
- Zero change to settlement path — preserves 1CS integration.
- Small, additive, reversible.
- Unblocks Paths B/C/D without prejudice.
- Improves our x402scan classification independently.
- Any future Bazaar-aware facilitator (1CS included) can catalog us without further code.

**Cons:**
- Alone, it does nothing for Agentic.Market — metadata is emitted but no facilitator sees it yet.

**Do this now.** It's a prerequisite for every other path.

### Path B — **Hybrid: CDP Facilitator for `verify` + our own broadcast**

Call CDP's `/verify` on every request (for its cataloging side effect), keep `/settle` + `/v0/deposit/submit` on our side.

**Pros:**
- Potentially gets us into Tier 1 without restructuring the broadcast path.
- Incremental dependency — CDP becomes a peer, not a replacement.

**Cons:**
- Depends on Q2 (CDP `verify` callable standalone?) and Q3 (Bazaar indexes on `verify` alone?). If either is no, this doesn't work.
- Adds a hot-path HTTP call with its own error surface.
- Possible for CDP's profile signals to be corrupted — CDP sees `verify` but no `settle`, which may look fraud-adjacent.

**Pursue only if Q2 and Q3 both resolve favorably.**

### Path C — **Full CDP Facilitator delegation**

Broadcast through CDP. Observe settle receipt. Then call `/v0/deposit/submit` on 1CS.

**Pros:**
- Canonical Tier 1 path, as Coinbase intends.
- Automatic profile metrics, no extra integration.
- Removes facilitator key + gas management from the operator.

**Cons:**
- Vendor lock-in for every settlement.
- Dual-step broadcast (CDP settles → we observe → we notify 1CS) adds race conditions.
- CDP free tier 1k/month → operator cost curve.
- CDP origin-chain list excludes future origins we may want (NEAR, Stellar, etc.).
- Architecturally significant; reversible but expensive to re-reverse.

**Defer. Path A or curation covers most of the value at much lower risk.**

### Path D — **Wait for 1CS to be Bazaar-aware**

1CS could expose its own Bazaar facilitator surface.

**Pros:**
- Architecturally cleanest — gateway stays unchanged.
- NEAR Intents has the vantage point to see every deposit and could catalog natively.

**Cons:**
- Depends on Q5 — currently speculation.
- Even if yes, timeline unclear. Not a near-term listing strategy.

**Raise with the NEAR Intents team, but don't block on it.**

### Path E — **Request curation from Coinbase** (new — I missed this in the first draft)

Direct outreach to Coinbase DevRel / x402 team with a pitch: this is a cross-chain payment gateway that bridges x402 to 32+ chains via 1CS. Curation makes sense because:
- The value prop needs a human description to parse (generic auto-indexed metadata won't explain "pay with USDC on Base, merchant receives anything on any chain")
- It's complementary to their existing inference/data/media curated partners — infrastructure category is thin at launch
- Successful curation unblocks the metrics problem (Q7) if Coinbase can attribute activity to our listing without CDP Facilitator touch

**Pros:**
- Sidesteps Tier 1's CDP Facilitator requirement entirely (if Coinbase can source metrics differently for curated entries).
- Higher-quality listing (sort above auto-indexed).
- Low engineering cost — a pitch email, not code.

**Cons:**
- Unpublished process — reliance on human relationship.
- May get a "come back when you have production traffic" response.
- Q7 is still unresolved: Coinbase may require CDP touch for metrics even for curated entries.

**Pursue in parallel with Path A.** Lowest cost, potentially highest upside.

---

## Recommended Path

**Do Path A and Path E in parallel.** Gate Paths B/C on Q1-Q3 resolution. Raise Q5 with 1CS team as a background question.

---

## Implementation Phases (for Path A)

### Phase 1 — `extensions.bazaar.info` on the 402 envelope

Pick up Phase 5 of [X402SCAN_PLAN.md](./X402SCAN_PLAN.md). Modify `returnPaymentRequired()` in [src/middleware.ts](../src/middleware.ts) to accept a `ProtectedRoute` and emit:

```typescript
{
  x402Version: 2,
  resource: { url: req.originalUrl, description: route.description },
  accepts: [...],
  extensions: {
    bazaar: {
      info: {
        name: route.summary,
        description: route.description,
        inputSchema: route.inputSchema,
        outputSchema: route.outputSchema,
        category: "infrastructure",        // new — maps to Agentic.Market taxonomy
      },
    },
  },
}
```

Route plumbing: [middleware.ts](../src/middleware.ts) has no per-route context today — add a factory `createX402Middleware(deps, route)` and bind per route in [server.ts](../src/server.ts), or attach the route on `res.locals` at mount time.

**Open:** confirm the exact `info` shape with `@x402/extensions/bazaar` (Q4). If the SDK ships a builder, use it.

**Tests:** extend [src/middleware.test.ts](../src/middleware.test.ts) — the envelope's `extensions.bazaar.info` matches the route entry; absent when the route has no schemas; category stable.

**Effort:** ~45 min.

### Phase 2 — Category tagging in the registry

Add an optional `category` field to `ProtectedRoute` in [src/protected-routes.ts](../src/protected-routes.ts) mapping to Agentic.Market's taxonomy (`inference` | `data` | `media` | `search` | `social` | `infrastructure` | `trading`). Use `infrastructure` for the demo route — the gateway *itself* is an infrastructure service.

Emit in the Bazaar envelope (Phase 1), in the `/openapi.json` `x-payment-info` block ([openapi.ts](../src/openapi.ts)), and in the `/.well-known/x402` document ([discovery.ts](../src/discovery.ts)) for consistency.

**Tests:** [src/protected-routes.test.ts](../src/protected-routes.test.ts) — category value in allowed enum; [src/openapi.test.ts](../src/openapi.test.ts) + [src/discovery.test.ts](../src/discovery.test.ts) — category propagates.

**Effort:** ~30 min.

### Phase 3 — Supported-networks metadata

Agentic.Market shows per-service "supported networks." Emit it from the existing `cfg.originNetwork` (CAIP-2, e.g. `eip155:8453`). Already in `accepts[0].network`; also surface in `extensions.bazaar.info.supportedNetworks` for explicit metadata.

**Effort:** ~15 min.

### Phase 4 — Operator guide (`docs/AGENTIC_MARKET.md`)

Mirror [docs/X402SCAN.md](./X402SCAN.md):
- What Agentic.Market is and how it shows services
- Tier 1 (auto-index) prerequisites + verification
- Tier 2 (curation) outreach template
- Troubleshooting table — why a listing might not appear, how to diagnose
- Links to agentic.market, BazaarMCP, Coinbase announcement

**Effort:** ~1 hr.

### Phase 5 — Draft the Tier 2 curation outreach email

Not a code artifact — a prepared pitch template covering:
- Who the gateway is (cross-chain x402 bridge via NEAR Intents 1Click Swap)
- Why it's interesting for Agentic.Market's Infrastructure category
- Current production metrics (once we have them)
- Ask: curation slot + whether chain-activity attribution works without CDP Facilitator (Q7)

Store alongside the plan doc. Send after we have verified production traffic.

**Effort:** ~30 min drafting + open-ended on response.

### Phase 6 — CDP Facilitator probe (conditional — gate to Paths B/C)

One-off script `scripts/probe-cdp-facilitator.ts`:
1. Takes a real x402 payment signature our gateway already verified
2. Calls CDP `/verify` with it
3. Reports whether the payload is accepted, whether CDP catalogs it, and whether a subsequent `settle` is required

Resolves Q1, Q2, Q3 empirically. Run **after** Phases 1-4 so we have real Bazaar-extended envelopes to test with.

**Effort:** ~1 hr.

### Total

~3 hr for Paths A + E (Phases 1-5), plus ~1 hr optional probe (Phase 6).

---

## Recommended Execution Order

1. Resolve **Q4** (SDK compatibility) — 10 min of `npm view` and doc reading.
2. Raise **Q5** with NEAR Intents team — email, async.
3. Implement Phases 1 → 2 → 3 (Bazaar metadata + category + networks).
4. Implement Phase 4 (operator guide).
5. Draft Phase 5 (curation outreach template).
6. Once gateway is in production with real traffic: send the curation email + submit URL.
7. Optionally run Phase 6 probe to evaluate Paths B/C.

---

## Verification Checklist (post-implementation)

```bash
# 1. 402 envelope carries Bazaar metadata.
curl -si http://localhost:3402/api/premium \
  | grep -i '^payment-required:' | awk '{print $2}' | tr -d '\r\n' \
  | base64 -d | jq '.extensions.bazaar.info'
# Expect: { name, description, inputSchema, outputSchema, category, supportedNetworks }

# 2. Category + network propagates to OpenAPI and well-known.
curl -s http://localhost:3402/openapi.json | jq '.paths."/api/premium".get."x-payment-info"'
curl -s http://localhost:3402/.well-known/x402 | jq '.resources'

# 3. After listing (if Tier 1 path attempted):
#    - Agentic.Market web UI shows the gateway in Infrastructure category
#    - Service profile lists correct URL + method + networks + pricing
#    - BazaarMCP returns the service in semantic search results

# 4. For Tier 2: manual verification on agentic.market post-curation.
```

---

## Deferred / Non-Goals

- **Full CDP Facilitator delegation** (Path C) — defer unless Paths A + E both fail and 1CS roadmap (Q5) is blocked.
- **Agent-side client support** — this plan is seller-listing only. If the gateway's client library ([src/client/](../src/client/)) should later *consume* Agentic.Market / BazaarMCP (for agents paying other services), that's a separate plan.
- **Trust-signal engineering** — Agentic.Market derives metrics from chain activity. No gaming, no bootstrapping. Organic traffic is the only mechanism.
- **Agentic Wallet integration** — Coinbase also launched an Agentic Wallet skill for buyers (`npx skills add coinbase/agentic-wallet-skills`). Out of scope — this gateway is a service provider, not a buyer-side wallet.
- **BazaarMCP operator tooling** — BazaarMCP is a Coinbase-hosted consumption surface; we don't operate it, we appear in it.

---

## References

- **[Introducing Agentic.Market (Coinbase launch post)](https://www.coinbase.com/developer-platform/discover/launches/agentic-market)** — primary source for this plan
- [agentic.market](https://agentic.market/) — the live marketplace UI
- [x402 Bazaar (CDP docs)](https://docs.cdp.coinbase.com/x402/bazaar) — backend index spec
- [x402 Bazaar spec (gitbook)](https://x402.gitbook.io/x402/core-concepts/bazaar-discovery-layer) — protocol-level spec
- [Agentic Wallet docs](https://docs.cdp.coinbase.com/agentic-wallet/welcome) — buyer-side counterpart product
- [CDP Facilitator](https://docs.cdp.coinbase.com/x402/core-concepts/facilitator) — facilitator we'd integrate with in Paths B/C
- [X402SCAN_PLAN.md](./X402SCAN_PLAN.md) — complementary crawler-based discovery (Phase 5 is shared work)
- [X402SCAN.md](./X402SCAN.md) — operator guide Phase 4 will mirror
- [src/middleware.ts](../src/middleware.ts) — Phase 1 target
- [src/protected-routes.ts](../src/protected-routes.ts) — data source for Bazaar metadata
- [src/settler.ts](../src/settler.ts) — why we can't trivially swap in CDP Facilitator
