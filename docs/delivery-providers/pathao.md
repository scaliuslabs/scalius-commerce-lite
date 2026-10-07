# Pathao

Pathao is a courier of the Bangladesh pack (`type = scalius.bangladesh:pathao`, code `plugins/bangladesh/src/couriers.ts`). This page is for operators who set it up and contributors who change it. Runtime rules are in the [delivery domain README](../../packages/core/src/modules/delivery/README.md). Webhook verification is in the [folder README](README.md). Provider documentation: [Pathao Merchant Courier developer API](https://merchant.pathao.com/courier/developer-api) and the [official WooCommerce bridge](https://github.com/pathao-eng/courier-woocommerce-plugin/blob/main/pathao-bridge.php). Never copy example credentials into a saved setup.

## Environments and settings

| Environment | API address (`pathao_base_url`) |
|-------------|---------------------------------|
| Production (default) | `https://api-hermes.pathao.com` |
| Sandbox | `https://courier-api-sandbox.pathao.com` |

The address must be one of these hosts (the pack's `allowedHosts`).

| Setting | Notes |
|---------|-------|
| `pathao_base_url`, `pathao_client_id`, `pathao_client_secret`, `pathao_username`, `pathao_password`, `pathao_store_id` | Required to book. The store must be an active Pathao store. |
| `pathao_webhook_secret` | The webhook secret, not the OAuth client secret. Without it no push is accepted. |
| `pathao_delivery_type` (48), `pathao_item_type` (2), `pathao_item_weight` (0.5 kg) | Booking defaults. A staff option on the booking form overrides each. |

## Calls

Paths start with `/aladdin/api/v1`. Each operation requests a new token (`plugins/bangladesh/src/couriers.ts`; the place refresh: `plugins/bangladesh/src/pathao-places.ts`).

| Purpose | Request |
|---------|---------|
| Token | `POST /issue-token` with `client_id`, `client_secret`, `grant_type: "password"`, `username`, `password`. Later calls send `Authorization: Bearer <token>`. |
| Connection test | `GET /stores`, following `?page=n` up to 10 pages. The configured `store_id` must appear with `is_active` of 1. |
| Book | `POST /orders` |
| Status | `GET /orders/{consignmentId}/info` |
| Place refresh | `GET /city-list`, `GET /cities/{cityId}/zone-list`, `GET /zones/{zoneId}/area-list` |

## Booking

- The body carries `store_id`, `merchant_order_id` (the Scalius order id), recipient name, local-format phone and address, the Pathao city, zone and area ids, `delivery_type`, `item_type`, `item_quantity`, `item_weight`, `item_description`, `special_instruction` and `amount_to_collect`. The saved order supplies all money and content.
- COD must be a whole taka. A fraction is refused before any call, with advice to use another courier. Scalius never rounds order money.
- City and zone need a positive integer in `places.external_ids.pathao`, and the area is optional. The pack declares this (`locations: { key: "pathao", required: ["city", "zone"], numeric: true }`): the platform checks it before the placeholder row and before any request, and passes the ids as `recipient.locationIds`. The Bangladesh dataset (`plugins/bangladesh/places`, loaded when the pack is activated) and "Refresh from Pathao" on the pack's Bangladesh places page create the mapping ([places](../PLACES.md)).
- Success needs HTTP success, body `code` 200, a non-empty `data.consignment_id` and a string `data.order_status`. The consignment id is both `external_id` and `tracking_id`. The delivery fee (taka) is kept as the booking charge.
- Explicit rejection: body `code` 400, 401, 403, 404 or 422, with a matching or successful HTTP status. A corrected booking is then safe. Anything else (network or read failure, server error, malformed JSON, missing identity) is an unknown outcome. A booking is never retried automatically.
- Pathao has no lookup by `merchant_order_id`. An unknown outcome resolves only by merchant attestation after the Pathao portal or support confirms.

## Status map

`mapPathaoStatus(status)` (`plugins/bangladesh/src/couriers.ts`) tries the exact value (webhook events), then the value lowercased with spaces turned into `_` (API strings, for example `assigned_for_pickup`). An unmapped value becomes `unknown`. The API strings are mostly the event names without `order.` and with `_` for `-`.

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

Callback URL: `<API origin>/api/v1/webhooks/couriers/scalius.bangladesh:pathao`. The old `<API origin>/api/v1/webhooks/pathao` serves the same courier, so a URL saved in the Pathao portal before the pack keeps working. Source: `verifyWebhook` in `plugins/bangladesh/src/couriers.ts` and `apps/api/src/routes/webhooks/couriers.ts`.

- Pathao sends the merchant secret in the `X-PATHAO-Signature` header.
- The test event `{ "event": "webhook_integration" }` gets HTTP 202 and the header `X-Pathao-Merchant-Webhook-Integration-Secret` with the merchant secret. Store events (`store.*`), unknown consignments and duplicates also get 202 with that header and change nothing.
- A push without `event` or `consignment_id` answers 400. No merchant secret answers 503. A failed signature answers 401.
- An event is applied once per consignment and event name. The shipment is matched by consignment id, provider row and courier.
- The shipment `metadata` keeps `collectedAmount`, `deliveryFee` and `lastReason` when present. The raw payload is not kept.

## Set up and test

1. Apps, Bangladesh pack: activate it, then enter the Pathao settings and a long random webhook secret.
2. Settings, Shipping, Couriers: add Pathao (Bangladesh pack) and run Test connection.
3. Switch the courier on. Keep one active Pathao row: webhooks use it.
4. Apps, Bangladesh pack, Bangladesh places: the places load on activation; "Refresh from Pathao" reads Pathao's live list.
5. Enter the callback URL (shown in the courier form) and the webhook secret in the Pathao merchant portal (portal screens unverified).
6. Book a COD order with a whole-taka balance and check the consignment id.

## Provider-side facts (unverified)

- Pathao's limits: an 11-digit recipient phone, an address of 10 to 220 characters, a weight of 0.5 to 10 kg, delivery type 48 for normal delivery, item type 2 for a parcel.
- On 2026-09-09 the sandbox answered HTTP 422 "The amount to collect must be an integer." for `5570.8` and accepted `5571`.
- A sandbox booking proves the request path only, not production approval.
