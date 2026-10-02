# Customer marketing

Marketing consent per customer and channel (`email`, `sms`, `whatsapp`), the
surfaces that change it, the e-mail double opt-in and the links in marketing
messages. Tags and segments live in the customers module
(`customer-tags.ts`, `customer-segments.ts`, `customer-export.ts`).

## Model (migration 0108)

- `customer_marketing_consents`: one row per (customer, channel): `state`
  (`subscribed`, `unsubscribed`, `pending` — e-mail double opt-in only),
  `contact` (the normalised address the consent covers: lower-case e-mail or
  E.164 phone), `source` (`checkout`, `account`, `newsletter`, `admin`,
  `import`, `plugin`, `link`), the author (`actor`, `actor_id`, `note`), the
  consent text and its version (`<surface>:<12 hex of SHA-256>`), timestamps,
  and for pending rows the SHA-256 of the confirmation token.
- Triggers copy every state or address change into
  `customer_marketing_consent_events` (the audit log) and emit
  `customer.consent_changed` (event catalog, webhooks, plugins) in the same
  transaction. No write path can skip them.
- A consent covers one address. Readers show `not_subscribed` when the
  customer's current e-mail/phone is not the one the row covers
  (`marketingConsentStatus`), so changing an address never carries consent
  to it. WhatsApp uses the customer's phone.

## State machine (`consent.ts`)

Every write is one `INSERT … SELECT … ON CONFLICT DO UPDATE … WHERE`
(race-free; a no-op when nothing changes):

- subscribe: → `subscribed` unless already subscribed for that address.
- request (e-mail, double opt-in): → `pending` with a new token hash and an
  outbox row, unless subscribed for that address or a request for it is less
  than 10 minutes old (no mail flood). A newer request voids older links.
- confirm (link, 7 days, single use): `pending` → `subscribed`.
- unsubscribe: → `unsubscribed`.

A buyer may subscribe a channel only for the address the customer record
already has; a guest record without e-mail takes the e-mail given (at once,
or when it is confirmed). Buyer surfaces only subscribe; unsubscribing needs a
signed link, the account or staff.

## Surfaces (`flows.ts`)

- Newsletter (`subscribeToNewsletter`): phone is mandatory (customer
  identity); the contact resolves by the identity rules
  (`customers/customer-identity.ts`: verified phone owner, verified e-mail
  owner, the phone's guest record, else a new guest record). SMS always,
  WhatsApp when asked, e-mail pending when double opt-in is on. The answer
  depends only on the input and the settings, never on whether the contact
  was known. Rate limited per address and per contact
  (`enforceNewsletterSignupRateLimits`, hashed D1 buckets) and natively at
  the API route.
- Account (`updateAccountMarketingPreferences`): a verified e-mail subscribes
  at once; an unverified one waits for its link.
- Staff and plugins (`setCustomerMarketingConsent`): a staff subscribe needs a
  note saying how the customer agreed.
- Checkout (`recordCheckoutMarketingConsent`): after the order commits, never
  inside it (consent must not fail an order); idempotent, best effort.
  Settings document `marketing_consent` (label per language, channels,
  double opt-in), exposed to the storefront through `GET /checkout/config`.

## Messages (`messages.ts`, `links.ts`)

- Double opt-in: the outbox row (subject `customer`, type `marketing_opt_in`)
  carries a random nonce only. The API queue consumer derives the token
  (HMAC, key from `SCALIUS_SECRET` purpose `marketing-opt-in-link`), checks
  its hash is still the pending one, and sends the confirmation to
  `<store>/newsletter/confirm?token=…`; the token is scrubbed from receipts.
- Unsubscribe links: `u1.<customer id>.<channel>.<HMAC>` (purpose
  `marketing-unsubscribe-link`), stateless and long-lived; they can only
  unsubscribe. Rotating `SCALIUS_SECRET` voids them.
- `marketingSendPermission`: what a marketing sender (plugins today) must
  check: consent for the current address, plus the unsubscribe URL,
  `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
  headers and the footer copy. Without a store URL nothing may be sent.
