---
name: scalius-commerce
description: Operate a Scalius Commerce store through its dashboard MCP, storefront MCP, or `scalius` CLI. Use for catalog, products, media, inventory, content, customers, orders, payments, analytics, settings, staff/security, storefront browsing, carts, checkout, recovery, artifacts, and any workflow that must discover and execute the live store contract safely.
---

# Scalius Commerce

Treat the store's live operation contract as authority. Do not invent routes, headers, IDs, fields, defaults, or database commands.

This is a portable Agent Skill, not harness-specific prompting. If the two Scalius MCP servers are unavailable, read [references/setup.md](references/setup.md), run `scalius setup --harness <name> --server <api-origin>`, and follow its credential-free native setup instructions.

## Fast answers

For a read-only merchant question, prefer one bounded answer operation over broad discovery:

- Sales, revenue, order count, and new customers by day: `dashboard.home.activity`; current summary and recent orders: `dashboard.home.summary`.
- Orders needing attention: `dashboard.orders.list` with the smallest relevant lifecycle, payment, or fulfillment filter.
- Stock issues: `dashboard.inventory_alerts.list`; inventory status or movements: `dashboard.inventory.list`.
- Product/catalog counts: `dashboard.products.stats`; customer lookup: `dashboard.customers.list`.
- Payment issues: `dashboard.orders.payment_recovery_list`; store health: `dashboard.checkout.readiness_get`; analytics health: `dashboard.analytics.health`.

Treat every date-only filter and daily/monthly metric as the merchant calendar in `Asia/Dhaka`. Absolute API timestamps remain UTC instants; do not relabel an activity row by parsing its `YYYY-MM-DD` key in the agent host's local timezone. For “today” or “yesterday,” select the corresponding `dashboard.home.activity` row by that merchant date key; do not infer the day from the agent machine's timezone.

Use the dashboard MCP for merchant/admin questions and the storefront MCP for buyer, catalog-browsing, cart, checkout, and customer-account questions. The CLI selects the matching authenticated audience from an operation ID; for discovery, use `scalius ops search "<natural merchant question>" --surface dashboard|storefront`. If the known operation is unavailable to the live grant, search and describe—never bypass authorization.

Answer with the requested period and currency plus 3–8 useful facts. State whether a metric is a count, gross amount, net amount, or recovery queue. Never total a partial page; use an aggregate operation or paginate its declared bounded result. Do not describe a known read operation again unless its live contract changed or exact filters are unclear.

## Operating loop

1. For an uncommon task, search with task words or a natural merchant question. In CLI use `scalius ops search "orders needing fulfillment" --surface dashboard`; in MCP use `operations.search` with the same phrase.
2. Describe only the likely operation. The default MCP description is compact; request `full=true` only when ready to construct the exact input. Do not load unrelated schemas.
3. Read its risk, RBAC, revision, idempotency, batch, byte, artifact, upload, and continuation policy.
4. Resolve human names with the domain's bounded summary/form operation before constructing input.
5. Execute through either MCP or CLI. They expose the same reviewed merchant outcomes: MCP returns authenticated artifact links and public-URL media imports, while capable local hosts may additionally stream private files or save artifacts directly.
6. Verify the outcome with a bounded read. For writes, verify revision/state; for artifacts, verify byte count and digest when supplied.
7. Preserve request IDs and report intentional exclusions rather than attempting hidden routes.

If a store was just upgraded and a described schema looks stale, run `scalius ops refresh --surface dashboard|storefront` once, then describe the operation again. Do not compensate for a stale contract by guessing fields or units.

CLI JSON input is always `{ "path": {...}, "query": {...}, "body": ... }`. Pass `--yes` for writes. Pass `--idempotency-key` only when the described policy is `supported` or `required`. On a revision conflict, reread current state and reconcile; never blindly retry stale input.

Use `operations.batch` only for independent reads or an explicitly sequential reviewed workflow. Keep financial, destructive, continuation, upload, and artifact actions out of speculative batches.

Never treat the CLI as a prerequisite for an MCP workflow. If an outcome appears in only one interface, first search and describe the live contract again; if it is genuinely unavailable, report a parity defect instead of inventing a direct HTTP workaround. Local filesystem access is a client capability, not a commerce capability: use public-URL import or an authenticated resource link when the MCP host cannot read or write local files.

## Choose the relevant guide

- Product, category, attribute, variants, inventory, and media work: read [references/catalog-media.md](references/catalog-media.md).
- Pages, articles, navigation, hero, theme, and discovery content: read [references/content.md](references/content.md).
- Customers, discounts, promotions, orders, fulfillment, returns, refunds, and payments: read [references/sales.md](references/sales.md).
- Business, checkout, tax, delivery, providers, analytics, team, security, and other settings: read [references/settings.md](references/settings.md).
- Public catalog, cart, checkout, customer account, receipt, payment, and recovery: read [references/storefront.md](references/storefront.md).

Load only the one relevant reference. If a described live schema conflicts with a reference, follow the live schema and report the drift.

## Security boundaries

Never place credentials, OTPs, receipt proofs, payment secrets, continuation codes, or customer PII in URLs, logs, command arguments, or saved workflow files. Let reviewed continuations open their fixed browser handoff. Never turn a concrete exclusion into a direct HTTP call. Never broaden an operation's audience, RBAC, risk ceiling, or resource surface.
