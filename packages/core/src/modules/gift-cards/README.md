# Gift cards

Gift cards as a product, a staff-issued credit, store credit from a refund, and a checkout tender. Every balance change is a row in an append-only ledger. Audience: contributors and coding agents.

## Entries

- `index.ts` is the server entry.
- `browser.ts` is the closed entry: `GIFT_CARD_STATUSES`, `GIFT_CARD_SOURCES`, `GIFT_CARD_TRANSACTION_KINDS`, `GIFT_CARD_LIMITS` and `LineGiftCardExtra`.

| File | Owns |
|------|------|
| `crypto.ts` | 80-bit codes. `code_hash` (HMAC-SHA256) finds a card. `code_ciphertext` (AES-GCM, format `gc1:`) shows the code again. |
| `ledger.ts` | Batch-statement builders: `redeem` plus the `gift_card` tender row, `release`, `refund`, `adjust`. |
| `issue.ts` | Card and `issue` transaction statements. Manual issue and store credit. |
| `tender.ts` | Apply a code, balance check, apply handles to cards, `quoteGiftCardTender` over the pure split in `@scalius/shared/gift-card-tender`. |
| `apply-handle.ts` | The checkout apply handle: AES-GCM sealed `{giftCardId, expiry}`, valid 2 hours. The storefront carries handles, never codes. |
| `admin.ts`, `buyer.ts` | Staff list, detail, liability summary, adjust and versioned edits. The buyer's list, "Save a card" and "Show code". |
| `extras.ts`, `notification.ts`, `mask.ts`, `line-recipient.ts` | Per-line issued cards (last 4, masked recipient), send-time message facts, masking, and the reserved `_gc_` recipient line properties. |

## Layer and imports

- Layer L0. It imports no domain. It uses `@scalius/database`, `@scalius/shared`, core `errors` and `utils`.
- Imported by `checkout` (tender at commit), `payments` (refund to card, store credit), `orders` (release on abandon and cancel) and `fulfilment` (issue).
- The purchase fulfiller is `fulfilment/auto/gift-card.ts`: one card, one `issue` transaction and one id-only outbox row per unit. Send-time content is `apps/api/src/notification-content/gift-card.ts`.
- Callers build outbox rows. Settings arrive as input.

## Tables

| Table | Role and constraints |
|-------|----------------------|
| `gift_cards` | One card. Unique `code_hash`. `initial_amount_minor` is above 0. `balance_minor` starts at 0 and is a trigger projection of the ledger. `status` is `active` or `disabled`. `expires_at` NULL means never. `source` is `purchase`, `manual` or `refund`. Unique `(source_order_item_id, source_unit_index)` for purchases and unique `source_refund_attempt_id` for refunds. A recipient has one contact (email or phone). Cards cannot be deleted. |
| `gift_card_transactions` | One ledger row. `kind` is `issue`, `redeem`, `release`, `refund` or `adjust`. `amount_minor` is signed and non-zero (redeem below 0, issue, release and refund above 0). Unique `idempotency_key`. `adjust` needs a `reason`. Rows cannot be updated or deleted. |

Triggers (migration 0097) refuse an overdraft, a redemption of a disabled or expired card, a wrong running balance, changes to card identity, and a direct `balance_minor` write. A source policy in `scripts/check-source-policies.mjs` also rejects code that sets `balance_minor`.

## Rules

- Balance is the sum of transactions and never negative. Concurrent redemptions cannot overspend.
- Each statement computes the running balance from the committed card row, so a batch built before a concurrent write stays correct.
- Redemption runs in the checkout commit batch. A card spent, disabled or expired since the quote fails the batch (`isGiftCardLedgerError`) and becomes `GIFT_CARD_CHANGED`.
- Tender pays at most the eligible total. A gift card never pays for a gift-card line. At most 5 cards per order. A deposit plan cannot combine with gift cards.
- Release happens once per order and card (key `release:<orderId>:<giftCardId>`). It moves the tender row from `succeeded` to `refunded`.
- Refund to a card and store credit are idempotent per refund attempt. A purchase issue is idempotent per order line and unit.
- Limits: 20 units per line, 50 units per order, message 200 characters, note 500 characters. The largest card is 10,000,000,000 minor units.
- `apply` answers every failure with one message, "This gift card can't be used." (unknown, disabled, expired, empty, wrong currency). The balance check reports an unknown code as `GIFT_CARD_NOT_FOUND`. Both are rate limited by IP.
- Code material derives from `CREDENTIAL_ENCRYPTION_KEY`, never `SCALIUS_SECRET`, so a secret rotation cannot orphan a live card. A missing key raises `GiftCardsUnavailableError` (503) with no fallback. The apply handle uses a key derived from `SCALIUS_SECRET`.
- Codes never appear in URLs, logs, analytics, queue or outbox payloads, or receipts. Staff see `last4`. The code is shown once at manual issue.

## Settings

- The `gift_cards` document (`defaultExpiryMonths`, 1 to 120 or null) is declared in `settings`. This domain receives the expiry as input (`giftCardExpiryFromMonths`).

## Routes

Admin permissions are in `packages/core/src/auth/rbac/route-permissions/gift-cards.ts`.

| Method and path | Permission |
|-----------------|------------|
| `GET /api/v1/admin/gift-cards`, `GET /summary`, `GET /{giftCardId}` | `gift_cards.view` |
| `POST /api/v1/admin/gift-cards` (manual issue) | `gift_cards.manage` |
| `PATCH /api/v1/admin/gift-cards/{giftCardId}` | `gift_cards.manage` |
| `POST /api/v1/admin/gift-cards/{giftCardId}/adjust`, `/resend` | `gift_cards.manage` |
| `POST /api/v1/checkout/gift-cards/apply`, `/balance` | none (public, rate limited) |
| `GET /api/v1/customer-auth/gift-cards`, `POST /gift-cards/save`, `POST /gift-cards/{giftCardId}/reveal` | customer session |

## Where to look

- Tests: `ledger.d1.test.ts` (including a property run), `issue.d1.test.ts`, `redeem-race.d1.test.ts`, `release.d1.test.ts`, `recipient.test.ts`, `apps/api/src/routes/checkout-gift-cards.test.ts`.
