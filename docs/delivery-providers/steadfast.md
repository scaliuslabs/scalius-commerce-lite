# Steadfast

Steadfast is a courier of the Bangladesh pack (`type = scalius.bangladesh:steadfast`, code `plugins/bangladesh/src/couriers.ts`). This page is for operators who set it up and contributors who change it. Runtime rules are in the [delivery domain README](../../packages/core/src/modules/delivery/README.md). Webhook verification is in the [folder README](README.md). Provider documentation: [Steadfast API documentation](https://docs.google.com/document/d/e/2PACX-1vTi0sTyR353xu1AK0nR8E_WKe5onCkUXGEf8ch8uoJy9qxGfgGnboSIkNosjQ0OOdXkJhgGuAsWxnIh/pub), [webhook settings](https://steadfast.com.bd/user/webhook/add) and the [official WordPress plugin](https://wordpress.org/plugins/steadfast-api/).

## Environment and settings

The default API address (`steadfast_base_url`) is the production `https://portal.packzy.com/api/v1`, the only allowed host. There is no sandbox, and a courier name such as "Steadfast Demo" gives no test isolation.

| Setting | Notes |
|---------|-------|
| `steadfast_base_url`, `steadfast_api_key`, `steadfast_secret_key` | Required to book. |
| `steadfast_webhook_secret` | The bearer token Steadfast sends to the callback. Left empty, the secret key is the token (as before the move). |

## Calls

Source: `plugins/bangladesh/src/couriers.ts`. Every request sends `Api-Key`, `Secret-Key` (both trimmed) and `Content-Type: application/json`.

| Purpose | Request |
|---------|---------|
| Connection test | `GET /get_balance`. It passes when the JSON body has `status` 200. |
| Book | `POST /create_order` |
| Status | `GET /status_by_cid/{consignmentId}` |
| Recovery lookup | `GET /status_by_invoice/{orderId}` (positive answers only) |

## Booking

- The body carries `invoice` (the Scalius order id), recipient name, local-format phone, `recipient_address` (address, area, thana and city joined by commas), `cod_amount` (the balance due, in major units) and `note`. The saved order supplies all money and content.
- Success needs HTTP success, body `status` 200, a positive integer `consignment.consignment_id` and a string `consignment.status`. `external_id` is the consignment id. `tracking_id` is the `tracking_code`. The shipment keeps the consignment's flat facts without the recipient's name, phone or address.
- Explicit rejection: body `status` 400, 401, 403, 404 or 422, with a matching or successful HTTP status. A corrected booking is then safe. Anything else is an unknown outcome. A booking is never retried automatically.
- A status read returns the delivery status only, no identity. The invoice lookup answers "found" only for HTTP success, body `status` 200 and a non-empty `delivery_status`. A found booking blocks a "not created" attestation. A failed, empty or 404 lookup never proves that no booking exists.
- Scalius never attaches a consignment id from a status read, and never treats `invoice` as courier-side idempotency.

## Status map

`mapSteadfastStatus(status)` (`plugins/bangladesh/src/couriers.ts`) lowercases the value. An unmapped value becomes `unknown`.

| Steadfast status | Canonical status |
|------------------|------------------|
| `pending`, `in_review` | `pending` |
| `hold`, `cancelled_approval_pending` | `on_hold` |
| `delivered`, `delivered_approval_pending` | `delivered` |
| `partial_delivered`, `partial_delivered_approval_pending` | `partial_delivered` |
| `cancelled` | `cancelled` |
| `unknown`, `unknown_approval_pending` | `unknown` |

`cancelled_approval_pending` maps to `on_hold` so that a cancellation that is not final cannot reopen the order for another booking.

## Webhook

Callback URL: `<API origin>/api/v1/webhooks/couriers/scalius.bangladesh:steadfast`. The old `<API origin>/api/v1/webhooks/steadfast` serves the same courier, so a URL saved in the Steadfast portal before the pack keeps working. Source: `verifyWebhook` in `plugins/bangladesh/src/couriers.ts` and `apps/api/src/routes/webhooks/couriers.ts`.

- Steadfast sends `Authorization: Bearer <token>`.
- Two types are accepted. Another `notification_type` answers 400.

| `notification_type` | Fields used | Effect |
|---------------------|-------------|--------|
| `delivery_status` | `consignment_id`, `invoice`, `status`, `cod_amount`, `delivery_charge`, `tracking_message` | Maps `status`, updates the shipment, then runs the shared pipeline. |
| `tracking_update` | `consignment_id`, `invoice`, `tracking_message`, `updated_at` | Stores the tracking text in `metadata`. The status does not change. |

- Success answers HTTP 200 `{ "status": "success", "message": "Webhook received successfully." }`. Unmatched shipments, duplicates and ignored events answer the same. Failed verification answers 401. A malformed push (another type, no status or ids) answers 400. A processing failure answers 500.
- A push is deduplicated by consignment id (or invoice), type and status (or update time and message).
- The shipment is matched by consignment id, provider row and courier. A match whose order differs from `invoice` is rejected. Without a match, a push with both ids can bind to the single shipment of that invoice that an unknown-outcome resolution (courier lookup or merchant attestation) confirmed as existing and that has no `external_id` yet. The platform does this for any courier that echoes the order number (`orderId` in the port's answer).

## Set up and test

1. Apps, Bangladesh pack: activate it, then enter the Steadfast API key, secret key and (best) a separate webhook secret.
2. Settings, Shipping, Couriers: add Steadfast (Bangladesh pack) and run Test connection.
3. Switch the courier on. Keep one active Steadfast row.
4. Enter the callback URL (shown in the courier form) and the webhook secret as the bearer token in the Steadfast portal (portal screens unverified).
5. Book an order and check the consignment id and tracking code.

## Provider-side facts (unverified)

- The documented statuses are pending or in review, hold, delivered, partial delivered, cancelled, unknown, and approval-pending forms.
- The documentation calls the invoice unique, but a published bulk example repeats invoice values.
- No callback sent by Steadfast and no real booking has been observed. A test of this setup does not prove production readiness.
