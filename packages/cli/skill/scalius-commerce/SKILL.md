---
name: scalius-commerce
description: Set up or repair Scalius CLI and MCP connections and route work to focused Scalius skills. Use for harness installation, OAuth or audience problems, CLI/MCP capability parity, choosing dashboard versus storefront authority, or a request spanning several commerce domains. Use a focused scalius-* skill for normal store operations.
---

# Scalius Commerce

Treat the live finalized contract as authority. Never invent routes, fields, IDs, revisions, defaults, or direct database/HTTP workarounds.

## Connect

Read [references/setup.md](references/setup.md) for first-time setup, authentication, audience repair, or a missing tool. Do not place credentials in skill or MCP configuration.

## Route the task

Load only the focused skill that owns the request:

- Metrics, operational questions, queues, readiness, or reports: `$scalius-insights`.
- Products, variants, categories, attributes, media, inventory, feeds, or labels: `$scalius-catalog`.
- Pages, articles, navigation, header/footer/homepage, theme, SEO, or discovery: `$scalius-content`.
- Customers, orders, discounts, promotions, fulfillment, returns, refunds, invoices, or payments: `$scalius-sales`.
- Business behavior, checkout, tax, shipping, providers, analytics, staff, security, agent access, or account settings: `$scalius-settings`.
- Buyer catalog, context, cart, checkout, account, receipt, payment, or recovery: `$scalius-storefront`.

Load two focused skills only when the requested outcome genuinely crosses both domains. Do not load every skill preemptively.

## Universal tool loop

For a supported data question, try MCP `workflows.read` or CLI `scalius workflow read` first. If it returns unavailable, or the task changes state, call `workflows.resolve` or `scalius workflow resolve`. Follow the returned facts, rules, operation IDs, confirmation, and verification model. Describe only a selected operation whose exact input schema is still needed. Execute through the split read/write tools, then verify with bounded reads.

Do not use removed MCP operation search, dump the OpenAPI catalog into model context, inspect application source to reconstruct a workflow, or bypass an unavailable operation. Dashboard and storefront credentials are separate audiences; cross-audience verification requires the matching connection.
