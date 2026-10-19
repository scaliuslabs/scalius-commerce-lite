---
name: scalius
description: Connect an agent to a Scalius Commerce store and run merchant work through it. Use to set up or repair the connection ("connect my store", tool or login errors), to learn the safe tool loop, or when a request spans several store areas; it routes to the focused scalius-* skills.
license: AGPL-3.0-only
---

# Scalius

The store's live contract is the authority. Never invent ids, revisions, prices or fields, and never work around a tool (no direct HTTP or database).

## Connect once

`npx scalius@latest init --server https://<store-api>` asks for one browser approval, installs these skills, registers the `scalius` MCP server in every agent it finds and runs `scalius doctor`. When a tool fails to connect, run `scalius doctor`: it names the fix. Details: [references/setup.md](references/setup.md).

## The loop

1. A data question: `scalius_answer` (CLI `scalius ask "..."`). If unavailable, go on.
2. `scalius_search` the goal. Prefer a workflow hit and its plan; obey a control hit that asks or refuses.
3. `scalius_describe` only the ids you will call: inputs (`!` = required), rules, an example.
4. Read the facts: ids, current revision, amounts. Ask the merchant for anything missing.
5. `scalius_write` with `dryRun:true`. A destructive or financial change returns `confirmation.summary`: show it to the merchant as written and wait for a yes.
6. Write again with its `confirmToken` (CLI: `--yes` once they agree). Never approve for the merchant.
7. Verify with a read and say what changed.

Failures carry `code`, `hint`, `retryable` and, on a conflict, `current`: follow the hint, reread and retry once. Codes and exit codes: [references/troubleshooting.md](references/troubleshooting.md).

## Tools

MCP and CLI share five tools: `scalius_answer` = `scalius ask`, `scalius_search` = `scalius search`, `scalius_describe` = `scalius describe`, `scalius_read` = `scalius read`, `scalius_write` = `scalius write`. Money in these tools is decimal major units unless a field ends in `Minor`. Lists page with `meta.nextCursor`; trim large reads with `select` pointers. The CLI adds local files (`scalius media upload`), CSV files (`scalius export`), every page (`scalius read <id> --all`) and bulk changes (`scalius bulk`).

## Route

- Orders, refunds, returns, discounts, customers, gift cards, reviews, inbox: `scalius-sales`.
- Products, variants, prices, stock, media, collections: `scalius-catalog`.
- Pages, menus, theme, homepage, SEO: `scalius-content`.
- Checkout, payments, delivery, tax, staff, markets, apps: `scalius-settings`.
- Pixels, Conversions API, GA4, consent, feeds: `scalius-marketing`.
- Sales numbers, reports, low stock, exports, launch gaps: `scalius-insights`.
- What a buyer sees; buyer carts and checkout: `scalius-storefront`.

Load one focused skill, two only when the task truly spans both.
