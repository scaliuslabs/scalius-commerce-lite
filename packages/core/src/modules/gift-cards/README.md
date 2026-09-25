# Gift Cards Module

Gift cards as a product, a staff-issued credit, store credit and a checkout tender (design: `audit/rewrite-2026-09-23/WAVE-B-DESIGN.md` §4). Owner slice: **B4**.

Public entries: `index.ts` (server) and `browser.ts` (statuses, sources, transaction kinds, limits, `LineGiftCardExtra`).

## Files

- `crypto.ts`: 80-bit codes; `code_hash` (HMAC-SHA256) for lookup and `code_ciphertext` (AES-GCM, `gc1:` format) to show a code again. Both keys are HKDF-derived from `CREDENTIAL_ENCRYPTION_KEY` (never `SCALIUS_SECRET`), read strictly: no key means `GiftCardsUnavailableError` (503), never a fallback.
- `apply-handle.ts`: the checkout apply handle, AES-GCM sealed `{giftCardId, exp +2 h}` under a `SCALIUS_SECRET`-derived key. The storefront carries handles, never codes.
- `ledger.ts`: batch-statement builders for the append-only ledger: `redeem` + the `gift_card` `order_payments` tender row (the hold, in the checkout commit batch), `release` (once per order and card, `ON CONFLICT DO NOTHING`), `refund` (keyed by the refund attempt), `adjust`. The running balance is computed inside each statement; the triggers refuse an overdraft or a disabled/expired redemption.
- `issue.ts`: card + `issue` transaction statements; manual issue (idempotent by request key, the code returned once); store credit (one card per refund attempt).
- `tender.ts`: apply (uniform "This gift card can't be used."), balance check, handles → cards, and `quoteGiftCardTender` over the shared pure split (`@scalius/shared/gift-card-tender`).
- `admin.ts`, `buyer.ts`: staff list/detail/liability/adjust/versioned edits; the buyer's list, "Save a card" and "Show code".
- `extras.ts`, `notification.ts`: per-line issued cards (last 4, masked recipient) and the send-time `gift_card_issued` facts (the code is decrypted only for the renderer).

The purchase fulfiller lives in `fulfilment/auto/gift-card.ts` (one card, one `issue` transaction and one id-only outbox row per unit, in the auto-fulfil batch). Send-time content is `apps/api/src/notification-content/gift-card.ts`.

## Edges: none (leaf domain)

`gift-cards` imports only `@scalius/database`, `@scalius/shared` and core `utils`/`errors`. `checkout` (tender at commit), `payments` (refund to card, store credit), `orders` (release on abandon and cancel) and `fulfilment` (issue) import it; any edge back would grow the existing cycle group. Outbox rows are built by callers and settings are passed in.

## Invariants (design §4.6)

- Balance = Σ transactions ≥ 0; only transactions move it (triggers; a source policy forbids writing `balance_minor`). Concurrent redemptions never overspend.
- Tender ≤ eligible total (a gift card never pays for gift-card lines), ≤ 5 cards, no deposit plan.
- Release exactly once on abandon or cancel; refund-to-card and store credit idempotent per attempt key; purchase issue idempotent per (line, unit).
- Codes never in URLs, logs, analytics, outbox payloads or delivery receipts. Failure copy is uniform; limiters fail closed.

Tests: `ledger.d1.test.ts` (G1, property run), `issue.d1.test.ts` (G6, G7, buyer and staff surfaces), `apps/api/src/routes/checkout-gift-cards.test.ts` (G8).
