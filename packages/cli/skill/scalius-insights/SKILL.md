---
name: scalius-insights
description: Answer data-intensive Scalius merchant questions with bounded reviewed evidence. Use for sales, revenue, order, customer, product, and inventory metrics; daily or period comparisons; fulfillment, stock, return, refund, and payment queues; checkout, provider, analytics, feed, or operational readiness; diagnostics, exports, and reports.
---

# Scalius Insights

Use the dashboard audience for merchant evidence. Keep the storefront audience separate and use it only when a reviewed plan explicitly requires buyer-visible verification.

## Resolve the smallest read

1. For a supported data question, call MCP `workflows.read` first. With CLI, run `scalius workflow read "<question>" --surface dashboard`.
2. If unavailable or if the request needs unsupported analysis or a change, call `workflows.resolve`; with CLI, use `scalius workflow resolve`. Follow the returned compact plan without adding operation IDs.
3. Call `operations.describe` only for selected IDs whose exact input schema is still needed. Never use the removed MCP operation-search tool, open repository contract artifacts, or guess filters.
4. Execute reads with `operations.read` or an eligible bounded `operations.read_batch`. Verify material facts with the plan's bounded evidence read.

## Report truthful evidence

- Treat date-only and daily/monthly metrics as the merchant calendar in `Asia/Dhaka`. For “today,” preserve the returned merchant date key; do not reinterpret it in the agent host timezone. Treat absolute timestamps as UTC instants.
- State the requested period and currency. Distinguish counts, booked gross revenue, collected cash, net settlement, and queue size; never relabel one as another.
- Prefer authoritative aggregates. Paginate within declared bounds and never total or rank a partial page as though complete.
- Preserve returned queue filters and state. Distinguish all recovery work from only actionable failures, and distinguish saved/configured methods from active, usable checkout readiness.
- Keep samples small and operational. Exclude customer names, email, phone, addresses, receipt proofs, payment details, tokens, and provider payloads unless the reviewed projection explicitly permits a necessary safe field.
- Return artifact links through the reviewed delivery path; never print continuation fields or secret-bearing report URLs.

Stop on unavailable, unauthorized, stale, or contradictory evidence. Report the gap instead of estimating.
