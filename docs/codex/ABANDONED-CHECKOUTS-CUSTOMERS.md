# Abandoned Checkouts and Customer Recovery

Last reviewed: 2026-07-19

## Authority

- `abandoned_checkouts` is short-lived recovery context, not cart, price, stock,
  discount, customer-identity, or payment authority. Any future resume/recovery
  action must rebuild the cart and run the normal storefront cart and checkout
  validation before presenting a payable total.
- The public save route accepts only an unguessable `chk_session_*` browser
  session identifier. It persists an allowlisted, bounded snapshot: customer
  contact/delivery context, at most 100 well-formed cart lines, compact option
  labels, discount summary, and shipping summary. Arbitrary form fields, image
  URLs, gateway payloads, and unknown nested data are discarded.
- The admin list is protected by `orders.view`; destructive cleanup requires
  `orders.delete`. Snapshot totals are explicitly labelled as estimates.
- Customer records and sessions remain D1 authority. An abandoned snapshot must
  never merge customers, prove account ownership, or mark a phone/email verified.

## Unified buyer profiles and account ownership

- The Customers workspace is the merchant's buyer directory, not an accounts-only
  list. Storefront guest and authenticated orders both link `orders.customer_id`
  to a CRM profile so order history and legitimate contact context are visible in
  one place. `customers.account_claimed_at` distinguishes an account profile from
  an unclaimed guest profile.
- Private account ownership is separate: only an authoritative authenticated
  customer session may populate `orders.account_owner_customer_id`. Customer
  order reads, account support requests, and other account-private actions must
  authorize through that field. A guest-supplied phone or email match is never
  proof of account ownership.
- Guest checkout reuses an unclaimed profile by canonical phone and may update
  its contact/delivery context. It must not overwrite a claimed account profile.
  Verified sign-up can claim an existing unclaimed profile after proving its
  contact channel; sign-in must not treat an unclaimed CRM row as an account.
- Customer metrics use the CRM link. Order count includes linked orders; paid
  spend is the sum of each order's current non-negative `paid_amount`. Refund
  processing reduces that net value instead of discarding a partially refunded
  order's remaining paid amount. A pending COD order therefore increases order
  count but not paid spend.
- Permanent customer deletion is blocked while either CRM-linked or
  account-owned orders exist. Soft deletion remains available and revokes active
  sessions without erasing order or customer-history evidence.

## Lifecycle

- Successful checkout removes its matching abandoned session asynchronously;
  scheduled cleanup is the fallback.
- Empty, unidentified sessions may be removed after one hour. Both the current
  `{ cart: { items }, customerName, ... }` shape and the historical
  `{ items, customerInfo }` shape must be recognized while old rows age out.
- Hosted-payment recovery archives are not empty carts and must survive the
  short empty-session cleanup. Their order remains the durable payment/order
  record and the admin UI links to it directly.
- All abandoned context expires after the bounded retention window. The list
  read stays side-effect free; cleanup belongs to scheduled/admin write paths.

## Merchant interface

- Long `chk_session_*` values render as a suffix-preserving compact identifier,
  such as `S5I82lT…IUpbW`, while the exact identifier remains in the title and
  accessible action name. Never show only the common prefix; rows must be
  distinguishable without exposing a new recovery credential.
- Desktop uses the sortable recovery table. Below the medium breakpoint the
  same data becomes operational cards with selection, stage, customer, saved
  cart estimate, age, View, optional hosted-order link, and Delete visible
  without horizontal scrolling. Mobile keeps page selection and an explicit
  newest/oldest sort instead of hiding bulk and ordering controls.
- Admin version `d2c742b1-0bd7-4415-ab2b-10808c8eb350` was authenticated and
  production-checked against 21 live recovery records on 2026-07-19. Desktop
  showed distinct compact IDs. A real 390 × 844 viewport rendered 20 cards on
  page one at a 390 px document width, opened a two-line saved-cart detail,
  toggled oldest/newest order, and retained a 390 px width with no lateral
  overflow.

## Deferred release work

- Recovery messaging needs an explicit consent/template/dedupe/audit model and
  must use the notification outbox; this slice does not invent direct email,
  SMS, or WhatsApp sends.
- Buyer resume links need expiring non-bearer lookup plus server-side cart
  reconstruction and SKU repair. Never place raw PII, checkout snapshots,
  receipt proof, or payment recovery proof in the URL.
- Customer merge remains deliberately absent until order ownership, verified
  contacts, sessions, history, deletion, and conflict semantics are defined as
  one transactional operation.
