# Agent Widget Rendering Placement Audit

Date: 2026-05-13

Scope: storefront widget save, placement resolution, cache invalidation, page/slug matching, rendering CSS, and fallback behavior. This is a read-only application-code audit; only this report was written.

## Executive Summary

The canonical placement system is mostly wired correctly. Admin saves `placements[]`; the API persists rows in `widget_placements`; storefront pages resolve the current entity ID and then render matching placement zones. For normal active page/product/category/collection placements, the expected path is sound.

The highest-probability causes for the reported symptoms are:

1. Persisted generated CSS still contains valid but bad layout rules such as root `min-height`, large padding, full viewport sections, fixed heights, or section-specific margins. The security sanitizers intentionally keep these valid CSS properties, so cache purge alone cannot repair a saved broken widget.
2. Homepage collection-anchored placements only render inside the `activeCollections.map()` loop. If the anchor collection is active but resolves to zero products, the collection is omitted from homepage render data and its `before_collection` / `after_collection` widget has no zone to render into.
3. Storefront cache invalidation depends on a successful purge to the customer-facing hostname. Admin widget saves await `purgeStorefrontForGroups()`, but the result is discarded; missing or wrong `PURGE_URL` / `PURGE_TOKEN` can leave old HTML/data live with no admin-facing warning.
4. Placement visibility depends on live target filters. Page placements must reference published, non-deleted pages; product placements require active products; collection anchors require active collections. This is correct but easy to mistake for a rendering failure.
5. Generated content may look like it disappeared when the sanitizer strips unsupported HTML, drops invalid CSS wholesale, or scopes selectors away from the Astro wrapper.

## Current Data Path

### Admin Save

- `apps/admin-v2/src/components/admin/widgets/WidgetForm.tsx`
  - `placementsForForm()` normalizes DB rows for the form.
  - `legacyProjectionFromPlacements()` keeps old homepage columns in sync for the first active homepage placement.
  - `onSubmit()` sends `placements`, `htmlContent`, `cssContent`, and `aiContext` through `createWidget()` / `updateWidget()`.
- `apps/admin-v2/src/components/admin/widgets/widget-form/WidgetPlacement.tsx`
  - Adds placement rows, resets incompatible `scopeId` / `anchorId` when scope/slot changes, and toggles per-placement active state.
- `apps/admin-v2/src/lib/form-schemas.ts`
  - Validates required scoped `scopeId`, homepage `scopeId` absence, collection anchor requirements, valid slot/scope pairs, and duplicate placement identities.
- `packages/core/src/modules/widgets/widgets.service.ts`
  - `createWidget()` and `updateWidget()` validate references, sanitize HTML/CSS, and insert/delete/reinsert canonical `widgetPlacements`.
  - `validatePlacementReferences()` requires page targets to be published, product targets active, collections active, and anchors valid.

### Public Fetch And Placement

- `packages/core/src/modules/storefront/storefront.service.ts`
  - `getHomepageData()` fetches active homepage widgets and active collections.
  - `getPageRenderData()` resolves page by slug, then fetches widgets by `scope=page` and `scopeId=page.id`.
- `packages/core/src/modules/widgets/widgets.service.ts`
  - `getActiveWidgetPlacements()` joins `widget_placements` to `widgets`, filters active/non-deleted rows, applies `renderableWidgetPlacementCondition()`, and returns one public widget per matching placement.
- `apps/api/src/routes/widgets.ts`
  - `/widgets/active/homepage` and `/widgets/active/scope/{scope}` expose active widgets to the storefront and set `Cache-Control: no-store`.
- `apps/storefront/src/lib/api/widgets.ts`
  - Storefront still wraps those responses in `withEdgeCache()` using keys like `widgets_scope_page_{pageId}`.

### Storefront Render

- `apps/storefront/src/pages/[slug].astro`
  - Validates slug format, fetches consolidated page render data, then renders zones using `page.id`.
  - Fallback calls `getActiveWidgetsForScope("page", page.id)` only if the consolidated response contains no live page placement.
- `apps/storefront/src/components/WidgetPlacementZone.astro`
  - Calls `getWidgetsForZone()` and renders only non-empty zones.
- `apps/storefront/src/lib/widget-placements.ts`
  - Requires placement `scope`, `slot`, optional `scopeId`, and optional `anchorId` to match the zone exactly.
- `apps/storefront/src/components/WidgetBlock.astro`
  - Prepares and injects sanitized/scoped CSS and sanitized HTML inside `.widget-container.cms-widget-frame.sw-{widgetId}`.
- `apps/storefront/src/lib/widget-content.ts`
  - Strips wrappers, sanitizes HTML/CSS, optimizes image URLs, scopes CSS selectors under the widget scope class.

## Prioritized Findings

### P0: Persisted valid CSS can still create huge gaps

Likely root cause for multi-section widgets that show big blank space after save.

Relevant code:

- `apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts:42-61` defines the zero-gap guard but only guards `gap`, `margin`, and first/last margins.
- `apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts:375-408` assembles generated sections into `.widget-container > .widget-section`.
- `apps/admin-v2/src/components/admin/widgets/widget-form/useStagedGeneration.ts:641-650` skips final composition polish when the draft exceeds `36_000` characters.
- `packages/core/src/modules/widgets/widgets.service.ts:983-1011` and `1020-1073` sanitize and persist generated CSS.
- `packages/shared/src/css-sanitize.ts:32-47` parses and keeps safe CSS; it does not enforce layout quality.
- `apps/storefront/src/lib/widget-content.ts:87-92` sanitizes and scopes CSS again before rendering.

Why it happens:

- The sanitizer removes unsafe CSS, but `min-height:100vh`, `height`, large `padding-block`, large `margin`, `position:fixed`, broad `z-index`, and root section backgrounds are safe CSS and survive.
- The staged fallback wrapper now uses `gap:0`, but it cannot repair generated root sections that act like separate full-page panels.
- Final polish is optional and can be skipped on large drafts or fail, leaving stitched sections as the saved artifact.
- Existing widgets saved before zero-gap fixes keep their old CSS until the widget is edited and saved.

Concrete fixes:

- Add a widget CSS quality validator before publish/save that warns or blocks root-level `min-height: 100vh`, large fixed heights, large top/bottom margins, spacer-only blocks, and broad `.widget-container` overrides.
- Add a server/shared normalization pass for staged output that clamps root section margins and flags viewport-height roots before persistence.
- Add a maintenance script that snapshots history, scans active widgets for old staged gap CSS, and applies reviewed CSS normalization through the admin widget update route.
- Add Playwright verification that measures adjacent `.widget-section` bounding boxes at desktop and mobile widths after save.

### P1: Homepage collection-anchor widgets can have no render zone

Likely root cause when a `before_collection` or `after_collection` widget is active but does not appear on the homepage.

Relevant code:

- `packages/core/src/modules/storefront/storefront.service.ts:152` fetches homepage widgets independently.
- `packages/core/src/modules/storefront/storefront.service.ts:171-197` filters homepage collections to only those with resolved products.
- `apps/storefront/src/pages/index.astro:73-102` emits collection-anchored widget zones only while mapping `activeCollections`.
- `apps/storefront/src/lib/widget-placements.ts:31-43` requires `anchorId` to match the zone.

Why it happens:

- A widget anchored to an active collection passes widget placement validation.
- If that collection has zero resolved products, `getHomepageData()` returns no collection item for it.
- Since the homepage renders `before_collection` / `after_collection` zones only inside the returned collection loop, the widget has nowhere to mount.

Concrete fixes:

- In admin placement target UI, mark collections with no renderable homepage products as "will not render on homepage" or filter them out for homepage collection anchors.
- In `getHomepageData()`, return lightweight placeholder collection anchors for active collections with no products when widgets reference them, or expose an `orphanedAnchoredWidgets` diagnostic.
- Add a storefront/admin diagnostic endpoint that reports active collection-anchor widgets whose `anchorId` is absent from rendered homepage collections.

### P1: Storefront purge failures are not surfaced after widget saves

Likely root cause when a widget was saved correctly but old placement/content remains visible.

Relevant code:

- `apps/api/src/routes/admin/widgets.ts:103-106` invalidates all widget-related groups.
- `apps/api/src/routes/admin/widgets.ts:210-214`, `363-368`, `387-392`, `462-469` call invalidation after writes.
- `apps/api/src/utils/cache-invalidation.ts:170-176` defines `WIDGET_CACHE_GROUPS` as homepage, pages, products, categories, collections.
- `apps/api/src/utils/cache-invalidation.ts:260-285` returns `{ attempted, ok, skippedReason }`, but callers discard it.
- `apps/storefront/src/pages/api/purge-cache.ts:230-243` bumps the hostname-specific cache version only when the purge request reaches that storefront hostname.
- `apps/storefront/src/lib/edge-cache.ts:120-125` and `201-245` use hostname/build/versioned L1/L2 keys.

Why it happens:

- Widget saves clear API KV and ask the storefront to purge, but a missing/wrong `PURGE_URL`, missing `PURGE_TOKEN`, wrong hostname, or failed purge can leave old storefront L1/L2/HTML cache in place.
- The admin UI receives "Widget saved" even if the purge result was skipped or failed.

Concrete fixes:

- Have `invalidateWidgetCaches()` return the purge result and include warning metadata in admin mutation responses.
- Show a non-blocking admin warning when storefront purge is skipped or non-OK.
- Add a health check that verifies `PURGE_URL` points to the public storefront hostname and that `/api/purge-cache` bumps `v_{hostname}`.
- Add a regression test for `getStorefrontPrefixesForGroups(WIDGET_CACHE_GROUPS)` to ensure `page_render_`, `widgets_scope_`, `widget_`, `global_homepage_widgets`, and `storefront_homepage_` remain covered.

### P1: Page placements are ID-based and only render for published page targets

Likely root cause when a widget appears "placed on a page" in admin history but does not render on the storefront page.

Relevant code:

- `packages/core/src/modules/widgets/widgets.service.ts:238-310` validates page placement targets against published, non-deleted `pages`.
- `packages/core/src/modules/storefront/storefront.service.ts:209-218` resolves slug to page, then fetches widgets with `scopeId: page.id`.
- `apps/storefront/src/pages/[slug].astro:52-69` rejects invalid slugs and 404s if the public page is not found.
- `apps/storefront/src/pages/[slug].astro:71-83` falls back to scoped widget fetch only after a valid page exists.
- `apps/storefront/src/pages/[slug].astro:136-169` and later zones pass `scopeId={page.id}`.

Why it happens:

- Storefront matching does not use the page slug stored in the placement UI; it uses the resolved page ID.
- If the page is unpublished/deleted, slug validation passes but `getPublicPageBySlug()` returns null and the page route 404s before any widget zones render.
- Direct DB edits or stale admin state can leave a placement pointing at a no-longer-published page.

Concrete fixes:

- Add a widget placement diagnostics panel that displays target status: published page, active product, deleted target, missing anchor.
- Add an admin list badge for inactive/unrenderable placements, sourced from the same conditions as `renderableWidgetPlacementCondition()`.
- For support/debugging, log page ID and widget count in a protected debug endpoint rather than relying on slug guesses.

### P2: Sanitization/scoping can make generated content look blank or broken

Likely root cause for widgets that "fail to appear" even though a zone rendered.

Relevant code:

- `packages/shared/src/html-sanitize.ts:4-64` allowlists tags.
- `packages/shared/src/html-sanitize.ts:66-77` drops `script`, `style`, `iframe`, `object`, `embed`, `link`, `meta`, and `template` with content.
- `packages/shared/src/html-sanitize.ts:154-160` unwraps unknown tags.
- `packages/shared/src/css-sanitize.ts:42-47` returns an empty stylesheet when CSS parse fails.
- `packages/shared/src/css-scope.ts:32-44` scopes parseable CSS, and `47-59` returns empty CSS on parse failure.
- `packages/shared/src/css-scope.ts:243-261` rewrites selectors under `.sw-{widgetId}`.

Why it happens:

- Generated SVG icons, forms, inputs, videos, custom elements, iframes, or inline `<style>` blocks are removed or unwrapped.
- One invalid CSS parse can drop the entire stylesheet; the HTML remains but may become visually invisible if it relied on CSS for layout/background/text color.
- Generated CSS that expects to style the outer Astro wrapper can miss. For example, `.widget-container` becomes `.sw-id .widget-container`, which matches an inner generated wrapper, not the outer `.widget-container.cms-widget-frame.sw-id`.

Concrete fixes:

- Update prompts and validators to forbid unsupported tags explicitly and prefer text/lucide-equivalent CSS shapes over inline SVG.
- Add a post-sanitize preview diff in admin: show warnings when HTML tags were removed or CSS became empty after sanitization.
- Add a generated CSS convention: one unique root class inside the HTML, never `.widget-container` as the primary root selector unless the generated HTML includes that inner element.

### P2: Page template spacing can be mistaken for internal widget gaps

Relevant code:

- `apps/storefront/src/components/WidgetPlacementZone.astro:30-35` passes `itemClass` to each `WidgetBlock`.
- `apps/storefront/src/pages/[slug].astro:157-169` standalone shortcode pages have no item spacing around before/after content zones.
- `apps/storefront/src/pages/products/[slug].astro:240-246` uses `py-2` wrapper spacing for product `before_content`.
- `apps/storefront/src/styles/global.css:172-184` applies global widget width, containment, and horizontal frame padding.

Why it happens:

- Some placements deliberately add page-level margins/padding (`mb-8`, `mt-8`, `py-2`, `py-3`, etc.).
- The global widget frame adds horizontal padding to every placement widget. That is not an internal section gap, but it changes full-bleed generated designs.

Concrete fixes:

- In visual QA, separate page-level spacing from internal section gaps by measuring `.widget-placement-zone`, outer `WidgetBlock`, generated root, and `.widget-section` boxes independently.
- Consider a per-widget/full-bleed flag if generated landing sections need to opt out of `.cms-widget-frame` horizontal padding.

## Verification Checklist

For a page-scoped widget that should render at `/{slug}`:

1. Admin API: fetch `GET /api/v1/admin/widgets/{id}` and verify `isActive`, `placements[]`, `scope="page"`, `scopeId={page.id}`, `slot`, and `deletedAt=null`.
2. Public page: fetch `GET /api/v1/storefront/pages/slug/{slug}` and verify `data.page.id` equals placement `scopeId`.
3. Public widgets: fetch `GET /api/v1/widgets/active/scope/page?scopeId={page.id}` and verify the widget appears.
4. Storefront page: verify response `X-Cache-Status` version/build after a save.
5. DOM: verify `.widget-placement-zone` exists at the expected slot and contains `[data-widget-id="{id}"]`.
6. CSS: inspect scoped `<style>` for empty output, `min-height:100vh`, large margins/paddings, and `.widget-container` gap/height rules.
7. Geometry: measure adjacent `.widget-section` bottom/top deltas at mobile and desktop.
8. Sanitization: compare saved HTML/CSS with rendered HTML/CSS to catch removed tags or dropped CSS.

## Bottom Line

The placement pipeline is not obviously losing page widgets by slug. It is strict, ID-based, and live-target filtered. The biggest practical gap bugs are generated CSS quality and persisted legacy artifacts; the biggest placement miss is homepage collection anchors whose collection is not rendered. The biggest operational risk is silent storefront purge failure, because it can make a correct save look broken.
