---
name: scalius-settings
description: Configure a Scalius store. Use to check whether checkout is ready, turn payment methods on or off (cash on delivery, Stripe, SSLCommerz), set delivery zones and fees, couriers, VAT and tax rates, markets and currencies, store details and defaults, staff and roles, webhooks, apps and agent access.
license: AGPL-3.0-only
---

# Scalius Settings

Follow the loop in `scalius`. Recipes: [references/recipes.md](references/recipes.md). Reviewed workflows: [references/workflows.md](references/workflows.md).

## Change only what was asked

- Read the current settings and revision first. Many settings are saved whole (payment methods, checkout flow, a shipping zone): send every existing value back with only the requested change, at the revision you read.
- On a conflict, reread and reapply; never overwrite newer settings.
- After a change, read `dashboard.checkout.readiness_get` (and the setting) to prove it works. A saved row is not proof that checkout accepts it.

## Payments

- Cash on delivery is Bangladesh-only by its own rule; payment methods declare their countries. Enabling COD needs nothing beyond adding it to the enabled methods.
- Provider credentials are secrets: the merchant pastes them; never echo, log or guess them, and treat placeholder text as not configured.

## Delivery and tax

- One matching rule for both: Bangladesh place, then postal prefix, then admin area, then country. No matching zone means no delivery; no tax region means no tax.
- Every delivery rate belongs to a zone; only local pickup is store-wide.
- Tax rates are basis points (5% = 500). Whether prices include tax is a market setting. Preview a sample order before telling the merchant it is done.

## Staff and security

Invites, roles, sessions and agent grants are security changes: name the exact person and permissions, confirm with the merchant, and never grant more than asked. Prefer an existing role that fits.

## Apps

Installing is allowed; activating a third-party app or a feature it adds needs the merchant in the browser. When a tool returns a browser step, give the merchant that link.
