# POSTSALE-021 Storefront/Admin UX Audit

Scope: storefront `order-success`, payment-recovery helpers, same-origin API proxies, receipt cookie/header behavior, admin recovery link generation/copy, and guest hosted-payment recovery from a new browser.

## Current Flow Map

- Checkout creates a durable order through same-origin storefront proxies. COD in `apps/storefront/src/pages/cart.astro` and online checkout in `apps/storefront/src/pages/api/checkout/create-order.ts` set a host-only `HttpOnly; Secure; SameSite=Lax` receipt cookie named from `orderId`, then send buyers to `/order-success?orderId=...`.
- `apps/storefront/src/pages/order-success.astro` strips legacy `token`, `receipt_token`, and `receiptToken` query params, reads the per-order receipt cookie, and calls `getOrderReceipt(orderId, receiptToken)`. The API receipt read uses `X-Receipt-Token`, not URL proof.
- If the receipt cookie is missing, `/order-success` fails closed with `400`, renders no receipt PII, and tells the buyer to reopen the same browser or sign in. There is no guest new-browser verification path.
- Hosted SSLCommerz/Polar failures after order creation build clean recovery URLs like `/order-success?orderId=...&payment=sslcommerz&result=failed&paymentType=...`. The checkout script stores that URL in `sessionStorage` as `scalius_hosted_payment_recovery` for 30 minutes so an empty same-browser cart can show `View payment status`.
- `/order-success` retry buttons post only `orderId`, `paymentType`, `depositAmount`, and `currency` to same-origin storefront payment proxies. The proxies origin-guard cookie writes, read the receipt cookie server-side, strip browser-submitted proof keys, and forward `receiptToken` only in server-to-server API request bodies.
- API payment session routes for Stripe/SSLCommerz/Polar validate receipt proof from `X-Receipt-Token` or body before provider work, and callback URLs return to receipt/account pages without raw receipt proof.
- Admin `POST /api/v1/admin/orders/{id}/payment-recovery-link` validates SSLCommerz/Polar incomplete unpaid/failed evidence, no active payment/session/shipment lock, no paid amount, and no unsafe payment rows. It records a hash-backed `order_receipts` token, but returns only a clean `/order-success?...` URL with `accessMode: "existing_browser_receipt"` and no raw token.
- Admin `PaymentCard` shows `Hosted payment recovery` and a `Copy recovery link` button. Success copy says the URL opens only in the buyer browser that already has the private receipt cookie, but the button label still sounds merchant-sendable. The freshly minted admin receipt token is not installed in any buyer browser, so current copied URL usefulness depends on an existing buyer cookie, not the newly minted token.
- Authenticated customer account recovery is separate: `/account/orders/{id}` calls `/customer-auth/orders/{id}/payment-session`, never uses receipt tokens, and should remain separate from guest recovery.

## Concrete UX/Route Recommendation

- Add a dedicated guest route: `/payment-recovery?orderId=<id>` for fresh-browser hosted-payment recovery. It should render no PII and ask the buyer to verify the order contact by phone/SMS, WhatsApp, or email. Use POST-only actions and avoid sensitive input `name=` values that can serialize into URLs.
- Change missing-cookie `/order-success?orderId=...&payment=sslcommerz|polar` copy to offer `Verify to recover payment`, linking to `/payment-recovery?orderId=...&payment=...&result=failed...`. Keep the existing same-browser receipt path unchanged.
- Add same-origin storefront proxies such as:
  - `POST /api/payment-recovery/send-code`
  - `POST /api/payment-recovery/verify`
  These should call API recovery endpoints server-side, require same-origin cookie-write guards, return `Cache-Control: no-store`, and never return raw receipt proof to the browser.
- Add an order-owned recovery challenge service/table instead of reusing customer login OTP state. Suggested shape: `order_payment_recovery_challenges` with opaque `id`, `orderId`, `channel`, hashed contact, masked contact, HMAC code hash, status, attempt counters, expiry, consumed timestamp, and request metadata that is redacted by design.
- The public API send-code endpoint should verify the order is eligible for buyer hosted-payment recovery, match the submitted contact exactly to the order's phone/email, rate-limit by IP/order/contact hash, send OTP via existing email/SMS/WhatsApp transport machinery, and respond generically to avoid order/contact enumeration.
- The verify endpoint should atomically consume the challenge, re-check order/payment/session eligibility, mint a new `order_receipts` row with `source = "guest_payment_recovery"`, and hand the raw token only to the trusted storefront proxy. The proxy sets the same per-order `HttpOnly` receipt cookie with `createOrderReceiptCookieHeader()` and responds with a clean redirect back to `/order-success?orderId=...&payment=...&result=failed...`.
- Keep leaked URLs insufficient: `/payment-recovery?orderId=...` or any admin-copied URL must not open receipt PII, create a payment session, or set a receipt cookie until contact OTP proof succeeds.
- In admin, split the UX into clear modes:
  - Rename the current action to `Copy same-browser status link` or keep it behind explanatory copy if retained.
  - Add a separate `Send buyer recovery` / `Copy verification link` action for `/payment-recovery?orderId=...`, explicitly saying the buyer must verify phone/email/WhatsApp in the new browser.
  - Avoid showing an expiry for the existing same-browser copied URL unless it reflects the actual buyer cookie/handoff, not an unused freshly minted receipt token.
- Do not attach guest orders to customer accounts through this flow. Successful verification grants one-order receipt access only.

## Affected Files

- Storefront receipt and retry UX: `apps/storefront/src/pages/order-success.astro`, `apps/storefront/src/components/OrderSuccessButtons.tsx`, `apps/storefront/src/lib/order-receipt-cookie.ts`, `apps/storefront/src/lib/api/orders.ts`.
- Storefront hosted-payment helpers: `apps/storefront/src/lib/checkout/payment-recovery.ts`, `apps/storefront/src/lib/checkout/session-state.ts`, `apps/storefront/src/lib/checkout/handlers/sslcommerz.ts`, `apps/storefront/src/lib/checkout/handlers/polar.ts`, `apps/storefront/src/lib/cart/empty-state.ts`.
- Storefront proxies: existing `apps/storefront/src/pages/api/checkout/*` for parity; new `apps/storefront/src/pages/payment-recovery.astro` and `apps/storefront/src/pages/api/payment-recovery/*`.
- API public receipt/payment routes: `apps/api/src/routes/orders.ts`, `apps/api/src/routes/payment/{sslcommerz-routes,polar-routes,stripe-routes}.ts`, `apps/api/src/utils/order-receipt-token.ts`.
- API/admin recovery routes: `apps/api/src/routes/admin/orders.ts`, `apps/api/src/routes/admin/orders-payment-recovery-link.test.ts`, OpenAPI/SDK generated client after contract changes.
- Core order services: `packages/core/src/modules/orders/orders.admin.ts`, `packages/core/src/modules/orders/order-receipts.ts`, new order-payment-recovery challenge service/tests.
- OTP delivery reuse points: `packages/core/src/modules/customers/otp-transport.ts`, delivery receipt helpers, and API customer-auth patterns for rate limiting/transport readiness. Reuse transport patterns, not customer login challenge/session state.
- Database: `packages/database/src/schema/orders.ts` plus a migration for the recovery challenge table.
- Admin UI: `apps/admin-v2/src/components/admin/orderview/PaymentCard.tsx`, `apps/admin-v2/src/lib/api-functions/orders.ts`, `apps/admin-v2/src/lib/api-mutations/orders.ts`, and order detail permission/source tests.

## Tests/Smokes To Add

- Core challenge tests: eligible SSLCommerz/Polar incomplete unpaid/failed orders can issue challenges; Stripe/COD/paid/deleted/active session/unsafe payment rows fail closed; wrong contact/code cannot mint receipt; consume is one-time; only hashes/masks persist.
- API tests: send-code responses are generic; verify sets up a receipt handoff only after OTP proof; leaked `/payment-recovery` or `/order-success` URLs alone cannot read receipt PII; direct receipt query `token` remains rejected; raw receipt proof is absent from JSON, OpenAPI public schemas, logs, KV keys, and clipboard URLs.
- Storefront route tests: no sensitive native GET forms; missing-cookie `/order-success` shows the recovery CTA for hosted payment context; same-origin verify proxy sets the receipt cookie and returns only a clean redirect; payment-session proxies still require the cookie and preserve `202 processing`.
- Admin tests: old same-browser copy label/copy is not presented as merchant-sendable; new buyer recovery action returns/copies only a verification URL; no success toast includes private URLs; RBAC remains `orders.edit` for issuance and `orders.view` for queue/export.
- Browser smoke: in a fresh private browser, open the merchant link, confirm no receipt PII renders, submit wrong contact/code and stay generic, submit valid OTP, verify the `HttpOnly` receipt cookie is set, redirect to `/order-success`, render minimal receipt, and retry SSLCommerz/Polar without exposing proof in URL/history.
- Live read-only smoke after deploy: public receipt by `orderId` alone and with `?token=` still fails; API health/readyz pass; admin recovery/export still readable through direct and dashboard proxy routes.

## Risks

- Returning raw receipt proof from a public API JSON response would recreate the PRIV-003 class. Keep raw proof confined to server memory/Set-Cookie handoff inside the same-origin storefront proxy.
- Contact matching can become risky if order phone/email is edited after checkout. Prefer immutable order contact at challenge creation, store only hashes/masks, and invalidate pending challenges after contact/payment-state changes.
- OTP reuse must not create customer sessions, account ownership, or guest-to-account claims. This flow grants only receipt access for one order.
- Eligibility can race with payment webhooks or admin actions. Re-check order/payment/session/shipment state during verification immediately before minting the receipt cookie.
- Provider/channel readiness must fail closed with clear buyer copy and no fallback to a different unverified channel.
- The current admin copied URL expiry is misleading because the newly minted receipt token is not installed in the buyer browser. Fix copy/API semantics before merchants rely on it for cross-browser recovery.
