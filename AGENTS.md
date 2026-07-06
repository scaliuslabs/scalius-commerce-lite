# Scalius Commerce

Root agent context is intentionally small. Treat this file as a router, not a codebase tour. If a fact needs more than one line, put it in a focused doc and link it here only when it is a recurring landmine.

## Load First

- Current remediation queue: `audit/REMEDIATION_TRACKER.md`
- Verification/deploy playbook: `audit/VERIFICATION_PLAYBOOK.md`
- Platform goal, release bar, and orchestration rules: `docs/codex/PLATFORM-GOAL.md`
- Codex doc index and update rules: `docs/codex/README.md`
- Architecture map when boundaries are unclear: `docs/ARCHITECTURE.md`
- Historical full agent notes only when a missing landmine blocks you: `docs/codex/AGENTS-REFERENCE.md`

## Non-Negotiables

- Use `pnpm` from the repo root. Deploy through `pnpm run deploy*`, not pnpm's package deploy behavior.
- Use `pnpm ops:check` for read-only production API ops smokes; add `--queues` when queue metadata matters. It intentionally runs Wrangler through `pnpm --dir apps/api`, so do not rely on root-level `pnpm exec wrangler`.
- Use `pnpm release:check` for the compact read-only release smoke across tracker/docs, API ops, dashboard auth gate, storefront pages, and discovery XML/feed.
- Never hand-edit generated files: `apps/admin-v2/src/routeTree.gen.ts` and `packages/api-client/src/generated/**`.
- After API contract changes, run `pnpm generate:sdk`. After schema changes, run `pnpm db:generate`.
- Do not touch `.dev.vars`, `.env*`, or other secret-bearing files.
- Keep Cloudflare bindings and Worker `Env` declarations synchronized, then run `pnpm check:env`.
- `@scalius/database` and `@scalius/shared` use subpath imports such as `@scalius/database/schema`; avoid root imports.
- Storefront code may import shared/api-client packages, but must not import `@scalius/core` or `@scalius/database` without an explicit architecture decision.

## High-Risk Landmines

- D1 is the authority for auth, setup, checkout, payment, inventory, scanner tokens, and customer sessions. KV/cache rows are hints unless a domain doc proves otherwise.
- Checkout/order/payment writes must be idempotent and commit local state before provider side effects when duplicate orders, stock leaks, or double charges are possible.
- Phone collection is mandatory for customer identity and checkout in Bangladesh. Do not add a merchant setting that disables phone collection.
- Products are merchandising containers. Sellable/inventory identities are `product_variants`; simple products use exactly one hidden/default persisted SKU, never product-level inventory. Optioned products must keep one active option-axis shape per product; do not mix Option 1-only, Option 2-only, and both-option SKU rows. Permanent product deletes must not erase SKU audit history: if any SKU has inventory movements, block the hard delete and keep the product in trash/soft-delete state.
- Product-feed availability must come from buyer-resolvable SKU availability (`availableForSale`), not product active status alone, so feed XML matches product JSON-LD and checkout truth. Feed data comes from `/api/v1/products/feed`; do not bloat normal public listing reads with feed-only description/image/category/attribute/variant projection. Feed XML must fail closed on non-absolute storefront URLs, skip products without a real absolute `http(s)` primary image link, flatten rich-text descriptions into plain catalog text, honor dashboard feed title/description, sold-out inclusion, row strategy policy, and product-level `excludeFromProductFeed`, and default optioned products to SKU/variant rows with stable `item_group_id` values. Product feed exclusion keeps the buyer page public; it is not noindex and must show as an intentional dashboard diagnostic reason. Admin feed diagnostics must stay bounded and read-only, use the same primary-image/SKU/availability policy as the XML feed, and expose only aggregate counts plus safe product samples.
- Stock-changing writes affect public feed and sitemap availability. Product availability invalidation must clear dedicated API feed/sitemap projections, normal public product/list/search API caches, storefront product exact keys, and the `feed_products_` and `sitemap_products_` exact-generation families. Storefront HTML/XML cache classification must map `/api/product-feed.xml` and `/api/facebook-feed.xml` into `feed_products_`, and `/sitemap-products.xml` into `sitemap_products_`, so rendered XML does not wait for TTL to show sold-out/restocked or discovery-exclusion truth.
- Sitemaps, robots, and SEO discovery assets must fail closed when `STOREFRONT_URL` is missing or not absolute; never emit relative discovery URLs in XML, robots output, canonical links, Open Graph image tags, or JSON-LD image fields. Product sitemap XML uses `/api/v1/products/sitemap`, which filters `noIndex` and `excludeFromSitemap` before pagination; do not filter excluded products after reading a generic product page. Category, collection, and CMS page sitemaps must also exclude resources with `noIndex` or `excludeFromSitemap`.
- Resource `noIndex` keeps the public page reachable with `noindex,follow`, removes it from XML discovery, and suppresses resource/page-specific JSON-LD; `excludeFromSitemap` is XML-only and must not imply noindex or hidden page visibility. Resource `canonicalPath` is a same-store path override only: no absolute URLs, protocol-relative URLs, queries, fragments, backslashes, or control/space characters. Blank/null means the normal public route, and a valid override must drive canonical links, Open Graph URLs, resource JSON-LD URLs, breadcrumb item URLs, and sitemap `<loc>` for included products, categories, collections, and CMS pages.
- Sitemap-advertised static pages need canonicals, listing query/sort/filter/page variants should canonicalize or `noindex,follow`, and sitemap XML should emit absolute `<loc>` plus truthful `<lastmod>` without ignored `<priority>` or `<changefreq>` tags. Sitemap index entries must not use request/render time as `lastmod`; omit index-level `lastmod` until a truthful child-sitemap modified timestamp exists. The browser XSL view must mirror the generated XML contract and must not show priority/change-frequency columns.
- OnlineStore/WebSite/Product/ProductGroup/Breadcrumb/CollectionPage JSON-LD must honor `settings.seo/discovery` structured-data toggles, and logo/product image URLs must pass through the absolute storefront SEO URL helper before schema emission. OnlineStore identity is backed by public business settings, Product offers may include shippingDetails only from active shipping methods, product seller identity should come from business settings, product brand should be emitted only from explicit product data, and Product/Offer JSON-LD must not fabricate facts such as `priceValidUntil` or condition. Do not fall back to footer/logo text or the literal `"Store"` for seller or OnlineStore names; if business settings are incomplete, suppress the fragile identity field or surface a dashboard blocker. Breadcrumb JSON-LD should follow the breadcrumb toggle independently from CollectionPage schema, and category CollectionPage schema should use the stored category description when available.
- Store-level MerchantReturnPolicy JSON-LD may be emitted only from the merchant-saved `settings.seo/return_policy` fields: enabled, country, category, finite window days, fee responsibility, return method, and optional same-origin/absolute policy URL. Business settings writes must invalidate `layout` so organization/schema identity cannot stay stale. AEO/AIO work follows the same rule: expose accurate buyer-visible commerce facts, not extra schema that does not match the page, feed, and checkout truth. SEO setting saves must invalidate API/layout/homepage caches and schedule storefront warm paths for `/robots.txt`, `/sitemap.xml`, all sitemap child XML files, canonical `/api/product-feed.xml`, and compatibility `/api/facebook-feed.xml` so dashboard discovery changes do not leave crawlers with cold or stale public XML.
- `robots.txt` should advertise only the canonical current storefront sitemap URL when sitemap advertising is enabled, and no sitemap directives when it is disabled. Do not preserve stale off-origin or same-origin non-canonical `Sitemap:` lines from copied settings.
- Public `/seo` responses are KV-cached; when expanding that response contract, bump the nested route cache namespace (currently `api:seo:v3:`) while keeping the broader `api:seo:` invalidation group intact.
- Analytics snippets are trusted admin code, but first-class provider types must not preserve obvious placeholders as active public injection. Cloudflare Web Analytics is the Cloudflare-native default alternative: accept a real token or official beacon snippet, canonicalize it to the platform-generated beacon snippet, force it off Partytown, and block the placeholder token before activation or legacy toggles.
- Public checkout/config/payment readiness must fail closed. Do not guess COD or a gateway when settings cannot be read.
- Sensitive forms must be safe before hydration and with JavaScript disabled. Credentials, OTPs, tokens, phone/email, cart, payment, and discount values must not enter URLs.
- Receipt proof must not enter URLs, analytics payloads, logs, clipboard URLs, or KV keys. Duplicate/in-flight checkout polling uses a derived `cst_` status token; never put a `chk_` receipt proof in `/orders/status/{token}`. Checkout-status KV hints and receipt KV hints must hash proof/token material before keying; logs may include only short non-bearer hash/key prefixes. Guest receipt access uses same-origin httpOnly cookies plus API header/body proof; merchant-sendable cross-browser hosted-payment recovery must use the buyer-verified `/payment-recovery?orderId=...` OTP handoff, never a bearer recovery URL.
- OTP queue payloads must carry opaque challenge/delivery references only. New customer-login or payment-recovery `auth.send_otp` messages must not serialize raw OTP codes, recipient identifiers, or display names; the API queue consumer derives the code at send time and resolves encrypted delivery targets from the D1 challenge rows. Raw `code`/`identifier`/`name` fields are legacy pre-reference payload fallback only.
- Provider failures should log masked metadata only. Never log raw OTPs, credentials, receipt tokens, provider payloads, or buyer PII. Encrypted provider credentials must use strict reads with the dedicated `CREDENTIAL_ENCRYPTION_KEY` on hot send paths; do not fall back to JWT secrets, do not call providers with unreadable ciphertext, and treat obvious dummy/placeholder credentials as not configured.

## Work Loop

1. Check `audit/REMEDIATION_TRACKER.md` before choosing or continuing a slice.
2. Load only the task-specific docs and files needed for the slice; if docs conflict, verify against code and runtime before trusting prose.
3. Prefer small, boring fixes that remove complexity instead of explaining it away.
4. In goal-mode work, act as the lead: delegate independent code slices to workers with disjoint file ownership, review/integrate their patches, and keep direct edits narrow.
5. Add focused tests around the failure mode before broad gates.
6. For meaningful code changes, verify locally, deploy when required, smoke live behavior, update docs, then commit.
7. When new agent guidance is needed, add the shortest pointer/rule here and put durable details beside the owning code, test, or focused doc.

## Context Hygiene

Add to this root file only when the fact is non-obvious, repeatedly trips agents, and cannot be enforced in code/tests. Use it as an index of pointers and production landmines; do not restate product vision or domain docs here. If it grows past one screen, prune first and move details into the relevant domain doc.
