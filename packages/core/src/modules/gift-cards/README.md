# Gift Cards Module

Gift cards as a product, a staff-issued credit and a checkout tender (design: `audit/rewrite-2026-09-23/WAVE-B-DESIGN.md` §4). Owner slice: **B4**. B0 landed the stubs below; they do no I/O and return empty or zero, so nothing is buyer-visible until B4.

Public entries: `index.ts` (server) and `browser.ts` (statuses, sources, transaction kinds, limits, `LineGiftCardExtra`).

## Will own

Code generation and lookup (HMAC `code_hash` + AES-GCM ciphertext, both derived from `CREDENTIAL_ENCRYPTION_KEY`), issue (purchase, manual, refund credit), the gift-card fulfiller, apply handles, redemption/release/refund-credit batch statements, balance adjustments, status and expiry, reveal and save-to-account, the per-line extras reader, buyer lists and the liability summary.

## Seams already mounted (B0)

- Stubs: `listLineIssuedCards`, `countBuyerGiftCards` (`extras.ts`).
- Routers: `apps/api/src/routes/admin/gift-cards.ts`, `routes/customer-auth/gift-cards.ts`, `routes/checkout-gift-cards.ts`.
- Permissions `GIFT_CARDS_VIEW` / `GIFT_CARDS_MANAGE` (sensitive; never folded into orders permissions) in `route-permissions/gift-cards.ts`; operations in `operation-registry/{dashboard,storefront}-gift-cards.ts`.

## Edges: none (leaf domain)

`gift-cards` imports only `@scalius/database`, `@scalius/shared` and `packages/core/src/utils`. `payments`, `orders`, `checkout` and `fulfilment` import it; any edge back would grow the existing cycle group. Outbox rows are built by callers and settings are passed in.

## Invariants (design §4.6)

- Balance = Σ transactions ≥ 0; only transactions move it (triggers). Concurrent redemptions never overspend.
- Tender ≤ eligible total (a gift card never pays for gift cards), ≤ 5 cards, no deposit plan.
- Release exactly once on abandon or cancel; refund-to-card and store credit idempotent per attempt key.
- Codes never in URLs, logs, analytics, outbox payloads or delivery receipts. Failure copy is uniform; limiters fail closed.
