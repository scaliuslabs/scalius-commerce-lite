# Storefront

Batched D1 queries for the public storefront API. Shapes data for the storefront app.

## Files

- `storefront.service.ts` -- `getHomepageData()` (SEO, hero, widgets, collections), `getLayoutData()` (analytics, header/footer, nav, currency, theme)

## Dependencies

- `@scalius/database` -- `siteSettings`, `products`, `categories`, `collections`, `widgets`, `heroSliders`, `analytics`, `pages`, `settings`
- `@scalius/core/integrations/analytics` -- Partytown script processing
