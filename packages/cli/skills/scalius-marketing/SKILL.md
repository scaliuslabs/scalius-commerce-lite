---
name: scalius-marketing
description: Set up Scalius store tracking and marketing feeds. Use to connect Meta Pixel and the Conversions API (with a test event code), Google Analytics 4 or Tag Manager, TikTok Pixel and Cloudflare Web Analytics, check that events arrive, handle tracking consent, and review product feed health for Google and Meta.
license: AGPL-3.0-only
---

# Scalius Marketing

Follow the loop in `scalius`. Recipes: [references/recipes.md](references/recipes.md). Reviewed workflows: [references/workflows.md](references/workflows.md).

## Tracking scripts

- Each provider is one analytics entry (`dashboard.analytics.create`): created inactive, then switched on with `dashboard.analytics.set_active`. Ask for the real ID (Pixel ID, `G-` measurement ID, TikTok code); never enter a placeholder.
- Cloudflare Web Analytics takes the real token or the official beacon snippet; the store rewrites it into its own beacon.
- `dashboard.analytics.health` reports readiness without calling the providers.

## Meta Conversions API

- `dashboard.meta_conversions.update` stores the Pixel ID, access token and an optional test event code at the current revision. The token is a secret: the merchant pastes it, and you never repeat it.
- Prove it with `dashboard.meta_conversions.logs_list` after a storefront visit, and with the test event code in Meta Events Manager. Remove the test code when the merchant is done testing.
- Browser and server events share one event id, so Meta counts them once.

## Consent

Tracking may need visitor consent in some markets (for example the EU). Search the store's tools for a consent setting and use it. If the store has none, say so plainly; never write consent code into a tracking snippet.

## Feeds

- `dashboard.seo.feed_diagnostics` explains why products are left out (no image, no positive price, sold out, excluded). `dashboard.seo.feed_row_preview` shows one product's exact rows.
- Feed facts come from the catalog; fix them there (`scalius-catalog`). Never invent brands, conditions or categories to fill a feed.
