---
name: scalius-insights
description: Answer Scalius store questions with real numbers. Use for sales and orders today or over a period, unfulfilled or unpaid queues, low or out-of-stock products, customer history, reports, CSV exports, checkout health, and "what is left to set up". Read-only; changes go to the other scalius-* skills.
license: AGPL-3.0-only
---

# Scalius Insights

Read-only. Use the dashboard tools; never a storefront read to measure the business.

## Answer in the fewest calls

1. `scalius_answer` with the merchant's question. It returns a curated, bounded answer or the closest operations.
2. Otherwise follow [references/recipes.md](references/recipes.md) or `scalius_search` the question, then `scalius_read` the chosen operation.
3. Trim with `select` pointers; page with `meta.nextCursor`. In a shell, `scalius read <id> --all` streams every row as NDJSON and `scalius export <kind> --out file.csv` saves a CSV.

The reviewed reports and their steps: [references/workflows.md](references/workflows.md).

## Report the truth

- Days are the store's calendar in its time zone (`scalius://store` has `timeZone`). Keep the date the store returns for "today"; do not convert it to your own clock.
- Say the period and currency. Keep counts, booked revenue, collected cash and refunds apart; never relabel one as another.
- Use totals the store computes (`meta.total`, report aggregates). Never add up or rank a partial page as if it were complete.
- Stock bands and queue states are the store's words: "low", "out", "unfulfilled", "cod_to_collect". Do not invent thresholds.
- Keep samples small. Leave out buyer names, phones, emails and addresses unless the merchant asked about one customer.
- An unavailable, unauthorized or contradictory read is reported as a gap, never estimated.

## Launch gaps

"What is left to set up?": read `scalius://store` (`notSetUp`), then `dashboard.checkout.readiness_get` for what blocks checkout. Name each gap with the skill that fixes it (payments and delivery: `scalius-settings`).
