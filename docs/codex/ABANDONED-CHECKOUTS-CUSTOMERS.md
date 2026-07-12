# Abandoned Checkouts and Customer Recovery

Last reviewed: 2026-07-13

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
