# Sales and customers

- Search bounded summaries before loading a specific customer, order, return, or payment.
- For common reads, use exact minimal filters: open unfulfilled work is `dashboard.orders.list` with `statusGroup=open` and `fulfillmentStatus=pending`; top customers are `dashboard.customers.list` sorted by `totalSpent desc`; actionable payment failures are `dashboard.orders.payment_recovery_list` with `state=needs_attention`.
- Treat order/payment/refund/fulfillment revisions and idempotency keys as authoritative. Reuse the same key only for an exact replay; reject changed input under one key.
- Distinguish buyer intent from merchant action: storefront support requests ask for cancellation/return/refund; dashboard operations approve, receive, fulfill, refund, or reject according to current state.
- Choose the shipment authority before writing: use `dashboard.orders.fulfill` for manual/merchant fulfillment and `dashboard.orders.create_shipment` only for a saved delivery provider. Never pass `manual` as a provider ID. Before provider shipping, read `dashboard.delivery_providers.list` and require `canCreateShipment=true`; after either path, verify with `dashboard.orders.fulfillment_get` or `dashboard.orders.shipments`. Refresh is provider-only, reconciliation is for a recoverable provider lock, and hard deletion is limited to failed/cancelled attempts.
- Preview discounts/promotions against the production evaluator before activation when available.
- Save CSV/HTML/PDF artifacts directly with CLI `--save`; MCP returns a one-use authenticated resource link.
- Provider payments and recovery may require a hosted continuation. Never expose card data, OTPs, receipt proofs, provider payloads, or customer session tokens.
- Verify financial state through order/payment/refund reads and preserve request IDs.
