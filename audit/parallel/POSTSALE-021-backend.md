# POSTSALE-021 Backend/API/Core Audit

Date: 2026-07-05

## Scope

Audit target: merchant-sendable, cross-browser hosted-payment recovery after receipt proof was removed from URLs. This is read-only against production code; the recommendation below is implementation-ready but not implemented here.

## Current Flow Map

- Receipt proof authority is D1-first. `order_receipts.token_hash` stores only SHA-256 hashes of `chk_` receipt tokens, with `checkout_attempts.checkout_token` as a legacy/checkout fallback that repairs `order_receipts` on validation. KV keys use the receipt-token hash and are only hints.
- Guest receipts now depend on a same-origin httpOnly storefront cookie plus `X-Receipt-Token` or POST body proof from server-side storefront proxies. `/order-success` strips legacy proof query params and cannot open a guest receipt from a clean URL without the private cookie.
- Hosted payment retry sessions for SSLCommerz and Polar already require receipt proof. Storefront `/api/checkout/*-session` proxies read the receipt cookie, strip browser-supplied token fields, and call API payment session routes with proof. Gateway callbacks return to clean `/order-success?...` URLs with no receipt proof.
- Admin `POST /api/v1/admin/orders/{id}/payment-recovery-link` validates hosted-payment recovery eligibility and records a fresh receipt token in `order_receipts`, but the API response intentionally returns only a clean same-browser URL and no raw token or token hash. It cannot support cross-browser merchant-sendable recovery by itself.
- Current uncommitted workspace changes already factor admin recovery eligibility into a preview helper and add a minimal `order_payment_recovery_challenges` D1 table/migration. Treat that as partial scaffolding: there is still no complete public handoff route, OTP verification service, trusted storefront cookie handoff, or proofless merchant-sendable flow.
- Authenticated customer recovery is separate: `/api/v1/customer-auth/orders/{id}/payment-session` verifies the customer session and order ownership, then creates a hosted session with `customer_account` proof. It does not use or return receipt tokens.
- Customer auth OTP is account-scoped for `sign_in` and `sign_up`. It persists privacy-safe D1 challenges and uses `AUTH_OTP_QUEUE`, but verification creates or resumes a customer session, so it is not a safe drop-in for order recovery.
- Notification/outbox infrastructure exists for order lifecycle, refund, support, and balance-paid notifications. There is no payment-recovery notification type or template today.

## Backend Design Recommendation

Add a dedicated order-owned payment-recovery handoff/challenge flow. Keep the existing admin same-browser recovery link unchanged.

1. Add a core service for payment recovery challenges, for example `packages/core/src/modules/orders/order-payment-recovery-challenges.ts`.
2. Use the factored admin recovery preview helper if that concurrent WIP lands; otherwise factor the hosted-payment eligibility checks so the existing same-browser link and the new handoff agree on recoverability.
3. Add an admin route such as `POST /api/v1/admin/orders/{id}/payment-recovery-handoff`, guarded by `ORDERS_EDIT`, that creates a durable handoff and returns only a safe storefront URL such as `/payment-recovery?r=opr_...`, masked contact hints, expiry, gateway, payment type, and deposit amount. Do not return receipt tokens, token hashes, OTP codes, raw contacts, or provider payloads.
4. Add public recovery state/send routes that expose only generic state and masked contact data. Link possession alone must not reveal order PII and must not validate receipt access.
5. OTP send should pin delivery to contact data already stored on the order, preferably phone first where available/ready. Do not allow the request body to replace the buyer contact.
6. OTP verify must re-read recovery eligibility, consume the challenge atomically, mint a fresh `chk_` token, call `recordOrderReceipt(..., source: "payment_recovery_verified")`, and set the storefront receipt cookie through a trusted same-origin storefront proxy.
7. Public/direct browser API responses must never expose raw receipt proof. The raw token should only cross a trusted server-to-server boundary to the storefront proxy that sets `scalius_receipt_*` as httpOnly and redirects to a clean `/order-success?orderId=...&payment=...` URL.
8. After the cookie is set, reuse the existing receipt page and hosted-payment session proxies. No separate payment-session implementation should be needed.

## Tables And Migrations

Committed/base tables are not sufficient for guest cross-browser recovery:

- Do not extend `customer_auth_otp_challenges`; it is account/session-oriented, keyed by contact/channel, and has `sign_in`/`sign_up` semantics.
- Do not change `order_receipts` for token storage. It already stores hash-only receipt proof and `source` is text, so `payment_recovery_verified` needs no migration unless a stricter enum is introduced later.
- Do not use KV as the source of truth. Optional KV hints may be used only for non-PII, non-proof cache data.

Add or harden a D1 table, suggested name `order_payment_recovery_challenges`, with no raw contacts, OTPs, receipt tokens, or provider payloads. The current WIP migration already covers `challenge_key`, `order_id`, `delivery_key`, method/channel, identifier hash/mask, code hash, pending/consumed/locked status, attempts, resend, expiry, and indexes; before shipping it should either be extended or deliberately paired with derived order data for the remaining lifecycle/audit needs:

- `id` opaque public identifier, primary key.
- `order_id` foreign key to `orders.id`.
- `gateway`, `payment_type`, `deposit_amount`, and `currency` captured from current recovery eligibility.
- `status`: `pending`, `otp_sent`, `verified`, `consumed`, `expired`, `revoked`, or `locked`.
- `contact_channel`, `contact_hash`, `contact_masked`, and optional `delivery_key`.
- `code_hash`, `attempts`, `max_attempts`, `send_attempts`, `resend_available_at`, `expires_at`, `verified_at`, `consumed_at`.
- Optional audit fields such as `created_by_admin_id`, `receipt_token_hash`, `last_error`, `created_at`, and `updated_at`.
- Indexes on `(order_id, status, created_at)`, `(status, expires_at)`, unique `delivery_key`, and a throttling-oriented contact hash/time index if needed.

If merchant auto-send is required, add a separate `payment_recovery_requested` notification type/template later. The first slice can be copy-link plus buyer-opened OTP to avoid widening notification settings and templates.

## Route And Service Boundaries

- Core service owns eligibility, challenge lifecycle, OTP code hashing/attempts, rate limits, and receipt-token minting.
- API admin route owns merchant creation of a safe handoff URL and must be declared before dynamic order routes.
- Public API may expose generic state and OTP send/verify orchestration, but any response carrying raw receipt proof must be restricted to a trusted storefront-server caller. Browser-facing endpoints should return only success state, masked contact, and clean redirect targets.
- Storefront owns `/payment-recovery` UI and same-origin POST handlers. The verify handler sets the receipt cookie and redirects; it should not put proof in URLs, analytics, logs, or clipboard links.
- Existing SSLCommerz/Polar payment session routes remain receipt-proof guarded and unchanged after cookie recovery.
- Existing customer-auth account payment recovery remains the authenticated shortcut and should not mint guest receipt proof.
- OTP delivery can reuse `AUTH_OTP_QUEUE` and delivery receipts with `purpose: "payment_recovery"` only if templates/copy are made purpose-specific. Challenge verification must remain in the new order-owned service.

## Tests To Add

- Core eligibility tests for incomplete SSLCommerz/Polar orders: reject deleted orders, non-hosted gateways, paid/partially paid orders, active shipment claims, active payment setup, unsafe pending/succeeded evidence, and stale/failed evidence mismatches.
- Core challenge tests proving no raw phone/email/code/receipt token is stored; wrong attempts lock; expired/revoked/consumed challenges fail; correct verification is atomic.
- Core receipt tests proving verified recovery creates `order_receipts` with source `payment_recovery_verified` and hash-only token storage.
- API admin route tests for RBAC, route ordering, no `receiptToken`/`tokenHash` response fields, no proof in generated URL, and fail-closed behavior when storefront URL/config is missing.
- Public recovery tests proving a leaked recovery URL alone cannot open `/orders/receipt`, create a payment session, or reveal order PII.
- OTP send tests proving delivery uses order-pinned contact, rate limits/resend cooldowns apply, queue failure marks or removes the challenge safely, and provider metadata is masked.
- Verify/proxy integration tests proving successful OTP sets the receipt cookie via storefront, redirects to a clean URL, and then existing SSLCommerz/Polar session proxies work from the new browser.
- Regression tests for existing admin same-browser recovery link, customer-account recovery, receipt URL stripping, and no proof in gateway callback URLs.
- Schema/migration tests plus `pnpm db:generate` after schema changes and `pnpm generate:sdk` after API contract changes.

## Risks

- Returning raw receipt tokens to browser JavaScript or direct public API callers would recreate the bearer-proof leak that PRIV-003 removed.
- Reusing customer auth OTP verification would accidentally create/sign in customers and can collide with account OTP storage keys.
- Link-only recovery would let forwarded merchant messages expose receipt PII; buyer proof must be mandatory.
- Orders may have phone but no usable email, and SMS/WhatsApp providers may be disabled; channel policy must fail closed with clear merchant/buyer messaging.
- Existing OTP templates are customer-login oriented; payment recovery needs purpose-specific copy before using the shared queue.
- Payment webhooks and session attempts can race OTP verification, so eligibility must be rechecked at verify time and again by existing payment-session guards.
- Notification outbox dedupe and payloads need care if auto-send is added; never store receipt proof or raw buyer PII in outbox payloads, logs, or provider metadata.
