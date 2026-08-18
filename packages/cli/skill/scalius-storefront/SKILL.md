---
name: scalius-storefront
description: Complete Scalius buyer journeys through the storefront audience. Use for public catalog search and product availability, categories and collections, cart creation and edits, delivery and discounts, quotes and checkout, customer account login, profile, and orders, receipts, hosted payment, payment status, and buyer-verified payment recovery.
---

# Scalius Storefront

Use only the storefront audience. Keep dashboard credentials separate and never use merchant authority to impersonate a visitor or customer.

## Follow the buyer plan

1. For a supported read-only buyer question, call MCP `workflows.read` first or run `scalius workflow read "<question>" --surface storefront`.
2. If unavailable or for cart, checkout, account, receipt, or recovery work, call `workflows.resolve`; with CLI, use `scalius workflow resolve`. Follow the returned ordered plan without hardcoding operation IDs.
3. Describe only selected IDs that require exact schema. Never use the removed MCP operation-search tool, open repository contract artifacts, or invent context, variant, delivery, order, or receipt IDs.
4. Execute bounded reads with `operations.read` and confirmed state changes with `operations.write`; use batching only when the reviewed plan declares independent or referenced-safe steps.
5. Verify the resulting cart, quote, receipt/order, account, or payment state through the same storefront context.

## Preserve context and checkout truth

- Create or reuse the reviewed storefront context and keep its ID and current revision in memory. Pass the latest returned revision to every cart, discount, and delivery change; on conflict, reread instead of guessing.
- Resolve an exact sellable variant through bounded catalog reads. Never submit client prices, exact stock claims, tax, discount totals, or availability as authority.
- Resolve delivery geography and method in declared order. Request and review a fresh quote after cart, discount, or delivery changes.
- Confirm the final quote and submit checkout once with one canonical idempotency key. Reuse that key only for the exact same checkout input; reread status before any uncertain retry.
- Keep visitor reads separate from customer-bound profile/order reads. Use only the live customer context and close disposable contexts when finished.
- Never expose customer PII, cookies, OTPs, receipt proofs, payment secrets, provider payloads, or continuation fields in model output, URLs, logs, arguments, or saved plans. Follow fixed body-only login, hosted-payment, and recovery continuations.
- Use buyer-verified payment recovery rather than bearer recovery links. Verify payment and receipt/order state after the handoff without copying proof material.

Stop on price, stock, revision, readiness, identity, or payment mismatch; return the safe state and next reviewed action.
