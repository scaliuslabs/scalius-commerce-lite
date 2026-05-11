# Audit 06: Catalog, Content, Store Presentation

## Scope

Owned slice:

- `packages/core/src/modules/products`
- `packages/core/src/modules/categories`
- `packages/core/src/modules/collections`
- `packages/core/src/modules/attributes`
- `packages/core/src/modules/pages`
- `packages/core/src/modules/widgets`
- `packages/core/src/modules/navigation`
- `packages/core/src/modules/media`
- `packages/core/src/modules/storefront`
- Related search helpers where they materially affect catalog/content exposure

Also traced the main end-to-end consumers in:

- `apps/api/src/routes/{products,categories,collections,attributes,pages,widgets,storefront,navigation,search}.ts`
- `apps/api/src/routes/admin/{products,pages,widgets,navigation,media}.ts`
- `apps/storefront/src/pages/{index,[slug],categories/[slug],search/index}.astro`
- `apps/storefront/src/lib/api/{storefront,products,categories,attributes,pages,widgets}.ts`
- `apps/admin-v2/src/lib/api.mutations.ts`

## How This Slice Works End To End

1. Admin writes originate in `apps/admin-v2`, where mutation hooks call the admin API. Those hooks mostly invalidate TanStack Query state for the admin UI only, for example `apps/admin-v2/src/lib/api.mutations.ts:156-220`, `899-1085`, and `1135-1242`.

2. Admin API routes in `apps/api/src/routes/admin/*` are intentionally thin and mostly delegate to the `packages/core` services for CRUD and business rules. The important domain services are:
   - Products: `packages/core/src/modules/products/products.admin.ts`
   - Categories: `packages/core/src/modules/categories/categories.service.ts`
   - Collections: `packages/core/src/modules/collections/collections.service.ts`
   - Pages: `packages/core/src/modules/pages/pages.service.ts`
   - Widgets: `packages/core/src/modules/widgets/widgets.service.ts`
   - Navigation: `packages/core/src/modules/navigation/navigation.service.ts`
   - Media: `packages/core/src/modules/media/media.service.ts`

3. Public/storefront reads are split between:
   - Generic storefront product/category/page/attribute routes
   - The consolidated homepage and layout endpoints in `apps/api/src/routes/storefront.ts`
   - Direct storefront-side API wrappers in `apps/storefront/src/lib/api/*`

4. The storefront app then applies its own L1+L2 edge caching via `apps/storefront/src/lib/edge-cache.ts`, with long-lived keys such as:
   - `storefront_homepage_*` in `apps/storefront/src/lib/api/storefront.ts:88-103`
   - `storefront_layout_*` in `apps/storefront/src/lib/api/storefront.ts:116-131`
   - `page_slug_*` / `all_pages_*` in `apps/storefront/src/lib/api/pages.ts:20-42` and `62-93`
   - `category_products_*` in `apps/storefront/src/lib/api/products.ts:138-189`
   - `filterable_attrs_*` in `apps/storefront/src/lib/api/attributes.ts:27-60`

5. Rendering is a mix of typed JSON composition and raw HTML injection:
   - Homepage widgets render with `set:html` in `apps/storefront/src/pages/index.astro:103-145`
   - CMS page bodies render with `set:html` in `apps/storefront/src/components/RichContent.astro`
   - Widget shortcodes go through the single-widget API and are sanitized there
   - Homepage widgets do not currently take that same safe path

## Findings

### Critical

#### 1. Homepage widgets bypass the widget sanitizer and are rendered as raw HTML/CSS on the storefront

Why this matters:

- The widget module already has dedicated public helpers that sanitize HTML and CSS before storefront rendering.
- The consolidated homepage path does not use those helpers.
- The storefront homepage injects the returned `htmlContent` and `cssContent` directly with `set:html`, so any unsafe widget payload becomes executable storefront markup.

Evidence:

- `packages/core/src/modules/storefront/storefront.service.ts:83-88` reads homepage widgets directly from the `widgets` table.
- `packages/core/src/modules/storefront/storefront.service.ts:123-134` forwards `htmlContent` and `cssContent` unchanged.
- `packages/core/src/modules/widgets/widgets.service.ts:97-128` shows the intended sanitized public path via `getActiveWidgetById()` and `getActiveHomepageWidgets()`.
- `apps/api/src/routes/storefront.ts:41-44` serves the unsanitized consolidated homepage payload.
- `apps/storefront/src/pages/index.astro:103-145` renders widget HTML/CSS with `set:html`.

Impact:

- A malicious or compromised widget can XSS every homepage visitor.
- This bypass is easy to miss because the dedicated widget routes are safe, but the higher-traffic consolidated homepage route is not.

Severity:

- Critical security bug.

### High

#### 2. Catalog/content writes do not automatically invalidate storefront caches, so live storefront state can stay stale until someone manually purges it

Why this matters:

- The storefront cache layer is explicitly long-lived and expects purge-driven invalidation.
- The normal admin mutation path only refreshes the admin dashboard cache, not the public storefront cache.
- There is a manual cache-clearing route, but I did not find it wired into the normal product/category/collection/page/widget mutation flow.

Evidence:

- Long-lived storefront cache wrappers:
  - `apps/storefront/src/lib/api/storefront.ts:88-131`
  - `apps/storefront/src/lib/api/pages.ts:20-42`
  - `apps/storefront/src/lib/api/products.ts:138-189`
  - `apps/storefront/src/lib/api/attributes.ts:27-60`
- Admin mutation hooks only invalidate TanStack Query state:
  - Products: `apps/admin-v2/src/lib/api.mutations.ts:156-220`
  - Pages: `apps/admin-v2/src/lib/api.mutations.ts:899-985`
  - Widgets: `apps/admin-v2/src/lib/api.mutations.ts:992-1084`
  - Collections: `apps/admin-v2/src/lib/api.mutations.ts:1135-1242`
- Manual cache purge exists separately at `apps/api/src/routes/cache.ts:150-231`.
- Navigation is the only place in this slice that explicitly invalidates site-settings KV, and even that is not the storefront page cache: `apps/api/src/routes/admin/navigation.ts:107-109`, `136-151`, `170-185`.

Impact:

- Merchants can save catalog/content changes and still serve old homepage/layout/page/category/search data to shoppers.
- This is especially risky for widgets, collections, navigation, and pages because the storefront deliberately caches them aggressively.

Severity:

- High architecture/invalidation bug.

#### 3. `publishedAt` exists in the page model and admin form, but public visibility logic ignores it completely

Why this matters:

- The codebase carries a scheduling concept, but public reads only check `isPublished`.
- Future-dated pages can be publicly reachable immediately if `isPublished` is true.
- Navigation and layout fallback can also expose those pages immediately.

Evidence:

- `packages/core/src/modules/pages/pages.validation.ts:14-17` accepts `publishedAt`.
- `packages/core/src/modules/pages/pages.service.ts:176-185` stores `publishedAt` on create.
- `packages/core/src/modules/pages/pages.service.ts:107-120` public reads only require `isPublished = true` and `deletedAt IS NULL`.
- `packages/core/src/modules/pages/pages.service.ts:133-154` public page lists also ignore `publishedAt`.
- `packages/core/src/modules/pages/pages.service.ts:226-233` bulk publish/unpublish toggles `isPublished` only and does not maintain scheduling semantics.
- `packages/core/src/modules/navigation/navigation.service.ts:47-57` and `223-238` include published pages in navigation using the same simplified predicate.
- `packages/core/src/modules/storefront/storefront.service.ts:199-200` includes published pages in layout fallback using only `isPublished`.
- The admin page form even auto-fills `publishedAt` when publishing, implying the field is meant to matter: `apps/admin-v2/src/components/admin/PageForm.tsx:79-86`.
- The storefront sitemap emits `publishedAt` as `lastmod`, so a future-dated page can end up both live and misleadingly timestamped: `apps/storefront/src/pages/sitemap-pages.xml.ts:55-64`.

Impact:

- Scheduled publishing is effectively broken.
- Merchants can accidentally expose content early.
- Navigation and sitemap behavior can drift from editorial intent.

Severity:

- High business-logic bug.

### Medium

#### 4. Category storefront pages use a forked product query that has already drifted from the shared storefront product logic

Why this matters:

- There is a shared storefront product query in `products.storefront.ts`, but category pages do not use it.
- The category-specific route reimplements filters, sorting, attribute filtering, image join behavior, and discount math by hand.
- That duplicate path already disagrees with the shared behavior on discount logic.

Evidence:

- Shared storefront query:
  - `packages/core/src/modules/products/products.storefront.ts:43-177`
  - Supports flat discounts in filters and effective price sorting at `72-99`
- Category-specific fork:
  - `apps/api/src/routes/categories.ts:153-368`
  - `hasDiscount=true` only checks `discountPercentage > 0` at `233-239`
  - Price sort only accounts for percentage discounts at `244-255`
  - Discount sort uses `discountPercentage` only at `260-261`
  - Final `discountedPrice` calculation ignores flat discounts at `346-348`
- Live storefront category pages consume this forked endpoint via:
  - `apps/storefront/src/pages/categories/[slug].astro:44-76`
  - `apps/storefront/src/lib/api/products.ts:138-189`

Impact:

- Category pages can disagree with search/all-products/homepage pricing and discount visibility.
- A flat-discount product can be discounted in the shared storefront listing logic but appear undiscounted on the category page.

Severity:

- Medium business-logic drift with direct shopper impact.

#### 5. Search filters are generated from the categories of matching products, not from the matching products themselves

Why this matters:

- Search facets should reflect the actual current result set.
- The current route expands outward from matching products to every active product in those categories.
- That means the filter UI can show attribute values that do not exist in the search results the shopper is viewing.

Evidence:

- Search page requests search-scoped facets at `apps/storefront/src/pages/search/index.astro:52-58`.
- The storefront API wrapper hits `/attributes/search-filters` at `apps/storefront/src/lib/api/attributes.ts:43-52`.
- The route finds `matchingProducts` at `apps/api/src/routes/attributes.ts:180-185`.
- It then extracts `categoryIds` from those matches at `191-192`.
- It broadens the facet query to all active products in those categories at `194-219`.
- A better product-scoped helper already exists and is unused here: `packages/core/src/modules/attributes/attributes.public.ts:107-136`.

Impact:

- Facet counts/values are over-broad and confusing.
- Search UX can suggest impossible refinements, especially in categories with diverse attribute vocabularies.

Severity:

- Medium search/read-model bug.

#### 6. Homepage collection resolution has unstable ordering and can disagree with the single-collection resolver

Why this matters:

- The homepage uses `resolveCollectionProductsBatch()`.
- The public collection endpoint uses `resolveCollectionProducts()`.
- The two paths do not enforce the same ordering rules for category-based collections.

Evidence:

- Homepage path uses the batch resolver in `packages/core/src/modules/storefront/storefront.service.ts:146-149`.
- The single resolver orders category-based products by `createdAt DESC` at `packages/core/src/modules/collections/collections.service.ts:338-348`.
- The batch resolver's category-product query has no `orderBy` at `packages/core/src/modules/collections/collections.service.ts:421-427`.
- The public collection endpoint consumes the single resolver at `apps/api/src/routes/collections.ts:164-165`.

Impact:

- Category-driven homepage collections can display product order that is effectively DB-order dependent.
- The same logical collection can resolve differently across endpoints.

Severity:

- Medium consistency/maintainability bug.

#### 7. Media deletion has no reference safety, so deleting a file can silently break products, categories, pages, and widgets that still point at its URL

Why this matters:

- Media is modeled as uploaded asset rows, but most catalog/content modules store plain URLs, not media references.
- `deleteMediaFile()` removes the media DB record and deletes the R2 object without any usage check.

Evidence:

- Media deletion is unconditional at `packages/core/src/modules/media/media.service.ts:205-213`.
- Product images persist direct URLs into `productImages.url` at `packages/core/src/modules/products/products.admin.ts:449-459` and `572-580`.
- Categories persist `imageUrl` directly at `packages/core/src/modules/categories/categories.service.ts:193-204`.
- Pages accept arbitrary `content` HTML at `packages/core/src/modules/pages/pages.validation.ts:8-21`.
- Widgets accept arbitrary `htmlContent`/`cssContent` at `packages/core/src/modules/widgets/widgets.validation.ts:9-25`.

Impact:

- A media cleanup action can create broken catalog images or dead embedded assets with no pre-delete warning.
- There is no path today to answer “what uses this asset?” before removal.

Severity:

- Medium operational/content integrity risk.

## Complexity Notes

- The storefront read model is split across shared services and route-local forks. The clearest duplication is the category products route versus `getStorefrontProducts()`.
- The consolidated storefront endpoints are convenient, but they also create a second public-read path that can bypass safer module-level helpers if not kept aligned.
- Navigation fallback logic is duplicated between `packages/core/src/modules/navigation/navigation.service.ts:223-259` and `packages/core/src/modules/storefront/storefront.service.ts:196-200` plus its inline fallback block below that section. That duplication increases drift risk.
- Raw HTML is a first-class content primitive in this domain. That is manageable only if every public render path consistently sanitizes or clearly treats the source as trusted.
- Cache invalidation is modeled as a separate subsystem instead of part of the write transaction path. That keeps writes simple but makes correctness depend on external discipline.

## Prioritized Follow-Ups

1. Fix homepage widget rendering first. Reuse the sanitized widget service path inside the consolidated homepage service, or sanitize there before returning widget payloads.
2. Make storefront invalidation part of the successful write path for products, categories, collections, pages, widgets, and navigation. The current manual cache route should become a lower-level utility, not the primary safety mechanism.
3. Define page publication semantics explicitly:
   - `isPublished && (publishedAt is null or publishedAt <= now)` for public reads
   - Set or clear `publishedAt` consistently on publish/unpublish actions
   - Apply the same rule to page lookups, navigation fallback, layout fallback, and sitemap generation
4. Delete the category-products route fork by delegating to `getStorefrontProducts()` with a resolved category ID, or extract a shared helper used by both endpoints.
5. Rebuild search facets from the actual matching product IDs using `getPublicAttributesByProductIds()`.
6. Normalize collection ordering rules so homepage, collection API, and any future collection page all resolve the same product order.
7. Add media usage tracking or at least a pre-delete usage audit for product images, category images, widget HTML, and page content before hard deletion.
