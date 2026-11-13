# Delivery providers

Every courier is an app's provider (`<plugin id>:<provider id>`); core has no courier of its own. Pathao
and Steadfast are providers of the Bangladesh pack (`plugins/bangladesh`, code
`plugins/bangladesh/src/couriers.ts`, status maps `mapPathaoStatus` / `mapSteadfastStatus` there). A
merchant adds a courier under Settings > Shipping > Couriers and enters its keys in the app's settings
(Apps, the app's page); readiness, the connection test and the booking form come from the app.

| Courier | Auth | Webhook callback | Lookup by order id |
|---------|------|------------------|--------------------|
| Pathao (`scalius.bangladesh:pathao`) | OAuth password grant; production `api-hermes.pathao.com` or sandbox `courier-api-sandbox.pathao.com` | `/api/v1/webhooks/couriers/scalius.bangladesh:pathao` (or the old `/api/v1/webhooks/pathao`), `X-PATHAO-Signature` | none |
| Steadfast (`scalius.bangladesh:steadfast`) | `Api-Key` and `Secret-Key` headers; production only, no sandbox | `/api/v1/webhooks/couriers/scalius.bangladesh:steadfast` (or the old `/api/v1/webhooks/steadfast`), `Authorization: Bearer` | by invoice |
| Another courier app | the app's own settings | `/api/v1/webhooks/couriers/{id}` when the app implements `verifyWebhook` | when the app implements `findShipment` |

## Rules

- Courier keys are dashboard data, never environment variables; the app's settings seal secrets with
  `CREDENTIAL_ENCRYPTION_KEY` (rotating it means entering every key again).
- API keys and the webhook secret are different values: Pathao's webhook secret is not its OAuth client
  secret. Without a webhook secret no push is accepted (503, so the courier retries after it is saved).
- A courier books only when its row is on and its app is active, approved for the courier port and set
  up (every key set, readable and not a placeholder).
- Retry a booking only after an explicit rejection. An unknown outcome keeps the order locked until the
  courier confirms or staff attest with evidence. Never infer "not booked" from a 404, a failed lookup or
  an unknown status, and never attach an id without evidence that binds it to the provider and the
  order.
- Never log credentials, courier responses, buyer contact data, addresses or webhook bodies.

## Webhooks

`apps/api/src/routes/webhooks/couriers.ts` serves every courier push; the app's `verifyWebhook` is the
authentication. Exactly one active provider row of the courier must exist (else 401); the app checks the
push in constant time (401 on failure, 503 without a saved secret); the platform finds the shipment by
its booking id scoped to the row, refuses a booking of another order, claims the push once in
`webhook_events`, applies it through the shared status pipeline (a refused transition is skipped and an
admin change wins a race) and answers what the courier expects.
