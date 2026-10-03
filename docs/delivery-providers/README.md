# Delivery providers

Courier reference for operators who connect a courier and contributors who change a courier adapter: credentials, calls, status maps, webhooks and test steps. Runtime behavior (readiness, booking, unknown outcomes, status sync) is owned by the [delivery domain README](../../packages/core/src/modules/delivery/README.md).

| Courier | `type` | Auth | Webhook callback | Lookup by order id | Reference |
|---------|--------|------|------------------|--------------------|-----------|
| Pathao | `pathao` | OAuth password grant | `/api/v1/webhooks/pathao` | none | [pathao.md](pathao.md) |
| Steadfast | `steadfast` | `Api-Key` and `Secret-Key` headers | `/api/v1/webhooks/steadfast` | by invoice | [steadfast.md](steadfast.md) |
| Courier app | `<plugin id>:<provider id>` | the app's own settings | `/api/v1/webhooks/couriers/{id}`, when the app implements `verifyWebhook` | when the app implements `findShipment` | the app; adapter in `apps/api/src/plugins/providers/courier.ts` |

The merchant adds a courier under Settings, Shipping, Couriers. A courier app keeps its keys in its own settings. Its readiness and connection test come from the app. Every rule below applies to it too.

## Shared rules

- Courier credentials are dashboard data, never environment variables. They are encrypted with `CREDENTIAL_ENCRYPTION_KEY`. Rotating that key makes every saved credential unreadable, so re-enter each one.
- A courier works only when its row is active and its saved setup passed a live test. Editing a credential or setting clears the proof. A sandbox pass proves the request path only, not production approval.
- API credentials and the webhook secret are different. Save each in its own field.
- Retry a booking only after an explicit rejection. An unknown outcome keeps the order locked until the courier confirms or the merchant attests (delivery README).
- Never infer "not booked" from a 404, a failed lookup or an unknown status. Never attach an id without evidence that binds it to the original provider and order.
- Never log credentials, courier responses, buyer contact data, addresses or webhook bodies.

## Webhook verification

The webhook routes accept no session. `verifyDeliveryWebhook()` (`apps/api/src/middleware/webhook-auth.ts`) is the only authentication:

1. Exactly one active provider row of the courier type must exist. None, or more than one, fails closed with 401.
2. The row's credentials must be readable with `CREDENTIAL_ENCRYPTION_KEY`.
3. The secret is `credentials.webhookSecret`. When that key is absent (not empty), the API uses `credentials.secretKey` instead, so save a separate `webhookSecret`. Pathao sends it in the `X-PATHAO-Signature` header. Steadfast sends it as `Authorization: Bearer <secret>`. Both are compared in constant time.
4. Without a secret, the request IP (`CF-Connecting-IP`) must be in `config.allowedWebhookIps`.
5. Without a secret and without an allowlist, the request is rejected.

Each route then scopes the shipment lookup to the verified provider id and type, deduplicates the event in `webhook_events`, and runs the pipeline described in the delivery README.
