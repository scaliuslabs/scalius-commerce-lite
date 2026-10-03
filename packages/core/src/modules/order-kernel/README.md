# Order Kernel

What every domain that changes an order shares. Payments, delivery,
notifications, promotions and fulfilment act on orders through this module,
and [`../orders`](../orders/README.md) builds the order workflows (dashboard
flows, the status lifecycle, buyer views, returns, invoices) on top of all of
them. It depends on no other domain.

Public entries: `index.ts` (the server API) and `browser.ts` (the state
machine; safe for the dashboard).

| File | Exports | Purpose |
|------|---------|---------|
| `state-machine.ts` | `canTransitionTo()`, `validateTransition()`, `getAvailableTransitions()` | Order, payment and fulfilment transitions (`@scalius/shared/order-state`), with the `ValidationError` a refused move throws |
| `shipment-claim.ts` | `assertNoActiveShipmentClaim()`, `hasActiveShipmentClaim()`, `noActiveShipmentClaimCondition()` | The lease a courier booking holds on the order row |
| `payment-session-guard.ts` | `assertNoActivePaymentSessionAttempt()`, `noActivePaymentSessionAttemptForOrderIdCondition()`, ... | While a hosted payment session is being set up (a claimed attempt whose lease has not expired), nothing else changes the order |
| `refund-attempt-guard.ts` | `assertNoActiveRefundAttempt()`, `noActiveRefundAttemptForOrderIdCondition()`, `findActiveRefundAttempt()`, `ACTIVE_REFUND_ATTEMPT_STATUSES`, ... | While a refund is in flight (an active attempt or a pending refund payment), nothing else changes the order |
| `app-facts.ts` | `buildAppDiscountFactInserts()`, `resolveOrderAppFacts()`, `listOrderAppFacts()`, `recordAppRiskChecks()`, ... | What apps did to an order, kept as immutable `order_events` rows: app discounts (written in the checkout commit) and advisory risk checks |

The three locks are checked together by every order writer: the status
lifecycle, archive, courier bookings and tracking, payment application,
refunds and fulfilment. Each has an assert (a friendly refusal before work)
and a SQL condition (the guard inside the write batch, so a lock taken after
the read still rolls the batch back).
