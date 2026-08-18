---
name: scalius-sales
description: Operate Scalius sales and customer lifecycles safely. Use for orders, customer lookup and history, discounts and promotions, fulfillment and shipments, cancellations, returns, refunds, payment status and capture, failed-payment recovery, and related entity actions.
---

# Scalius Sales

Use the dashboard audience for merchant actions. Keep buyer requests on the storefront audience; never use dashboard authority to impersonate a customer.

## Use the reviewed plan

1. For a supported read-only question, call MCP `workflows.read` first or run `scalius workflow read "<question>" --surface dashboard`.
2. If unavailable or when changing state, call `workflows.resolve`; with CLI, use `scalius workflow resolve`. Use its ordered IDs and rules instead of hardcoding an operation list.
3. Describe only selected IDs that need an exact schema. Never use the removed MCP operation-search tool, open repository contract artifacts, or invent customer, order, shipment, return, or payment IDs.
4. Execute bounded reads with `operations.read`; execute confirmed writes with `operations.write` in plan order. Keep financial, continuation, and recovery work out of speculative parallel batches.
5. Reread the exact order/customer/fulfillment/payment state and verify the requested outcome.

## Preserve sales authority

- Resolve one exact target through a bounded list before loading or changing it. Paginate when needed; never treat a partial page as complete.
- Read the current state and revision before fulfillment, cancellation, return, refund, promotion, or payment writes. On conflict, reread and reconcile; never retry stale input blindly.
- Supply an idempotency key only when the selected operation supports or requires it. Reuse it only for an exact replay; use a new key when any material input changes.
- Confirm financial actions explicitly. If provider output is lost or uncertain, reread local payment/refund state and use only the reviewed recovery or reconciliation path; never issue a second capture or refund speculatively.
- Distinguish merchant/manual fulfillment from saved-provider shipment creation. Verify resulting fulfillment and shipment state.
- Treat buyer support requests as intent, not merchant approval. Follow the returned state machine for cancellation, return, receipt, and refund decisions.
- Keep customer PII, card data, OTPs, receipt proofs, provider payloads, credentials, and continuation fields out of URLs, logs, command arguments, and saved plans. Follow only fixed body-only browser handoffs.

Stop on authorization, revision, provider, or state mismatch and report the request ID plus safe status.
