---
name: scalius-storefront
description: Act as a buyer on a Scalius store through its storefront tools. Use to check what shoppers see (product prices, availability, categories, navigation, pages), and to test a cart, delivery choice, discount, quote, checkout, receipt, customer sign-in or payment recovery the way a buyer would.
license: AGPL-3.0-only
---

# Scalius Storefront

Buyer tools need the storefront connection (`scalius init --storefront`; CLI `--surface storefront`). Never use merchant tools to act as a buyer. Recipes: [references/recipes.md](references/recipes.md). Reviewed buyer workflows: [references/workflows.md](references/workflows.md).

## Follow the buyer plan

1. `scalius_search` the buyer goal on the storefront tools; follow its plan.
2. Create or reuse one buyer context and keep its id and latest revision. Send that revision with every cart, discount and delivery change; on a conflict, reread.
3. Resolve an exact sellable SKU through catalog reads. The store computes prices, tax, discounts and availability; never send your own.
4. Choose delivery in the order the plan gives (place, then method). Get a fresh quote after any cart, discount or delivery change and show it before checkout.
5. Submit checkout once. Its idempotency key is reused only for the exact same checkout; read the status before any retry.
6. Verify the cart, quote, receipt or order through the same context, then close a context you no longer need.

## Truth and privacy

- Availability is a band the store reports, never an exact count.
- Customer sign-in, hosted payment and payment recovery are browser steps: hand the buyer the link the tool returns. Never copy OTPs, receipt proofs, cookies or payment details into chat, URLs or logs.
- Payment recovery is buyer-verified; never use or build a bearer recovery link.

Stop on a price, stock, revision, readiness or payment mismatch and report the store's state with the next safe step.
