# Stable Release Checklist

Last reviewed: 2026-07-06

Use this file before claiming the platform is ready for a stable merchant-facing release. The tracker is the source of truth for defects; this checklist is the release gate.

## Non-Negotiable Gates

- No open P0/P1 item in `audit/REMEDIATION_TRACKER.md` for checkout, auth, payments, orders, inventory, notifications, cache freshness, product/variant management, first-admin setup, or dashboard/storefront runtime.
- Current branch has passed root `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm check:env`, `pnpm check:dist-secrets`, database migration metadata checks, frozen install, dependency audit, peer checks, and `git diff --check`.
- Current branch has passed `pnpm release:check` as the compact read-only production release smoke. Use `--skip-wrangler` only when Cloudflare auth is unavailable and record that limitation.
- Current branch has passed local buyer and merchant smokes for admin login/setup, product create/edit, cart, checkout, order success/receipt, customer auth/profile completion, order detail, notifications, and settings saves.
- Current branch has been deployed through the normal Cloudflare path and live read-only smokes pass for API health/readyz, OpenAPI, dashboard login/critical routes, storefront home/search/product/category/cart/checkout, queues/ops check, and discovery XML.
- Dummy or unreadable provider credentials fail closed with clear dashboard copy, no hot retry loops, no raw provider dumps, no noisy queue churn, and no runaway compute.
- Cache invalidation evidence shows scoped API KV invalidation plus storefront purge/warm for affected content, not accidental global purge behavior.

## SEO, Feed, AEO, And AIO Gate

Treat "AIO" as crawlable, trustworthy commerce data for search and assistants, not as a magic markup layer.

- `/robots.txt`, `/sitemap.xml`, `/sitemap-static.xml`, `/sitemap-products.xml`, `/sitemap-categories.xml`, `/sitemap-collections.xml`, `/sitemap-pages.xml`, canonical `/api/product-feed.xml?limit=5`, and compatibility `/api/facebook-feed.xml?limit=5` return valid XML/text with absolute URLs and production-safe cache headers.
- Static sitemap-advertised URLs have canonical URLs; search/listing query, sort, filter, and paginated variants must be canonicalized or noindexed with follow.
- Product feed availability, Product JSON-LD availability, storefront availability UI, and checkout validation are all derived from buyer-resolvable SKU truth.
- Feed items must have absolute `http(s)` primary images, non-empty plain descriptions, valid price/currency, SKU-aware availability, and no invalid zero-price fallback unless the catalog policy explicitly supports it.
- Dashboard SEO controls must remain the source of truth for sitemap sections, robots sitemap advertising, product-feed exposure, sold-out inclusion, feed title/description, and schema-family toggles.
- Public schema should match real merchant content: Organization/WebSite/SearchAction, Product/Offer, BreadcrumbList, CollectionPage/category pages. Add richer contact, address, shipping, return policy, FAQ, or ProductGroup/variant schema only when the admin has real fields and tests proving the public output stays accurate.

Primary references for future changes:

- Google Product structured data and variants/ProductGroup: https://developers.google.com/search/docs/appearance/structured-data/product and https://developers.google.com/search/docs/appearance/structured-data/product-variants
- Google Merchant product data specification: https://support.google.com/merchants/answer/7052112
- Google canonical and noindex guidance: https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls and https://developers.google.com/search/docs/crawling-indexing/block-indexing
- Google generative AI Search guidance: https://developers.google.com/search/docs/fundamentals/ai-optimization-guide

## Known P2 Release Follow-Ups

- `SEO-011`: per-resource canonical/noindex/sitemap/feed overrides, aggregate Merchant skipped-item diagnostics, richer organization/contact/shipping/return policy schema, and FAQ/AEO controls.
- SEO dashboard live probes now cover `robots.txt`, the sitemap index, canonical product feed, and compatibility Facebook feed from the saved Store URL. Remaining SEO dashboard work is aggregate skipped-item reason counts and per-resource overrides, not basic live discovery reachability.
- Feed diagnostics: `/api/product-feed.xml` now paginates the final flattened feed rows so skipped products and variant expansion cannot drop rows, but dashboard skipped-item counts/reasons are still preview-only. Add live skipped-item diagnostics before calling Merchant Center readiness perfect.
- `ANALYTICS-003`: provider health/test-send UX, TikTok Events API/server-side adapter, and broader server-side attribution.
- `OPS-005`/ops alerting: routed email/notification alerts for production ops signals.
- Broad admin performance hardening remains ongoing under `PERF-003`; do not let it block a stable release unless a concrete route regresses or stalls.
