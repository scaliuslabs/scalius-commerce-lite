---
name: scalius-sales
description: Run Scalius orders and customers. Use to find, create (including cash on delivery), fulfil, ship with a courier, cancel, return or refund orders; issue invoices; create, preview or pause discount codes and automatic discounts; tag or segment customers; and handle gift cards, reviews and inbox replies where the store allows.
license: AGPL-3.0-only
---

# Scalius Sales

Follow the loop in `scalius`. Recipes for the common tasks: [references/recipes.md](references/recipes.md). Reviewed workflows: [references/workflows.md](references/workflows.md).

## Find the exact record

Order numbers and names are not ids. Search (`dashboard.orders.list` `search`, `dashboard.resources.customers.list`), and when more than one matches, ask. Read the order before changing it: its status, version, lines and payments.

## Money and approval

- Refunds, cancellations, deletions and other destructive or financial steps need the merchant's approval: dry run, show `confirmation.summary`, then send the `confirmToken`. Never approve for them, and never refund more than `dashboard.orders.payments` says is refundable.
- If a refund or capture answer is lost, read the payments again (or `dashboard.orders.refund_reconcile`) before anything else. Never send a second refund to be safe.
- Amounts are major units (500 = 500 BDT) unless the field ends in `Minor` (`amountMinor`, `shippingMinor`), which is the smallest unit (500 BDT = 50000).
- The tools add an idempotency key to every write that takes one; a retry with the same key cannot double-charge.

## Orders

- Cancel with `dashboard.orders.update_status` (status `cancelled`, a reason); this releases reserved stock. A paid order also needs a refund.
- A return is created, approved, then received; receiving puts the units back in stock.
- Courier booking (`dashboard.orders.create_shipment`) needs the provider id from `dashboard.delivery_providers.list`; own-rider handover is `dashboard.orders.fulfillment_create`.
- Orders need a phone unless the store's rules say otherwise; Bangladesh, delivery and cash-on-delivery orders always need one.

## Discounts

Create as a draft, preview it against a cart, then activate. Start and end are epoch seconds plus the store's time zone; minimums are `amountMinor`. Ask before changing a live discount.

## Customers, reviews, inbox, gift cards

Bulk tags go through a segment or a filter, never a hand-typed list of hundreds of ids. Replies to buyers and review answers are the merchant's words: draft them and get approval. Where a tool says the store keeps something staff-only, say so and stop.

Never put buyer phones, emails, addresses or payment details into URLs, logs or summaries beyond what the task needs.
