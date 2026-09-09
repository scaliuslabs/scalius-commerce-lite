# Delivery provider knowledge base

Last verified: **2026-09-09**

This folder records courier contracts and dated live observations that are useful when operating or changing Scalius delivery integrations. The runtime authority remains [`packages/core/src/modules/delivery`](../../packages/core/src/modules/delivery/README.md).

- [Pathao](pathao.md) — sandbox/production environments, OAuth, stores, locations, booking, status, and webhook behavior.
- [Steadfast](steadfast.md) — production API, API-key auth, invoice lookup limits, and portal webhook contract.

## Shared Scalius rules

- A provider is usable only when its saved credentials/config match a successful live test and the row is active. A friendly name such as “Demo” does not change the endpoint or make a production API a sandbox.
- API credentials and webhook authentication secrets are different authorities. Save and rotate each in its provider field; never substitute one for the other.
- Shipment creation is insert-first and order-claim guarded. Retry only after an explicit rejection. A timeout, malformed response, server error, or incomplete success identity is an unknown outcome and keeps the order locked until positive provider evidence or accountable merchant confirmation resolves it.
- Never infer absence from a 404, failed lookup, unknown status, or arbitrary consignment ID. Never attach an ID unless evidence binds it to the original provider and order.
- Provider failures must expose bounded status/field information only. Do not log credentials, raw provider responses, buyer contact data, addresses, or webhook bodies.

Owning code: [`delivery.service.ts`](../../packages/core/src/modules/delivery/delivery.service.ts), [`orders.fulfillment.ts`](../../packages/core/src/modules/orders/orders.fulfillment.ts), [`provider-readiness.ts`](../../packages/core/src/modules/delivery/provider-readiness.ts), and [`delivery.create-outcome.d1.test.ts`](../../packages/core/src/modules/delivery/delivery.create-outcome.d1.test.ts).
