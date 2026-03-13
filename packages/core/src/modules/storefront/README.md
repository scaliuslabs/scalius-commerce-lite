# Storefront

Data query and shaping functions for the public storefront API. Performs batched D1 queries and normalizes data for the storefront app.

## Exports

- `getHomepageData()` — fetches SEO, hero sliders, widgets, and collections with their products in two batched D1 round-trips
- `getLayoutData()` — fetches analytics scripts, header/footer config, navigation, currency, and theme in a single batched round-trip

## Dependencies

- `@scalius/database` — `siteSettings`, `products`, `categories`, `collections`, `widgets`, `heroSliders`, `analytics`, `pages`, `settings` tables
- `@scalius/core/integrations/analytics` — Partytown script processing

## API Routes

- `GET /api/v1/storefront/homepage` — homepage data (SEO, hero, widgets, collections)
- `GET /api/v1/storefront/layout` — layout data (header, footer, navigation, currency, theme)
