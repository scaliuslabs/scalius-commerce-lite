# Pathao Courier

Last verified: **2026-09-09**

## Sources and environments

Primary source: [Pathao Merchant Courier developer API](https://merchant.pathao.com/courier/developer-api). The [official WooCommerce bridge](https://github.com/pathao-eng/courier-woocommerce-plugin/blob/main/pathao-bridge.php) is useful corroboration for request shapes. Do not copy example credentials into saved configuration; obtain current credentials from Pathao.

| Environment | Base URL | Meaning |
| --- | --- | --- |
| Sandbox | `https://courier-api-sandbox.pathao.com` | Pathao test account, stores, locations, and consignments |
| Production | `https://api-hermes.pathao.com` | Merchant production account and real consignments |

Environment changes require matching client ID, client secret, username, password, store ID, and webhook secret. Production credentials are not sandbox credentials. The Scalius form clears environment-specific draft credentials when the environment changes.

## Authentication and endpoints

Pathao uses an OAuth password grant at `POST /aladdin/api/v1/issue-token` with `client_id`, `client_secret`, username, and password. Subsequent API calls use `Authorization: Bearer <access token>`.

All courier paths below use the `/aladdin/api/v1` prefix. Scalius uses:

- `POST /issue-token` for password-grant access. Refresh-token grant uses this same endpoint.
- `GET /stores`, following pagination through `last_page`; the configured `store_id` must be found with `is_active: 1`.
- `GET /city-list`, `GET /cities/{cityId}/zone-list`, and `GET /zones/{zoneId}/area-list` for location import.
- `POST /orders` for creation.
- `GET /orders/{consignmentId}/info` for status.

The official contract also documents `POST /stores` for store creation, `POST /orders/bulk` for bulk creation, and `POST /merchant/price-plan` for price calculation. These are reference endpoints; the current Scalius runtime does not call them.

The store readiness scan is bounded to ten pages. If an account grows beyond that bound and its store is not found, add provider-side lookup or revisit the bound; do not silently accept an unverified store.

## Booking contract

Scalius sends the exact internal order ID as `merchant_order_id`, formats a saved E.164 phone into national form, sums saved order-item quantities, derives the item description from saved products, and takes COD from the saved balance. Merchant/UI input cannot override those commerce facts. The configured delivery type, item type, weight, and optional instruction remain merchant choices; the default weight is `0.5 kg`.

Pathao's creation field contract requires an 11-digit recipient phone, a recipient address of 10–220 characters, item weight from `0.5` through `10` kg, delivery type `48` for normal delivery, and item type `2` for parcels. Scalius formats the phone and defaults to delivery type `48`, parcel type `2`, and weight `0.5`; provider validation remains authoritative for merchant overrides.

City and zone must resolve to positive integer `externalIds.pathao` values. Area is optional and is omitted when null; if present it must resolve precisely. Names or guessed IDs are not substitutes. Location import and the creation preflight own this mapping.

Pathao requires a non-negative whole-taka COD value. **Observed in Pathao Sandbox on 2026-09-09:** the otherwise valid payload with `amount_to_collect: 5570.8` returned HTTP 422 and field error “The amount to collect must be an integer.” Scalius now rejects that balance before token, location, or booking calls and recommends another courier; it does not round or mutate order money. A follow-up sandbox booking with whole-taka COD `5571` succeeded and returned demo consignment/tracking ID `DT090926QU7957`. This proves the sandbox request path only, not production readiness or KYC approval.

The adapter accepts success only when HTTP/provider success includes a non-empty consignment ID and order status. HTTP 400/401/403/404/422 with a matching provider code is an explicit rejection. Network/read failures, server responses, malformed JSON, missing identity, and unrecognized results are unknown outcomes. Creation is not automatically retried.

Owning code/tests: [`providers/pathao.ts`](../../packages/core/src/modules/delivery/providers/pathao.ts), [`providers/pathao.test.ts`](../../packages/core/src/modules/delivery/providers/pathao.test.ts), [`pathao-location-import.ts`](../../packages/core/src/modules/delivery/pathao-location-import.ts), and [`delivery.create-outcome.d1.test.ts`](../../packages/core/src/modules/delivery/delivery.create-outcome.d1.test.ts).

## Status and recovery

Pathao status polling requires the known external consignment ID. Scalius has no verified Pathao lookup by `merchant_order_id`; a missing or failed check cannot prove non-creation. Unmapped API statuses or webhook events normalize to `unknown` and do not release shipment claims. See the exact event/API map in [`status-mapper.ts`](../../packages/core/src/modules/delivery/status-mapper.ts).

For an unknown creation outcome, keep the lock. Resolve it only from the Pathao portal or support for the exact order/provider. Confirmed existing consignments need their real identity; confirmed non-creation/cancellation needs the current order version, matching claim, stable operation key, actor, source, bounded note, and explicit exact-order attestation.

## Webhooks

Configure the Scalius callback ending in `/webhooks/pathao` and a merchant-owned webhook secret. Pathao sends that secret in `X-PATHAO-Signature`; Scalius compares it in constant time against the one active Pathao provider. The integration test event is `{ "event": "webhook_integration" }`; Scalius responds HTTP 202 and returns `X-Pathao-Merchant-Webhook-Integration-Secret`. Store events are acknowledged without changing shipments. Shipment events are deduplicated and scoped by provider ID/type plus consignment ID before status, inventory, cache, and notification work.

The webhook secret is not the OAuth client secret. Do not log request bodies or buyer/provider payloads. Owning route/tests: [`webhooks/pathao.ts`](../../apps/api/src/routes/webhooks/pathao.ts) and [`webhooks/pathao.test.ts`](../../apps/api/src/routes/webhooks/pathao.test.ts).
