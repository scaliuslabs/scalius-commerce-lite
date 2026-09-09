# Steadfast Courier

Last verified: **2026-09-09**

## Sources, environment, and authentication

Primary sources: [Steadfast API documentation](https://docs.google.com/document/d/e/2PACX-1vTi0sTyR353xu1AK0nR8E_WKe5onCkUXGEf8ch8uoJy9qxGfgGnboSIkNosjQ0OOdXkJhgGuAsWxnIh/pub), [Steadfast webhook settings](https://steadfast.com.bd/user/webhook/add), and the [official Steadfast API WordPress plugin listing](https://wordpress.org/plugins/steadfast-api/).

The documented API base is production-only: `https://portal.packzy.com/api/v1`. No official sandbox endpoint was verified. API calls use `Api-Key`, `Secret-Key`, and `Content-Type: application/json`. `GET /get_balance` is the Scalius live credential test; a provider becomes action-ready only after the current saved setup passes and is active.

A saved provider named “Steadfast Demo” is still connected to whichever base URL and account it contains; the name does not create test isolation. On 2026-09-09 the callback URL and generated bearer token were saved in both Scalius and the portal; absent or invalid bearer requests returned HTTP 401, while the configured bearer received the documented HTTP 200 success response for a synthetic unmatched tracking update. Saving the token correctly reset the saved live-test/active proof, and a fresh credential test restored the provider to Active at 09:59 UTC. The portal account remained on an ownership hold with email unverified. A callback sent by Steadfast and a real courier booking were not verified. Do not claim end-to-end production verification from this configuration. Account/KYC/ownership approval remains provider-controlled.

## Booking and lookup contract

Scalius uses `POST /create_order` with the exact internal order ID as `invoice`, national-format phone, saved recipient identity, a full address composed from saved address/area/zone/city names, and authoritative saved COD balance. The adapter accepts success only when status `200` includes a positive integer consignment ID and status. Explicit 400/401/403/404/422 rejection permits a corrected attempt; network/read failure, server response, malformed JSON, or incomplete identity remains unknown and is not automatically retried.

Status reads are `GET /status_by_cid/{id}`, `/status_by_invoice/{invoice}`, and, where needed outside the current adapter, `/status_by_trackingcode/{trackingCode}`. The documented response is only status plus `delivery_status`; it does not return identity fields. A positive invoice lookup can establish presence for the original invoice and blocks a “not created” attestation. A failed/404/unknown lookup cannot establish absence. CID success cannot establish that an arbitrary supplied ID belongs to the order, so it must never be auto-attached on status alone.

The documentation calls invoice values unique, but a published bulk example repeats invoice values. Scalius therefore does not treat `invoice` as provider idempotency and does not issue speculative duplicate creates.

Owning code/tests: [`providers/steadfast.ts`](../../packages/core/src/modules/delivery/providers/steadfast.ts), [`delivery.create-outcome.d1.test.ts`](../../packages/core/src/modules/delivery/delivery.create-outcome.d1.test.ts), and [`orders.fulfillment.ts`](../../packages/core/src/modules/orders/orders.fulfillment.ts).

## Status and recovery

The documented delivery statuses include pending/review, hold, delivered, partial-delivered, cancelled, unknown, and approval-pending forms. Exact normalization lives in [`status-mapper.ts`](../../packages/core/src/modules/delivery/status-mapper.ts). `cancelled_approval_pending` maps to `on_hold`, because provider cancellation is not final and must not reopen booking. `unknown_approval_pending`, arbitrary strings, and other unrecognized values stay unknown and retain reconciliation locks. Delivered approval-pending statuses remain delivered because the delivery is physically complete while approval/payment settlement is pending.

Unknown creation follows the shared claim/version guard. Positive invoice presence blocks an absence claim. Portal/support confirmation of non-creation or final cancellation must bind to the exact order/provider and persist operation key, actor, source, time, note, and outcome before releasing the claim.

## Webhook contract

Configure the callback ending in `/webhooks/steadfast` in the portal. The portal webhook authentication token is a separate secret from `Api-Key` and `Secret-Key`. Steadfast sends it as `Authorization: Bearer <configured auth token>` with `Content-Type: application/json`; Scalius verifies it against the single active Steadfast provider.

Steadfast documents two POST JSON notification types:

- `delivery_status`: `notification_type`, integer `consignment_id`, string `invoice`, float `cod_amount`, `status` (`pending`, `delivered`, `partial_delivered`, `cancelled`, or `unknown`), float `delivery_charge`, `tracking_message`, and `updated_at` formatted `YYYY-MM-DD HH:mm:ss`.
- `tracking_update`: `notification_type`, `consignment_id`, `invoice`, `tracking_message`, and `updated_at`.

A successful receiver returns HTTP 200 with `{ "status": "success", "message": "Webhook received successfully." }`. Scalius deduplicates notifications, scopes shipment lookup by provider ID/type and consignment/invoice evidence, updates delivery status only for `delivery_status`, and stores tracking text without changing status for `tracking_update`.

Do not log the bearer token, API keys, webhook body, raw provider response, or buyer data. Owning route/tests: [`webhooks/steadfast.ts`](../../apps/api/src/routes/webhooks/steadfast.ts), [`webhooks/steadfast.test.ts`](../../apps/api/src/routes/webhooks/steadfast.test.ts), and [`webhook-auth.ts`](../../apps/api/src/middleware/webhook-auth.ts).
