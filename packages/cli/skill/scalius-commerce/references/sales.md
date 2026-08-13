# Sales and customers

- Search bounded summaries before loading a specific customer, order, return, or payment.
- Treat order/payment/refund/fulfillment revisions and idempotency keys as authoritative. Reuse the same key only for an exact replay; reject changed input under one key.
- Distinguish buyer intent from merchant action: storefront support requests ask for cancellation/return/refund; dashboard operations approve, receive, fulfill, refund, or reject according to current state.
- Preview discounts/promotions against the production evaluator before activation when available.
- Save CSV/HTML/PDF artifacts directly with CLI `--save`; MCP returns a one-use authenticated resource link.
- Provider payments and recovery may require a hosted continuation. Never expose card data, OTPs, receipt proofs, provider payloads, or customer session tokens.
- Verify financial state through order/payment/refund reads and preserve request IDs.
