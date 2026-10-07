# Delivery providers

Courier reference for operators who connect a courier and contributors who change a courier: settings, calls, status maps, webhooks and test steps. Runtime behavior (readiness, booking, unknown outcomes, status sync) is owned by the [delivery domain README](../../packages/core/src/modules/delivery/README.md).

Every courier is an app's provider (`<plugin id>:<provider id>`). Core has no courier of its own. Pathao and Steadfast are providers of the Bangladesh pack (`plugins/bangladesh`, `scalius.bangladesh`).

| Courier | `type` | Auth | Webhook callback | Lookup by order id | Reference |
|---------|--------|------|------------------|--------------------|-----------|
| Pathao | `scalius.bangladesh:pathao` | OAuth password grant | `/api/v1/webhooks/couriers/scalius.bangladesh:pathao`, or the old `/api/v1/webhooks/pathao` | none | [pathao.md](pathao.md) |
| Steadfast | `scalius.bangladesh:steadfast` | `Api-Key` and `Secret-Key` headers | `/api/v1/webhooks/couriers/scalius.bangladesh:steadfast`, or the old `/api/v1/webhooks/steadfast` | by invoice | [steadfast.md](steadfast.md) |
| Another courier app | `<plugin id>:<provider id>` | the app's own settings | `/api/v1/webhooks/couriers/{id}`, when the app implements `verifyWebhook` | when the app implements `findShipment` | the app |

The merchant adds a courier under Settings, Shipping, Couriers. The courier's keys and options are in its app's settings (Apps, the app's page). Its readiness, mark and connection test come from the app. The adapter that runs an app courier is `apps/api/src/plugins/providers/courier.ts`.

## Shared rules

- Courier keys are dashboard data, never environment variables. The app's settings seal secrets with `CREDENTIAL_ENCRYPTION_KEY`. Rotating that key makes every saved secret unreadable, so enter each one again.
- A courier books only when its row is on and its app is active, approved for the courier port and set up (each key set, readable and not a placeholder).
- API keys and the webhook secret are different. Save each in its own setting.
- Retry a booking only after an explicit rejection. An unknown outcome keeps the order locked until the courier confirms or the merchant attests (delivery README).
- Never infer "not booked" from a 404, a failed lookup or an unknown status. Never attach an id without evidence that binds it to the original provider and order.
- Never log credentials, courier responses, buyer contact data, addresses or webhook bodies.

## Webhooks

`apps/api/src/routes/webhooks/couriers.ts` serves every courier push. It accepts no session; the app's `verifyWebhook` is the authentication:

1. Exactly one active delivery provider row of the courier must exist. None, or more than one, answers 401.
2. The app's settings must be readable. Otherwise 503.
3. The app checks the push (Pathao's `X-PATHAO-Signature`, Steadfast's `Authorization: Bearer`, compared in constant time). A failed check answers 401. A missing secret answers 503, so the courier sends the push again after the merchant saves one.
4. The platform finds the shipment by its booking id, scoped to the row and the courier. With the order number the courier echoes, it refuses a booking of another order and binds a booking that a lookup confirmed but whose id it never learned.
5. It claims the push once in `webhook_events` (`courier.<status>`, `courier.note`), applies it through the shared pipeline (delivery README) and answers what the courier expects (the app's `reply`: Pathao's 202 and secret header, Steadfast's JSON).

The old URLs `/api/v1/webhooks/pathao` and `/api/v1/webhooks/steadfast` are internal forwards to the same handler for `scalius.bangladesh:pathao` and `scalius.bangladesh:steadfast`. Merchants keep the URL they gave the courier. Until the Bangladesh pack is active, they answer 503 with "Activate Bangladesh pack in Apps to use it." (the courier retries).

## Before the pack

A store that set up Pathao or Steadfast in core keeps it. Until the Bangladesh pack is active, a row of type `pathao` or `steadfast` reads as blocked with "Activate Bangladesh pack in Apps to use it.", books and tracks nothing, and its shipments stay readable (their tracking pages come from `packages/core/src/integrations/retired-providers.ts`). Activation moves the saved keys into the pack's settings and repoints the rows and shipments ([pack README](../../plugins/bangladesh/README.md)).
