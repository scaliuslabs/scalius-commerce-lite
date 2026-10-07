# Pathao

Pathao is a built-in courier (`type = pathao`). This page is for operators who set it up and contributors who change its adapter. Runtime rules are in the [delivery domain README](../../packages/core/src/modules/delivery/README.md). Webhook verification is in the [folder README](README.md). Provider documentation: [Pathao Merchant Courier developer API](https://merchant.pathao.com/courier/developer-api) and the [official WooCommerce bridge](https://github.com/pathao-eng/courier-woocommerce-plugin/blob/main/pathao-bridge.php). Never copy example credentials into a saved setup.

## Environments and credentials

| Environment | Base URL (dashboard preset) |
|-------------|-----------------------------|
| Sandbox (default for a new courier) | `https://courier-api-sandbox.pathao.com` |
| Production | `https://api-hermes.pathao.com` |

A saved courier uses the base URL it contains. Changing the environment in the form clears the draft keys, because each environment has its own.

| Field | Where | Notes |
|-------|-------|-------|
| `baseUrl`, `clientId`, `clientSecret`, `username`, `password` | credentials | Required to activate. |
| `webhookSecret` | credentials | The webhook secret, not the OAuth client secret. |
| `storeId` | config | Required to activate. It must be an active Pathao store. |
| `defaultDeliveryType` (48), `defaultItemType` (2), `defaultItemWeight` (0.5) | config | Booking defaults. A staff option overrides each. |

## Calls

Paths start with `/aladdin/api/v1`. Each adapter call requests a new token (`packages/core/src/modules/delivery/couriers/pathao.ts`, `packages/core/src/modules/delivery/pathao-location-import.ts`).

| Purpose | Request |
|---------|---------|
| Token | `POST /issue-token` with `client_id`, `client_secret`, `grant_type: "password"`, `username`, `password`. Later calls send `Authorization: Bearer <token>`. |
| Connection test | `GET /stores`, following `?page=n` up to 10 pages. The configured `store_id` must appear with `is_active` of 1. |
| Book | `POST /orders` |
| Status | `GET /orders/{consignmentId}/info` |
| Location import | `GET /city-list`, `GET /cities/{cityId}/zone-list`, `GET /zones/{zoneId}/area-list` |

## Booking

- The body carries `store_id`, `merchant_order_id` (the Scalius order id), recipient name, local-format phone and address, the Pathao city, zone and area ids, `delivery_type`, `item_type`, `item_quantity`, `item_weight`, `item_description`, `special_instruction` and `amount_to_collect`. The saved order supplies all money and content.
- COD must be a whole taka. A fraction is refused before any call, with advice to use another courier. Scalius never rounds order money.
- City and zone need a positive integer in `places.external_ids.pathao`, and the area is optional. The check runs before the placeholder row and before any token request. The Bangladesh dataset (`plugins/bangladesh/places`, loaded when the Bangladesh pack is activated) and the import in Settings, Shipping, Delivery areas create the mapping ([places](../PLACES.md)).
- Success needs HTTP success, body `code` 200, a non-empty `data.consignment_id` and a string `data.order_status`. The consignment id is both `external_id` and `tracking_id`. The delivery fee (taka) is kept as the booking charge.
- Explicit rejection: body `code` 400, 401, 403, 404 or 422, with a matching or successful HTTP status. A corrected booking is then safe. Anything else (network or read failure, server error, malformed JSON, missing identity) is an unknown outcome. A booking is never retried automatically.
- Pathao has no lookup by `merchant_order_id`. An unknown outcome resolves only by merchant attestation after the Pathao portal or support confirms.

## Status map

`mapProviderStatus("pathao", status)` tries the exact value (webhook events), then the value lowercased with spaces turned into `_` (API strings, for example `assigned_for_pickup`). An unmapped value becomes `unknown` with a logged warning. The API strings are mostly the event names without `order.` and with `_` for `-`; `status-mapper.ts` has the full list.

| Canonical status | Webhook events |
|------------------|----------------|
| `pending` | `order.created`, `order.updated`, `order.pickup-requested` |
| `pickup_assigned` | `order.assigned-for-pickup` |
| `picked_up` | `order.picked` |
| `pickup_failed` | `order.pickup-failed` |
| `cancelled` | `order.pickup-cancelled` |
| `in_transit` | `order.at-the-sorting-hub`, `order.in-transit`, `order.received-at-last-mile-hub` |
| `out_for_delivery` | `order.assigned-for-delivery` |
| `delivered` | `order.delivered`, `order.paid`, `order.exchanged` |
| `partial_delivered` | `order.partial-delivery` |
| `returned` | `order.returned`, `order.paid-return` |
| `delivery_failed` | `order.delivery-failed` |
| `on_hold` | `order.on-hold` |

## Webhook

Callback URL: `<API origin>/api/v1/webhooks/pathao`. Source: `apps/api/src/routes/webhooks/pathao.ts`.

- Pathao sends the merchant secret in the `X-PATHAO-Signature` header.
- The test event `{ "event": "webhook_integration" }` gets HTTP 202 and the header `X-Pathao-Merchant-Webhook-Integration-Secret` with the merchant secret. Store events (`store.*`), unknown consignments and duplicates also get 202 with that header and change nothing.
- An event is deduplicated by event name and consignment id. The shipment is matched by consignment id, provider id and type. Then the shared pipeline runs.
- No merchant secret answers 503. A failed verification answers 401.
- The shipment `metadata` keeps the last payload, plus `collected_amount`, `delivery_fee` and `reason` when present.

## Set up and test

1. Settings, Shipping, Couriers: add a Pathao courier, enter the five credentials and the store id, and save.
2. Run Test connection. Any credential edit clears the proof and needs a new test.
3. Switch the courier on. Keep one active Pathao row: webhooks and the location import use it.
4. Settings, Shipping, Delivery areas: choose Import Bangladesh locations.
5. In the courier form, generate the webhook key. Enter the callback URL and the key in the Pathao merchant portal (portal screens unverified).
6. Book a COD order with a whole-taka balance and check the consignment id.

## Provider-side facts (unverified)

- Pathao's limits: an 11-digit recipient phone, an address of 10 to 220 characters, a weight of 0.5 to 10 kg, delivery type 48 for normal delivery, item type 2 for a parcel.
- On 2026-09-09 the sandbox answered HTTP 422 "The amount to collect must be an integer." for `5570.8` and accepted `5571`.
- A sandbox booking proves the request path only, not production approval.
