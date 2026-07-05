# POSTSALE-021 Security Threat Model

Scope: merchant-sendable cross-browser recovery for failed/cancelled hosted SSLCommerz/Polar guest orders after receipt proof was removed from URLs. This is a design/report slice only; no production code changes.

## Recommended Shape

Use a clean storefront URL such as `/payment-recovery?orderId=<orderId>`. The URL is only a locator, never proof. The page should show no receipt PII until the buyer proves control of the order contact.

Add an order-owned recovery OTP flow instead of reusing customer login verification state:

- Public/send step: buyer submits `orderId`, method/channel, and the contact they control. The API compares the normalized contact to the order's stored buyer phone/email and responds generically: "If this order is eligible, a code was sent."
- D1 challenge authority: store a dedicated `order_payment_recovery_otp_challenges` row keyed by an opaque challenge id, with `orderId`, normalized contact hash/mask, channel, `deliveryKey`, HMAC code hash, `status`, attempts, resend cooldown, expiry, and consumed timestamp. Do not use `customer_auth_otp_challenges`; account sign-in/sign-up semantics and post-OTP customer creation errors are the wrong boundary.
- Delivery: reuse existing OTP transport, queue, delivery receipt, provider readiness, masking, and no-code-logging patterns. Set queue/delivery `purpose` to `order_payment_recovery`.
- Verify/finalize: browser posts to a same-origin storefront proxy. The proxy generates `createOrderReceiptToken()` server-side, calls an API service-auth endpoint with the OTP proof plus that token, then sets the existing host-only HttpOnly `scalius_receipt_<order>` cookie and returns a clean `/order-success?orderId=...&payment=...&result=failed` URL. The API records only the hash in `order_receipts` and never returns raw receipt proof to public/direct callers.

This reuses `order_receipts`, receipt cookies, payment-session proxies, `validateOrderReceiptProof()`, `createSSLCommerzPaymentSession()` / `createPolarPaymentSession()`, D1 payment-session single-flight, and existing OTP delivery infrastructure without introducing a new Durable Object or a bearer recovery URL.

## Invariants

- Merchant-sendable links contain only non-secret routing data. They must never contain `token`, `receipt_token`, `receiptToken`, OTP code, challenge id, receipt hash, provider session id, or signed bearer handoff proof.
- Receipt proof exists only in transient server memory, the storefront HttpOnly receipt cookie, and the D1 `order_receipts.token_hash`. It must not enter URLs, browser-visible JSON, analytics payloads, logs, clipboard URLs, KV keys, or provider metadata.
- Public send responses are enumeration-safe. Missing order, wrong contact, ineligible state, unsupported channel, expired recovery window, and success use the same public response shape and no-store headers.
- The OTP challenge is bound to `orderId`, channel, normalized buyer contact hash, and code hash. The verify step must not reinterpret the contact or channel from a different request.
- OTP send and verify use D1 guarded writes, not KV read-modify-write. Concurrent wrong codes must increment attempts atomically; concurrent correct-code verifies must consume at most one challenge.
- Rate limits are D1-backed and scoped at minimum by trusted IP bucket, order id hash, and contact hash. Prefer `CF-Connecting-IP`; use `X-Forwarded-For` only under the existing loopback/local rule. Unknown IPs share a fail-closed bucket.
- Eligibility reuses existing payment gates: only incomplete SSLCommerz/Polar orders with `paymentStatus` `unpaid` or `failed`, `paidAmount <= 0`, no deleted row, no cancelled/returned/refunded/partially-refunded status, no paid/refunded payment status, no active shipment claim, no active payment-session attempt, and no pending/confirmed/succeeded `order_payments`.
- Gateway readiness and payment amount policy remain in the existing payment-session path. OTP send/verify must not call providers, create payment sessions, create payment plans, or rotate gateways.
- The final OTP verification plus `order_receipts` insert/update must be one D1 transaction or equivalent all-or-nothing guarded sequence. If the receipt hash cannot be recorded, the challenge must not be consumed.
- Replay is one-time. Reusing the same code, challenge id, or merchant URL after successful finalize cannot mint another receipt cookie. The buyer can request a fresh OTP if the browser loses the final response.
- Deleted/cancelled/paid/reconciled orders fail closed even if an old challenge, merchant URL, hosted callback, or receipt cookie exists.
- Logs store only masked contact, order id, request id, route, status, and reason codes. Never log OTP codes, raw receipt tokens, provider payloads, credentials, full contacts, or raw request bodies.

## Verification Cases

1. URL safety: source and route tests prove `/payment-recovery`, `/order-success`, SSLCommerz/Polar callbacks, admin copy links, and storefront payment-session calls never include receipt proof or OTP values in URLs.
2. No-JS safety: recovery forms render `method="post"` and cannot native-submit contact/code values into query strings before hydration.
3. Enumeration: send-code returns the same status/body for nonexistent order, wrong contact, deleted order, paid order, cancelled order, unsupported gateway, and valid eligible order; only the valid case enqueues delivery.
4. Rate limits: repeated sends hit D1 IP/order/contact buckets; concurrent sends cannot exceed the configured quota; production ignores spoofed `X-Forwarded-For`.
5. OTP attempts: parallel wrong-code verifies consume all attempts exactly once and lock at the max; one correct verify wins under concurrency; later correct-code replays fail without creating another receipt.
6. Finalization atomicity: simulate receipt-record failure and prove the challenge remains pending or retryable; simulate consumed challenge and prove exactly one `order_receipts` hash exists.
7. Proof secrecy: direct public API verify responses never contain `receiptToken`, `tokenHash`, OTP code, raw contact, provider payload, or Set-Cookie for the API domain. The storefront proxy response sets only the per-order HttpOnly cookie and a clean redirect target.
8. Leaked URL: opening the merchant URL in a fresh browser cannot read receipt PII, submit support requests, or create SSLCommerz/Polar sessions before OTP verification.
9. State gates: recovery is rejected for deleted, cancelled, returned, refunded, partially refunded, paid, partially paid unsafe, COD, Stripe-only, active shipment-claim, active payment-session, pending-payment-row, and succeeded-payment-row orders.
10. Existing flow integration: after successful OTP verification, `/order-success?orderId=...` renders the minimal receipt through the cookie, and existing SSLCommerz/Polar payment-session proxies create/replay sessions through D1 single-flight.
11. Provider readiness: missing email/SMS/WhatsApp settings fail closed before challenge creation; provider failures log masked metadata only and do not leave usable challenges without queued delivery.
12. Expiry cleanup: expired challenges and rate-limit windows are swept by scheduled maintenance in bounded batches; expired challenges cannot be verified or finalized.
