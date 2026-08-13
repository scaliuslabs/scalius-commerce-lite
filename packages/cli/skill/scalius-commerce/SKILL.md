---
name: scalius-commerce
description: Operate a Scalius Commerce store through its dashboard MCP, storefront MCP, or `scalius` CLI. Use for catalog, products, media, inventory, content, customers, orders, payments, analytics, settings, staff/security, storefront browsing, carts, checkout, recovery, artifacts, and any workflow that must discover and execute the live store contract safely.
---

# Scalius Commerce

Treat the store's live operation contract as authority. Do not invent routes, headers, IDs, fields, defaults, or database commands.

This is a portable Agent Skill, not harness-specific prompting. If the two Scalius MCP servers are unavailable, read [references/setup.md](references/setup.md), run `scalius setup --harness <name> --server <api-origin>`, and follow its credential-free native setup instructions.

## Operating loop

1. Search with two or three task words. In CLI use `scalius ops search "create product"`; in MCP use `operations.search` with the same phrase.
2. Describe only the likely operation. The default MCP description is compact; request `full=true` only when ready to construct the exact input. Do not load unrelated schemas.
3. Read its risk, RBAC, revision, idempotency, batch, byte, artifact, upload, and continuation policy.
4. Resolve human names with the domain's bounded summary/form operation before constructing input.
5. Execute through MCP for JSON workflows. Use the CLI for local files and direct artifact saves.
6. Verify the outcome with a bounded read. For writes, verify revision/state; for artifacts, verify byte count and digest when supplied.
7. Preserve request IDs and report intentional exclusions rather than attempting hidden routes.

CLI JSON input is always `{ "path": {...}, "query": {...}, "body": ... }`. Pass `--yes` for writes. Pass `--idempotency-key` only when the described policy is `supported` or `required`. On a revision conflict, reread current state and reconcile; never blindly retry stale input.

Use `operations.batch` only for independent reads or an explicitly sequential reviewed workflow. Keep financial, destructive, continuation, upload, and artifact actions out of speculative batches.

## Choose the relevant guide

- Product, category, attribute, variants, inventory, and media work: read [references/catalog-media.md](references/catalog-media.md).
- Pages, articles, navigation, hero, theme, and discovery content: read [references/content.md](references/content.md).
- Customers, discounts, promotions, orders, fulfillment, returns, refunds, and payments: read [references/sales.md](references/sales.md).
- Business, checkout, tax, delivery, providers, analytics, team, security, and other settings: read [references/settings.md](references/settings.md).
- Public catalog, cart, checkout, customer account, receipt, payment, and recovery: read [references/storefront.md](references/storefront.md).

Load only the one relevant reference. If a described live schema conflicts with a reference, follow the live schema and report the drift.

## Security boundaries

Never place credentials, OTPs, receipt proofs, payment secrets, continuation codes, or customer PII in URLs, logs, command arguments, or saved workflow files. Let reviewed continuations open their fixed browser handoff. Never turn a concrete exclusion into a direct HTTP call. Never broaden an operation's audience, RBAC, risk ceiling, or resource surface.
