# Storefront Image Optimization Audit

Date: 2026-05-13

Scope: storefront product/list/detail rendering, shared image optimizer, Cloudflare Image Resizing/R2/CDN settings, and raw CDN URL leak paths. Source of truth is the current implementation in this repository.

## Executive Summary

Product image rendering is mostly centralized correctly: product cards, search results, carousels, product detail gallery, quick-buy, cart views, CMS rich content, widgets, header/footer assets, and Meta feed all pass through storefront wrappers that delegate to `@scalius/shared/image-optimizer`.

The main risk is not a missing product-card optimizer call. The main risk is configuration drift: the storefront emits `/cdn-cgi/image/...` URLs on the image CDN host, but the repo cannot prove that `cloud.scalius.com` has Cloudflare Image Resizing enabled and correctly mapped to the `scalius-media` R2 bucket. A second concrete risk is legacy or imported absolute media URLs on hosts outside the allowed CDN list. The shared optimizer intentionally returns those unchanged, which can leak raw CDN URLs or produce broken images unless aliases are configured.

## Current Implementation Map

### Data Sources

- `packages/database/src/schema/products.ts`
  - `productImages.url`: product gallery/source URL.
  - `categories.imageUrl`: category image URL.
  - `media.url`: media library public URL.
- `packages/core/src/integrations/storage.ts`
  - `initStorage(bucket, publicUrl)` stores the R2 binding and public base URL.
  - `uploadFile()` writes objects to R2 and returns `buildPublicUrl(baseUrl, key)`.
  - `extractKeyFromUrl()` understands `/api/v1/media/` and `/cdn-cgi/image/` URLs when deleting.
- `apps/api/src/app.ts`
  - `getR2PublicUrl(env, requestUrl)` uses `/api/v1/media` only on localhost; production uses `env.R2_PUBLIC_URL`.
  - Middleware calls `initStorage(c.env.BUCKET, getR2PublicUrl(...))`.
- `apps/api/wrangler.jsonc`
  - R2 binding: `BUCKET` -> `scalius-media`.
  - Public media vars: `CDN_DOMAIN_URL = cloud.scalius.com`, `R2_PUBLIC_URL = https://cloud.scalius.com`.
- `apps/storefront/wrangler.jsonc`
  - Storefront CDN var: `CDN_DOMAIN_URL = cloud.scalius.com`.
  - No R2 binding in storefront; storefront only emits URLs.

### Optimization Core

- `packages/shared/src/media-url.ts`
  - `resolveMediaUrl(url, cdnBase, { cdnHostAliases })`
  - Bare keys become `${cdnBase}/${key}`.
  - Absolute URLs are preserved unless their host is configured as a canonical alias.
  - `/cdn-cgi/...` and local `/...` paths are preserved.
- `packages/shared/src/image-optimizer.ts`
  - `getOptimizedImageUrl(originalUrl, options, ctx)`
  - Resolves bare keys/aliases with `resolveMediaUrl()`.
  - If `ctx.enabled === false`, returns the canonical raw source URL.
  - If source is an allowed HTTPS CDN URL, returns:
    - `https://<cdn-host>/cdn-cgi/image/onerror=redirect,.../<path>`
  - If source is an absolute HTTPS URL outside `ctx.cdnHosts`, returns it unchanged.
  - If source is already optimized, it unwraps/rebuilds when new transform options are passed.
  - Always includes `onerror=redirect`.
- `apps/storefront/src/lib/media-url.ts`
  - `getCdnBase()`, `getCdnHosts()`, `getCdnCanonicalHostAliases()`, `getImageOptimizationEnabled()`
  - Reads per-request dashboard policy from `apiContext`, then Worker `CDN_DOMAIN_URL`, then injected browser globals.
- `apps/storefront/src/lib/image-optimizer.ts`
  - `getCtx()` binds the shared optimizer to storefront runtime policy.
  - `getOptimizedImageUrl()` and `getResponsiveSrcSet()` are the storefront-facing wrappers.
- `apps/storefront/src/lib/product-media.ts`
  - `getProductImageUrl()` is the product-safe wrapper.
  - Skips SVG resizing.
  - Uses `/placeholder-product.svg` fallback.
  - `getProductImageSrcSet()` builds explicit product srcset variants.

### Runtime Policy Path

- `packages/core/src/modules/settings/site-settings.service.ts`
  - `parseMediaOptimizationSettings()` normalizes `settings(category="media", key="image_optimization")`.
  - Supports `enabled`, `canonicalCdnUrl`, `allowedImageHosts`, `canonicalHostAliases`.
- `packages/core/src/modules/storefront/storefront.service.ts`
  - `getLayoutData()` reads media settings and returns `layoutData.media`.
- `apps/storefront/src/lib/page-data.ts`
  - `loadPageWithLayout()` calls `setRuntimeImageCdnPolicy(layoutData?.media)` after fetching layout.
- `apps/storefront/src/layouts/Layout.astro`
  - Calls `setRuntimeImageCdnPolicy(layoutData?.media)`.
  - Injects browser globals:
    - `window.__IMAGE_OPTIMIZATION_ENABLED__`
    - `window.__IMAGE_CDN_BASE_URL__`
    - `window.__IMAGE_CDN_HOSTS__`
    - `window.__IMAGE_CDN_CANONICAL_HOST_ALIASES__`
    - `window.__CDN_DOMAIN__`
- `apps/storefront/src/middleware.ts`
  - Sets per-request `CDN_DOMAIN_URL` in `apiContext`.
  - Also writes `globalThis.__SCALIUS_CDN_DOMAIN__` as a fallback.

## Product Rendering Coverage

### Product Lists

- `apps/storefront/src/components/cards/ProductCard.astro`
  - `productImageUrl = getProductImageUrl(product.imageUrl, { width: 400, height: 400, quality: 80, format: "auto", fit: "contain" })`
  - Used by:
    - `apps/storefront/src/pages/search/index.astro`
    - `apps/storefront/src/pages/categories/[slug].astro`
    - `apps/storefront/src/pages/collections/[id].astro`
    - `apps/storefront/src/components/collection1.astro`
- `apps/storefront/src/components/sliders/ProductCarousel.tsx`
  - `ProductCarouselCard()` calls `getProductImageUrl(product.imageUrl, 400x400...)`.
- `apps/storefront/src/components/search/CommandPalette.tsx`
  - Search product rows call `getProductImageUrl(p.imageUrl, 80x80...)`.
- API sources for these rows:
  - `packages/core/src/modules/products/products.storefront.ts#getStorefrontProducts()`
  - `packages/core/src/modules/products/products.storefront.ts#searchStorefrontProducts()`
  - `packages/core/src/modules/collections/collections.service.ts#buildCollectionProductSelect()`

### Product Detail

- `apps/storefront/src/pages/products/[slug].astro`
  - Preload, OG image, JSON-LD image, and `data-product-image` use `getProductImageUrl()`.
- `apps/storefront/src/components/product/ProductGallery.astro`
  - Filters with `hasProductImage()`.
  - Builds:
    - thumbnail: `getProductImageUrl(..., desktopThumb.imageSize)`
    - main: `getProductImageUrl(..., 600x600)`
    - mobile srcset: `getProductImageSrcSet(..., 400w/600w)`
    - zoom: `getProductImageUrl(..., 1400x1400)`
- `apps/storefront/src/components/product/ProductImageZoom.tsx`
  - Receives already optimized `initialImage` and `initialZoomImage`.
  - `getHighResUrl()` mutates `/cdn-cgi/image/` params to `width=1600,height=1600` for hover zoom.
- `apps/storefront/src/components/product/RelatedProducts.astro`
  - Uses `getProductImageUrl(..., 300x300)`.
- API source:
  - `packages/core/src/modules/products/products.storefront.ts#getStorefrontProductBySlug()`

### Product Shortcodes, Cart, and Quick Buy

- `apps/storefront/src/lib/serialized-media.ts`
  - `withOptimizedCollectionProductImages()`
  - `withOptimizedProductPageImages()`
  - Pre-optimizes JSON used for hydrated client widgets/product shortcodes.
- `apps/storefront/src/components/ProductShortcode.tsx`
  - Main and thumbnail images call `getProductImageUrl()`.
- `apps/storefront/src/pages/api/products/[slug].ts`
  - Returns `withOptimizedProductPageImages(productData)`.
- `apps/storefront/src/pages/buy/[slug].ts`
  - Builds `cartImageUrl = getProductImageUrl(..., 160x160)`.
  - Renders the transitional HTML with the optimized `cartImageUrl`.
- `apps/storefront/src/components/CartFlyout.tsx`
  - Cart item images call `getProductImageUrl(item.image, 96x96)`.
- `apps/storefront/src/lib/cart/client.ts`
  - Checkout/cart DOM rendering calls `getProductImageUrl(item.image, 96x96)`.
- `apps/storefront/src/pages/account.astro`
  - Order history item images call `getProductImageUrl(item.productImage, 96x96)`.

### Non-Product Media That Shares the Same Pipeline

- `apps/storefront/src/components/sliders/CustomCarousel.astro`
  - Hero slides call `getOptimizedImageUrl(image.url, ...)`.
- `apps/storefront/src/components/RichContent.astro`
  - Sanitizes then calls `optimizeRichContentImages()`.
- `apps/storefront/src/lib/rich-content-media.ts`
  - Optimizes `<img>`, `<source srcset>`, and CSS `url(...)`.
  - SVG assets use `resolveMediaUrl()` and are not resized.
- `apps/storefront/src/lib/widget-content.ts`
  - Widget HTML and CSS both run through rich-content image optimization.
- `apps/storefront/src/layouts/Layout.astro`
  - Favicon and Organization JSON-LD logo use `getOptimizedImageUrl()`.
- `apps/storefront/src/components/header/HeaderLayout.astro`
  - Header logo and social icons use `getOptimizedImageUrl()`.
- `apps/storefront/src/components/header/MobileMenu.astro`
  - Mobile social icons use `getOptimizedImageUrl()`.
- `apps/storefront/src/components/Footer.astro`
  - Footer logo, favicon, social icons, and rich description are optimized.
- `apps/storefront/src/pages/api/facebook-feed.xml.ts`
  - Product feed `<g:image_link>` uses `getOptimizedImageUrl(product.imageUrl, { width: 1200, ... })`.

## Confirmed Raw URL Behavior

Raw URL storage is intentional at the API/data layer. These endpoints return source URLs from DB:

- `packages/core/src/modules/products/products.storefront.ts#getStorefrontProducts()`
- `packages/core/src/modules/products/products.storefront.ts#getStorefrontProductBySlug()`
- `packages/core/src/modules/products/products.storefront.ts#searchStorefrontProducts()`
- `packages/core/src/modules/collections/collections.service.ts#buildCollectionProductSelect()`

That is acceptable because rendering code optimizes on output. The raw URL becomes a leak only when a renderer bypasses `getProductImageUrl()`, `getOptimizedImageUrl()`, `resolveMediaUrl()`, or `optimizeRichContentImages()`, or when the source host is outside the allow-list/alias policy.

## Findings and Failure Causes

### P0 - Cloudflare Image Resizing enablement is an external single point of failure

Files/functions:

- `packages/shared/src/image-optimizer.ts#getOptimizedImageUrl()`
- `apps/storefront/wrangler.jsonc`
- `apps/api/wrangler.jsonc`

Current behavior:

- Storefront emits optimized URLs on the media host, for example:
  - `https://cloud.scalius.com/cdn-cgi/image/onerror=redirect,width=400,.../<key>`
- The app routes transforms through the CDN/media host, not through `storefront.scalius.com`.
- The repo config declares `CDN_DOMAIN_URL` and `R2_PUBLIC_URL`, but does not prove that:
  - `cloud.scalius.com` is attached to the R2 bucket/public object route.
  - Cloudflare Image Resizing is enabled on the zone/hostname serving `cloud.scalius.com`.

Failure cause:

- If Image Resizing is disabled or unavailable on `cloud.scalius.com`, every optimized product image URL depends on Cloudflare's `/cdn-cgi/image` fallback. `onerror=redirect` helps, but customers still pay the extra failed transform request and some clients/crawlers may see the failed/resolved URL behavior differently.

Ranked fix:

1. Add a deploy/smoke check that fetches one known object through `https://cloud.scalius.com/cdn-cgi/image/width=32,format=auto/<key>` and fails deploy if status/content-type is not image-like.
2. Document the required Cloudflare zone setting beside `apps/api/wrangler.jsonc`/deployment docs.
3. Consider adding an admin "test CDN transform" action next to `MediaSettingsBuilder`.

### P1 - Legacy `cloud.wrygo.com` migration can create raw CDN leaks/broken images

Files/functions:

- `packages/database/migrations/0014_fix_media_urls.sql`
- `packages/shared/src/image-optimizer.ts#canResizeAbsoluteUrl()`
- `packages/shared/src/image-optimizer.ts#getOptimizedImageUrl()`
- `packages/shared/src/media-url.ts#resolveMediaUrl()`

Current behavior:

- Migration `0014_fix_media_urls.sql` prepends `https://cloud.wrygo.com/` to bare `media.url`, `product_images.url`, and `categories.image_url`.
- Current Worker vars use `cloud.scalius.com`.
- The optimizer only rewrites absolute URLs when the host is in `cdnHosts` or in `cdnHostAliases`.
- If DB rows still contain `https://cloud.wrygo.com/...` and `cloud.wrygo.com` is not configured in `canonicalHostAliases`, the storefront returns that URL unchanged.

Failure cause:

- Raw `cloud.wrygo.com` URLs leak into product cards, galleries, OG tags, JSON-LD, feeds, widgets, and cart/order views because the optimizer intentionally refuses to rewrite non-allowlisted hosts.

Ranked fix:

1. Audit production DB for `product_images.url`, `media.url`, and `categories.image_url` hosts not equal to `cloud.scalius.com`.
2. Add `cloud.wrygo.com` as a temporary `canonicalHostAliases` value in media settings if production data still contains it.
3. Add a new corrective migration or one-off data repair to canonicalize legacy host values to `https://cloud.scalius.com/...`.

### P1 - Image policy changes can leave optimized URLs stale in client-visible caches

Files/functions:

- `apps/api/src/routes/admin/settings/site.ts` media settings route
- `apps/api/src/utils/cache-invalidation.ts` group `media`
- `apps/storefront/src/pages/api/purge-cache.ts`
- `apps/storefront/src/lib/edge-cache.ts#withEdgeCache()`
- `apps/storefront/src/lib/serialized-media.ts`

Current behavior:

- Saving media settings invalidates API layout/homepage groups and triggers storefront purge for `media`.
- Storefront HTML/L2 keys include KV version, so new HTML uses new policy after purge.
- However, client-persisted cart items and session data can contain old optimized URLs:
  - `apps/storefront/src/store/cart.ts` persists `image`.
  - `apps/storefront/src/pages/buy/[slug].ts` writes optimized `cartImageUrl` into `sessionStorage`.
  - `apps/storefront/src/lib/shortcodes.ts#renderProductShortcode()` serializes `withOptimizedProductPageImages(productData)` into markup.

Failure cause:

- The shared optimizer can unwrap/rebuild `/cdn-cgi/image/` URLs when a component calls it again, so most visible cart/client paths self-heal. But any external consumer of `/api/products/[slug]` or persisted JSON sees already-optimized URLs until refreshed. This makes policy toggles and CDN alias changes harder to reason about.

Ranked fix:

1. Prefer storing original media URLs in persistent browser state and only optimize at render time.
2. Keep `withOptimizedProductPageImages()` only for server-rendered hydrated payloads where the consumer immediately renders through current page globals.
3. Add tests that flip `enabled` from true to false and verify cart/product-shortcode renderers unwrap stale `/cdn-cgi/image/` URLs.

### P2 - `ProductImageZoom.getHighResUrl()` edits URL strings directly

Files/functions:

- `apps/storefront/src/components/product/ProductImageZoom.tsx#getHighResUrl()`

Current behavior:

- For already optimized URLs, `getHighResUrl()` does string replacement:
  - `.replace(/width=\d+/, "width=1600")`
  - `.replace(/height=\d+/, "height=1600")`
- ProductGallery already passes `initialZoomImage`, so this fallback is usually not used.

Failure cause:

- If an optimized URL lacks a `height` param, has repeated params, or uses a different transform order, the fallback can fail to produce the intended high-res URL. This is isolated to hover zoom fallback, not primary rendering.

Ranked fix:

1. Pass `initialZoomImage` everywhere the component is used.
2. Replace string mutation with a call back into `getProductImageUrl(originalUrl, { width: 1600, height: 1600, ... })`, or pass original source URL alongside display URL.

### P2 - Rich content optimization uses narrow regex parsing

Files/functions:

- `apps/storefront/src/lib/rich-content-media.ts#optimizeRichContentImages()`
- `apps/storefront/src/lib/rich-content-media.ts#optimizeSourceTags()`
- `apps/storefront/src/lib/rich-content-media.ts#optimizeCssImageUrls()`

Current behavior:

- The implementation intentionally uses narrow regexes after sanitization.
- Tests cover basic `<img>`, `<source srcset>`, CSS `url(...)`, SVG bypass, stale optimized URLs, and priority images.

Failure cause:

- Complex `srcset` candidates, unusual quoting, escaped URLs, or HTML generated by rich editors can bypass optimization or be parsed incorrectly. This is lower risk because product/list/detail images do not use this parser.

Ranked fix:

1. Keep tests expanding around real widget/page snippets that merchants generate.
2. If bypasses appear in production, move rich content transforms to an HTML parser rather than broadening regexes.

### P2 - Astro image domain config is effectively unused for current runtime optimization

Files/functions:

- `apps/storefront/astro.config.mjs`
- `apps/storefront/src/lib/image-config.ts`

Current behavior:

- Astro adapter uses `imageService: "passthrough"`.
- Product/hero/widget rendering uses manual Cloudflare Image Resizing URLs.
- `imageConfig.domains` reads `CDN_DOMAIN_URL` from build-time env or `wrangler.jsonc`, but this does not control runtime `getOptimizedImageUrl()` behavior.

Failure cause:

- Developers may assume Astro image config validates/supports runtime CDN optimization. It does not. The runtime policy path is `layoutData.media` plus `CDN_DOMAIN_URL`.

Ranked fix:

1. Add a short comment in `astro.config.mjs` that product images use the storefront/shared optimizer, not Astro image transforms.
2. Avoid adding Astro `<Image />` usage for product CDN images unless the Cloudflare adapter/image service strategy changes.

## Raw CDN URL Leak Inventory

No direct product/list/detail renderer currently emits `product.imageUrl`, `image.url`, or `item.productImage` without an optimizer wrapper.

Known intentional raw surfaces:

- API JSON from `apps/api/src/routes/products.ts`
- API JSON from collection/category/search routes
- DB rows and admin media URLs

Known possible raw leak causes:

- Absolute source URL host is not in:
  - `CDN_DOMAIN_URL`
  - `media.canonicalCdnUrl`
  - `media.allowedImageHosts`
  - `media.canonicalHostAliases`
- Legacy `https://cloud.wrygo.com/...` rows from `0014_fix_media_urls.sql`.
- Third-party absolute URLs in merchant-authored content/widgets. These are intentionally preserved unless allow-listed.
- SVG assets. These intentionally bypass Image Resizing but are still canonicalized by `resolveMediaUrl()` when possible.

## Ranked Fix Plan

1. Add a CDN transform health check for `cloud.scalius.com`.
   - Highest confidence production risk.
   - Validates the external Cloudflare setting that the repo cannot enforce.

2. Repair or alias legacy media hosts.
   - Query `media.url`, `product_images.url`, and `categories.image_url` for non-`cloud.scalius.com` hosts.
   - Configure aliases first, then migrate/canonicalize data.

3. Add optimizer regression tests for storefront wrappers, not just shared helpers.
   - Current tests cover `packages/shared/src/image-optimizer.ts` and rich content.
   - Missing coverage: `apps/storefront/src/lib/product-media.ts`, `apps/storefront/src/lib/media-url.ts`, and representative product card/gallery URL outputs under runtime policy.

4. Stop persisting optimized image URLs where durable state is expected.
   - Prefer original URL in cart/session data.
   - Optimize at render time.

5. Replace zoom fallback URL string rewriting.
   - Lower blast radius, but easy to make robust.

6. Clarify config ownership.
   - `wrangler.jsonc` vars choose the canonical host.
   - Dashboard media settings choose overrides/aliases.
   - Cloudflare zone/R2 custom domain settings must enable the actual transform endpoint.

## Test Coverage Observed

- `tests/unit/storefront/image-optimizer.test.ts`
  - Covers CDN routing, bare keys, idempotency, disabled optimization, dev behavior, allow-list behavior, and alias canonicalization.
- `tests/unit/storefront/rich-content-media.test.ts`
  - Covers rich HTML/CSS optimization, SVG bypass, priority images, width-only variants, and stale optimized URL rebuilds.

Gaps:

- No direct tests for `apps/storefront/src/lib/product-media.ts`.
- No direct tests for `apps/storefront/src/lib/media-url.ts` runtime policy resolution from window globals.
- No integration snapshot for `ProductCard.astro` or `ProductGallery.astro` output.
- No deploy-time test proving Cloudflare Image Resizing works on the configured CDN host.
