# Steadfast

Steadfast is a built-in courier (`type = steadfast`). This page is for operators who set it up and contributors who change its adapter. Runtime rules are in the [delivery domain README](../../packages/core/src/modules/delivery/README.md). Webhook verification is in the [folder README](README.md). Provider documentation: [Steadfast API documentation](https://docs.google.com/document/d/e/2PACX-1vTi0sTyR353xu1AK0nR8E_WKe5onCkUXGEf8ch8uoJy9qxGfgGnboSIkNosjQ0OOdXkJhgGuAsWxnIh/pub), [webhook settings](https://steadfast.com.bd/user/webhook/add) and the [official WordPress plugin](https://wordpress.org/plugins/steadfast-api/).

## Environment and credentials

The dashboard preset is the production base URL `https://portal.packzy.com/api/v1`. There is no sandbox preset, and a courier name such as "Steadfast Demo" gives no test isolation.

| Field | Where | Notes |
|-------|-------|-------|
| `baseUrl`, `apiKey`, `secretKey` | credentials | Required to activate. |
| `webhookSecret` | credentials | The bearer token Steadfast sends to the callback. Keep it separate from `apiKey` and `secretKey`. |

## Calls

Source: `packages/core/src/modules/delivery/couriers/steadfast.ts`. Every request sends `Api-Key`, `Secret-Key` (both trimmed) and `Content-Type: application/json`.

| Purpose | Request |
|---------|---------|
| Connection test | `GET /get_balance`. It passes when the JSON body has `status` 200. |
| Book | `POST /create_order` |
| Status | `GET /status_by_cid/{consignmentId}` |
| Recovery lookup | `GET /status_by_invoice/{orderId}` (positive answers only) |

## Booking

- The body carries `invoice` (the Scalius order id), recipient name, local-format phone, `recipient_address` (address, area, thana and city joined by commas), `cod_amount` (the balance due, in major units) and `note`. The saved order supplies all money and content.
- Success needs HTTP success, body `status` 200, a positive integer `consignment.consignment_id` and a string `consignment.status`. `external_id` is the consignment id. `tracking_id` is the `tracking_code`.
- Explicit rejection: body `status` 400, 401, 403, 404 or 422, with a matching or successful HTTP status. A corrected booking is then safe. Anything else is an unknown outcome. A booking is never retried automatically.
- A status read returns the delivery status only, no identity. The invoice lookup answers "found" only for HTTP success, body `status` 200 and a non-empty `delivery_status`. A found booking blocks a "not created" attestation. A failed, empty or 404 lookup never proves that no booking exists.
- Scalius never attaches a consignment id from a status read, and never treats `invoice` as courier-side idempotency.

## Status map

`mapProviderStatus("steadfast", status)` lowercases the value. An unmapped value becomes `unknown` with a logged warning.

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

Callback URL: `<API origin>/api/v1/webhooks/steadfast`. Source: `apps/api/src/routes/webhooks/steadfast.ts`.

- Steadfast sends `Authorization: Bearer <token>`.
- Two types are accepted. Another `notification_type` answers 400.

| `notification_type` | Fields used | Effect |
|---------------------|-------------|--------|
| `delivery_status` | `consignment_id`, `invoice`, `status`, `cod_amount`, `delivery_charge`, `tracking_message` | Maps `status`, updates the shipment, then runs the shared pipeline. |
| `tracking_update` | `consignment_id`, `invoice`, `tracking_message`, `updated_at` | Stores the tracking text in `metadata`. The status does not change. |

- Success answers HTTP 200 `{ "status": "success", "message": "Webhook received successfully." }`. Unmatched shipments, duplicates and ignored events answer the same. Failed verification answers 401. A processing failure answers 500.
- A push is deduplicated by consignment id (or invoice), type and status (or update time and message).
- The shipment is matched by consignment id, provider id and type. A match whose order differs from `invoice` is rejected. Without a match, a push with both ids can bind to the single shipment of that invoice that an unknown-outcome resolution (courier lookup or merchant attestation) confirmed as existing and that has no `external_id` yet.

## Set up and test

1. Settings, Shipping, Couriers: add a Steadfast courier, enter the base URL, API key and secret key, and save.
2. Run Test connection. Any credential edit, including a new webhook key, clears the proof and needs a new test.
3. Switch the courier on. Keep one active Steadfast row.
4. In the courier form, generate the webhook key. Enter the callback URL and the key in the Steadfast portal (portal screens unverified).
5. Book an order and check the consignment id and tracking code.

## Provider-side facts (unverified)

- The documented statuses are pending or in review, hold, delivered, partial delivered, cancelled, unknown, and approval-pending forms.
- The documentation calls the invoice unique, but a published bulk example repeats invoice values.
- No callback sent by Steadfast and no real booking has been observed. A test of this setup does not prove production readiness.
