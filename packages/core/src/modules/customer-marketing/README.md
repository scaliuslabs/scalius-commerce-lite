# Customer marketing

Marketing consent per customer and channel (`email`, `sms`, `whatsapp`, `push`), the surfaces that change it, the e-mail double opt-in and the signed links in marketing messages. For contributors and plugin authors.

- Layer L7. The domain imports `customers`, `notifications` and `settings` (`scripts/core-domain-graph.allow.json`). `store-transfer` imports it for the customer import.
- One entry, `index.ts`. Shared vocabulary (channels, states, sources, settings schema, text versions) is in `packages/shared/src/customer-marketing.ts`.
- Tags, segments and the CSV export belong to [`customers`](../customers/README.md).

## Model

`customer_marketing_consents` holds one row per (`customer_id`, `channel`). `customer_marketing_consent_events` is the audit log.

- `state` is `subscribed`, `unsubscribed` or `pending` (`pending` is e-mail double opt-in only).
- `contact` is the normalised address the consent covers: lower-case e-mail, the stored phone, or the claimed account id for push. Push consent never changes the browser permission or order-update subscriptions.
- `source` is `checkout`, `account`, `newsletter`, `admin`, `import`, `plugin` or `link`. `actor` is `buyer`, `staff`, `plugin` or `system`.
- `consent_text` is the wording shown, at most 500 characters (`consent_text_version`: `<surface>:<first 12 hex of SHA-256>`). `note` holds at most 500 characters. `confirmation_hash` is the unique SHA-256 of the pending confirmation token.
- Triggers `customer_marketing_consents_audit_ins` and `_audit_upd` copy every state or address change into the audit log. Triggers `evt_customer_marketing_consents_created` and `_changed` emit `customer.consent_changed` (`event_outbox`) on a new row or a state change. No write path skips them.
- A signed unsubscribe updates every stored consent row for that channel and normalized contact, including duplicate customer records, with one canonical audit/event per changed row. A later explicit opt-in remains a new consent decision.
- A consent covers one address. `marketingConsentStatus` returns `not_subscribed` when the customer's current e-mail or phone is not the address on the row, so a changed address never inherits consent. WhatsApp uses the customer's phone.

## State machine (`consent.ts`)

Every write is one `INSERT ... SELECT ... ON CONFLICT DO UPDATE ... WHERE`. It is race-free and does nothing when nothing changes.

| Action | Result |
| --- | --- |
| subscribe | `subscribed`, unless already subscribed for that address. |
| request (e-mail, double opt-in) | `pending` with a new token hash and an outbox row. Skipped when already subscribed for that address, or when a request for it is under 10 minutes old. A newer request voids the older link. |
| confirm (link) | `pending` to `subscribed`. The link works 7 days, once. |
| unsubscribe | `unsubscribed`. |

A buyer may subscribe a channel only for the address the customer record already has. A guest record without e-mail takes the e-mail given, at once or when the link is confirmed. Buyer surfaces only subscribe. Unsubscribing needs a signed link, the account or staff.

## Surfaces (`flows.ts`)

| Surface | Function | Behaviour |
| --- | --- | --- |
| Newsletter form | `subscribeToNewsletter` | Phone is mandatory (customer identity). The contact resolves by the identity rules in `customers/customer-identity.ts`. Only separately selected contact channels subscribe; e-mail is `pending` when double opt-in is on. The answer never reveals whether the contact was known. |
| Account | `updateAccountMarketingPreferences` | A verified e-mail subscribes at once. An unverified one waits for its link. |
| Staff and plugins | `setCustomerMarketingConsent` | A staff subscribe needs a note saying how the customer agreed. |
| Checkout | `recordCheckoutMarketingConsent` | Runs after the order commits, never inside it. Idempotent, best effort: an error is logged without contact details and the order stands. |
| Customer import | `store-transfer/customer-import.ts` | Source `import`, actor `staff`. |

- Newsletter limits: `enforceNewsletterSignupRateLimits` (hashed D1 buckets) and the native `RL_STRICT` limiter on the route.
- Settings document `marketing_consent` (`marketingConsentDocument`): checkout choices (`enabled`, `channels`, `label` in `en` and `bn`; unchecked by default, never required) and `emailDoubleOptIn`. The storefront reads it from `GET /api/v1/checkout/config`.

## Messages (`messages.ts`, `links.ts`)

- Double opt-in: the outbox row (subject `customer`, type `marketing_opt_in`) carries a random nonce only. The API queue consumer (`apps/api/src/queue-notifications.ts`) calls `sendMarketingOptInEmail`. It derives the token with HMAC (key from `SCALIUS_SECRET`, purpose `marketing-opt-in-link`), checks the token hash is still the pending one, and sends `<store URL>/newsletter/confirm?token=...`. It redacts the token from receipts. Without a store URL it sends nothing.
- Unsubscribe link: `u1.<customer id>.<channel>.<HMAC>` (purpose `marketing-unsubscribe-link`). Stateless and long-lived. It can only unsubscribe. Rotating `SCALIUS_SECRET` voids every link. Page: `<store URL>/newsletter/unsubscribe`.
- Direct plugin email/SMS marked as marketing requires the sensitive `marketing.send` grant, live consent and the signed opt-out footer. Transactional sends retain their existing behavior.
- `marketingSendPermission`: every marketing sender (plugins) must call it. It allows a send only for a `subscribed` row that covers the current address. It returns the unsubscribe URL, the `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers (e-mail) and the footer copy. Without a store URL nothing may be sent. Transactional messages skip it.

## Routes

| Route | Caller |
| --- | --- |
| `POST /api/v1/marketing/subscribe`, `/confirm`, `/unsubscribe/preview`, `/unsubscribe` | Storefront Worker. Tokens travel in the body. |
| `GET`, `PUT /api/v1/customer-auth/marketing` | Signed-in buyer. |
| `GET`, `PUT /api/v1/admin/customers/{id}/marketing` | Staff and plugins. `customers.view` reads (consent, audit log newest 50, tags), `customers.edit` writes. |
| `GET`, `PUT /api/v1/admin/settings/marketing-consent` | Staff. `settings.general.view` reads, `settings.general.edit` writes. A stale `expectedRevision` returns 409. |

An unknown, used, replaced or expired token always returns `invalid`. No response says whether a contact or customer exists.
