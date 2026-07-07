# Stable Release Checklist

Last reviewed: 2026-07-07

Use this file before claiming the platform is ready for a stable merchant-facing release. The tracker is the source of truth for defects; this checklist is the release gate.

## Non-Negotiable Gates

- No open P0/P1 item in `audit/REMEDIATION_TRACKER.md` for checkout, auth, payments, orders, inventory, notifications, cache freshness, product/variant management, first-admin setup, or dashboard/storefront runtime.
- Current branch has passed root `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm check:env`, `pnpm check:dist-secrets`, database migration metadata checks, frozen install, dependency audit, peer checks, and `git diff --check`.
- Current branch has passed `pnpm release:check` as the compact read-only production release smoke, including homepage global JSON-LD proof plus UCP profile/search/lookup/product coverage. Use `--skip-wrangler` only when Cloudflare auth is unavailable and record that limitation.
- Current branch has passed local buyer and merchant smokes for admin login/setup, product create/edit, cart, checkout, order success/receipt, customer auth/profile completion, order detail, notifications, and settings saves.
- Current branch has been deployed through the normal Cloudflare path and live read-only smokes pass for API health/readyz, OpenAPI, dashboard login/critical routes, storefront home/search/product/category/cart/checkout, queues/ops check, and discovery XML.
- Dummy or unreadable provider credentials fail closed with clear dashboard copy, no hot retry loops, no raw provider dumps, no noisy queue churn, and no runaway compute.
- Cache invalidation evidence shows scoped API KV invalidation plus storefront purge/warm for affected content, not accidental global purge behavior.

## SEO, Feed, AEO, And AIO Gate

Treat "AIO" as crawlable, trustworthy commerce data for search and assistants, not as a magic markup layer.
Official Google Search/Merchant guidance was rechecked on 2026-07-07: Product structured data still recommends combining merchant-listing JSON-LD with Merchant feeds, ProductGroup remains the current variant model, and Google generative-AI search guidance still depends on crawlable, useful, well-structured human-facing content.

- `/robots.txt`, `/sitemap.xml`, `/sitemap-static.xml`, `/sitemap-products.xml`, `/sitemap-categories.xml`, `/sitemap-collections.xml`, `/sitemap-pages.xml`, canonical `/api/product-feed.xml?limit=5`, and compatibility `/api/facebook-feed.xml?limit=5` return valid XML/text with absolute URLs and production-safe cache headers. The canonical feed must use Google/Base availability values (`in_stock`/`out_of_stock`); the compatibility feed must keep Meta-style values (`in stock`/`out of stock`).
- Static sitemap-advertised URLs have canonical URLs; search/listing query, sort, filter, and paginated variants must be canonicalized or noindexed with follow.
- Product feed availability, Product JSON-LD availability, storefront availability UI, and checkout validation are all derived from buyer-resolvable SKU truth.
- Feed items must have absolute `http(s)` primary images, non-empty plain descriptions, valid price/currency, SKU-aware availability, and no invalid zero-price fallback unless the catalog policy explicitly supports it.
- Dashboard SEO controls must remain the source of truth for sitemap sections, robots sitemap advertising, product-feed exposure, sold-out inclusion, feed title/description, schema-family toggles, product-level sitemap/feed XML exclusions, and product/category/collection/page `noindex`, sitemap-exclusion, plus route-shaped same-store canonical path controls. Collection canonical paths must follow the current ID-routed `/collections/<collectionId>` route until collection slugs or aliases exist.
- Resource `noindex` means public-but-not-indexed: page renders `noindex,follow`, sitemap XML excludes it, and resource-specific JSON-LD is suppressed. Sitemap exclusion alone is XML-only and must not hide or noindex the page.
- Public schema should match real merchant content: OnlineStore/Organization, WebSite/SearchAction, MerchantReturnPolicy, Product/Offer, BreadcrumbList, ProductGroup, CollectionPage/category pages. `pnpm release:check` must fail malformed emitted homepage schema, but absence is valid when the merchant has not configured prerequisites such as business identity, logo, or return policy. Do not invent Product/Offer facts such as price expiry, item condition, seller, or brand when the merchant has not provided that data. Add richer contact, address, shipping, FAQ, or ProductGroup/variant schema only when the admin has real fields and tests proving the public output stays accurate.

Primary references for future changes:

- Google Product structured data and variants/ProductGroup: https://developers.google.com/search/docs/appearance/structured-data/product and https://developers.google.com/search/docs/appearance/structured-data/product-variants
- Google Merchant product data specification: https://support.google.com/merchants/answer/7052112
- Google canonical and noindex guidance: https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls and https://developers.google.com/search/docs/crawling-indexing/block-indexing
- Google generative AI Search guidance: https://developers.google.com/search/docs/fundamentals/ai-optimization-guide

## Known P2 Release Follow-Ups

- `SEO-011`: remaining structured-data preview UX and richer FAQ/AEO controls where dashboard-owned data exists; emitted homepage/global schema and feed XML essentials are now covered by release/dashboard proof.
- `SEO-026`: before Google Merchant's announced January 31, 2027 enforcement date, feed diagnostics should verify that primary catalog images meet the 500x500 minimum when dimensions are known or can be derived from first-party media metadata.
- SEO dashboard live probes now cover `robots.txt`, the sitemap index, every enabled child sitemap, canonical product feed, and compatibility Facebook feed from the saved Store URL. Feed proof must warn on non-empty feeds missing per-item link, `image_link`, or availability, and must flag non-absolute product/image links instead of reporting green from HTTP 200 alone. The dashboard also has bounded aggregate product-feed diagnostics for emitted rows, skipped rows, reason counts, and safe product samples.
- Feed diagnostics: `/api/product-feed.xml` paginates the final flattened feed rows so skipped products and variant expansion cannot drop rows, while admin diagnostics explain which bounded catalog rows are skipped and why.
- `UCP-001`/`UCP-002`/`UCP-004`: read-only catalog discovery is present without checkout/cart/order/payment advertisement, and `pnpm release:check` now verifies the HTTPS catalog-only profile plus opportunistic search, lookup correlation, and product-detail first-variant behavior. Remaining UCP work is a P2/P1 roadmap item for dashboard control, D1-backed sessions, idempotency, signing/profile verification, and supported payment completion.
- `ANALYTICS-003`: provider health/test-send UX, TikTok Events API/server-side adapter, and broader server-side attribution.
- `OPS-005`/ops alerting: routed email/notification alerts for production ops signals.
- Broad admin performance hardening remains ongoing under `PERF-003`; do not let it block a stable release unless a concrete route regresses or stalls.
