# Storefront Widget Rendering And Cache Audit

Date: 2026-05-13

Scope: active widget fetching, sanitization, caching, invalidation, and Astro rendering on the storefront. This audit is based on current implementation only.

## Executive Summary

The storefront widget pipeline is generally well separated:

1. Admin widget mutations sanitize content before persistence.
2. Public widget reads sanitize again before API responses.
3. Storefront rendering normalizes, sanitizes, optimizes image URLs, scopes CSS, and injects the widget inside an Astro wrapper.
4. Widget placement queries are centralized in `packages/core/src/modules/widgets/widgets.service.ts`.
5. Storefront cache invalidation is intended to clear API KV data and bump the storefront HTML/data cache version after every admin widget mutation.

The main reason an old generated widget with visible section gaps can persist is not only cache. The generated CSS is stored as widget data. If an old widget was saved with `.widget-container { gap: ... }`, the sanitizers and renderer preserve that valid CSS. After a correct purge, the storefront will still render the old gap because the database still contains it. Cache can make this worse by continuing to serve the old HTML/data when purge configuration, hostname targeting, or version bumping fails.

## Fetch Flow

### Homepage

`apps/storefront/src/pages/index.astro` calls `loadPageWithLayout(() => getHomepageData())`.

The storefront helper `apps/storefront/src/lib/api/storefront.ts` calls `GET /api/v1/storefront/homepage` and caches the shaped response with key `storefront_homepage_${BUILD_ID}` via `withEdgeCache`.

The API route `apps/api/src/routes/storefront.ts` calls `getHomepageData(db)` in `packages/core/src/modules/storefront/storefront.service.ts`.

`getHomepageData(db)` calls `getActiveHomepageWidgets(db)`, which delegates to `getActiveWidgetPlacements(db, { scope: homepage })`.

### CMS Pages

`apps/storefront/src/pages/[slug].astro` calls `getPageRenderData(slug)`, which calls `GET /api/v1/storefront/pages/slug/{slug}` and caches the result with key `page_render_${slug}_${BUILD_ID}`.

The API route calls `getPageRenderData(db, slug)` in `packages/core/src/modules/storefront/storefront.service.ts`, which loads the published page and page-scoped active widgets through `getActiveWidgetPlacements(db, { scope: page, scopeId: page.id })`.

There is a safety fallback in `[slug].astro`: if consolidated page render data does not include a live page placement, it calls `getActiveWidgetsForScope("page", page.id)`.

### Product, Category, Collection Pages

Product, category, and collection pages call `getActiveWidgetsForScope(scope, scopeId)` directly from `apps/storefront/src/lib/api/widgets.ts`.

That helper calls `GET /api/v1/widgets/active/scope/{scope}?scopeId=...` and caches with key `widgets_scope_${scope}_${scopeId}`.

### Shortcodes

`apps/storefront/src/lib/shortcodes.ts` resolves `[widget id="..."]` by calling `getWidgetById(widgetId)`, which calls `GET /api/v1/widgets/{id}` and caches with key `widget_${widgetId}`.

Shortcode rendering uses the same `prepareWidgetContent()` sanitizer/scope path as placement rendering, but wraps the result in a shortcode-specific frame with `data-widget-id`.

## Sanitization And CSS Isolation

### Persistence Layer

`createWidget()`, `updateWidget()`, and `createHistoryEntry()` sanitize widget HTML/CSS before writing:

- HTML: `sanitizeWidgetHtml()` -> `sanitizeHtml()`.
- CSS: `sanitizeWidgetCss()` -> `sanitizeCssForStyleElement()`.

This means stored widget content is already stripped of dangerous tags, event handlers, unsafe protocols, and invalid/dangerous stylesheet content.

### Public API Layer

`toPublicWidget()` re-sanitizes `htmlContent` and `cssContent` before returning active widgets to the storefront. Active public reads also filter deleted/inactive widgets and placements.

### Storefront Render Layer

`apps/storefront/src/lib/widget-content.ts` prepares content before Astro injection:

- strips code fences and `<htmljs>`, `<html>`, `<css>` wrappers;
- sanitizes HTML again;
- optimizes rich-content image URLs;
- sanitizes CSS again;
- optimizes CSS image URLs;
- scopes CSS with `scopeCss(css, scopeClass)`.

`apps/storefront/src/components/WidgetBlock.astro` renders:

```astro
<div class:list={["widget-container cms-widget-frame", scopeClass, className]}>
  {css && <style set:html={css} />}
  <div set:html={html} />
</div>
```

### Isolation Strengths

- Dangerous tags such as `script`, `style`, `iframe`, `object`, `embed`, `link`, and `meta` are dropped by the HTML sanitizer.
- Event handler attributes are removed.
- CSS is parser-backed and strips unsafe URL protocols, `expression()`, script/style tags, raw HTML, comments, unsupported at-rules, and binding/behavior properties.
- `scopeCss()` prefixes selectors under a per-widget class such as `.sw-wid-...`.
- Keyframes are namespaced per widget and animation declarations are rewritten.
- `html`, `body`, `:root`, and `*` selectors are remapped to the widget scope instead of remaining global.

### CSS Isolation Risks

- Valid but poor layout CSS is intentionally preserved. For example, `.widget-container { gap: clamp(...) }`, large `margin`, `min-height`, `position: fixed`, high `z-index`, or oversized padding are not security issues, so sanitization keeps them.
- Inline `style` attributes are allowed after CSS value sanitization. They can still create storefront UX problems such as oversized spacing or fixed-position overlays.
- The renderer scopes generated CSS by prefixing selectors. If generated CSS expects `.widget-container` and the generated HTML does not include an inner `.widget-container`, the selector becomes `.sw-id .widget-container` and will not match the outer Astro wrapper, because the outer wrapper itself has both classes.
- IDs are preserved by the sanitizer. Duplicate IDs across multiple widgets are possible. With current script stripping this is mostly a CSS/anchor/querying risk, not an executable-code risk.
- If CSS parsing fails, the sanitizer/scope path can drop the whole stylesheet. This is safer than leaking global CSS, but production verification should catch visually blank or unstyled widgets.

## Placement And Rendering Behavior

`apps/storefront/src/components/WidgetPlacementZone.astro` filters widgets for a specific zone using `getWidgetsForZone()` and sorts by slot, anchor, sort order, name, then widget id.

Homepage placement zones:

- `top`
- `before_collection`
- `after_collection`
- `bottom`

Content placement zones for pages/products/categories/collections:

- `top`
- `before_content`
- `after_content`
- `bottom`

Some page templates intentionally add wrapper spacing with `itemClass`, for example:

- CMS non-standalone page: `before_content` uses `mb-8`, `after_content` uses `mt-8`.
- Product/category/collection templates use `py-2` or `py-3` around content-adjacent widget placements.
- Homepage collection-adjacent widgets use `mb-2` and `mt-2`.

These page-level classes can create spacing around a widget, but they do not explain large gaps between sections inside a generated widget. Internal section gaps usually come from saved widget CSS or generated HTML structure.

## Cache Layers

### API Worker KV Cache

`apps/api/src/middleware/cache.ts` caches selected API responses in the API worker KV namespace using `apps/api/src/utils/kv-cache.ts`.

The public single-widget route `/api/v1/widgets/{id}` uses this middleware with key prefix `api:widgets:single:`. Active homepage/scoped widget list routes set `Cache-Control: no-store, max-age=0`, so they are not stored by the API route cache.

### Storefront Data Cache

`apps/storefront/src/lib/edge-cache.ts` provides a two-layer storefront cache:

- L1: `smartCache`, an in-memory LRU map per warm worker isolate.
- L2: Cloudflare Cache API.

Keys include:

- logical key, such as `page_render_testing-page_${BUILD_ID}`;
- hostname;
- `BUILD_ID`;
- KV cache version from `CACHE_CONTROL` key `v_${hostname}`.

Widget-related storefront keys include:

- `storefront_homepage_${BUILD_ID}`
- `global_homepage_widgets`
- `widgets_scope_${scope}_${scopeId}`
- `widget_${widgetId}`
- `page_render_${slug}_${BUILD_ID}`

### Storefront HTML Cache

`apps/storefront/src/middleware.ts` also caches full HTML responses for cacheable paths including `/`, `/products/{slug}`, `/categories/{slug}`, `/search`, sitemaps, and clean CMS page slugs.

The browser receives aggressive no-store/no-cache headers, but the Cloudflare Cache API stores the internal response with `public, max-age=31536000, immutable`. Freshness is controlled by `cache_v=${KV_VERSION}-${BUILD_ID}`.

This means stale rendered widget HTML can persist if the KV version for the exact storefront hostname is not bumped.

## Invalidation Flow

Admin widget mutations in `apps/api/src/routes/admin/widgets.ts` call `invalidateWidgetCaches()` after create/update/delete/restore/toggle/bulk operations and history restore.

`invalidateWidgetCaches()` does two things:

1. `invalidateGroups([...WIDGET_CACHE_GROUPS], env.CACHE)` clears API KV prefixes.
2. `purgeStorefrontForGroups([...WIDGET_CACHE_GROUPS], env)` calls the storefront purge endpoint and awaits it.

`WIDGET_CACHE_GROUPS` includes homepage, pages, products, categories, and collections. Combined storefront purge prefixes therefore include homepage data, page render data, direct widget data, and scoped widget data.

The storefront purge endpoint `apps/storefront/src/pages/api/purge-cache.ts`:

- validates `PURGE_TOKEN`;
- optionally bumps `CACHE_CONTROL` key `v_${hostname}`;
- clears L1 cache by prefixes on the worker isolate that receives the purge;
- warms `/` in the background when HTML version is bumped.

For widget updates, `bumpVersion` should be true because the selected groups include HTML-rendered content.

## Why Old Gap CSS Can Persist

1. **The old gap is valid stored widget data.** If a widget was saved with `.widget-container { gap: clamp(...) }` or mobile gap overrides, all sanitizers preserve it. A purge reloads the same saved CSS.

2. **Old generated artifacts are not automatically migrated.** New generation logic can produce zero-gap compositions for future widgets, but it does not rewrite existing `widgets.cssContent`.

3. **Full-page HTML cache can serve old rendered markup.** Even when API data changes, the storefront HTML cache can keep a rendered page until the hostname-specific KV version is bumped.

4. **Storefront data cache can serve old widget payloads.** `page_render_*`, `widgets_scope_*`, `widget_*`, and `storefront_homepage_*` entries can hold old payloads until the KV version changes or the entry expires.

5. **Purge correctness depends on production env.** If `PURGE_URL` points to the wrong hostname, or `PURGE_TOKEN`/`CACHE_CONTROL` are missing, the admin mutation can succeed while storefront cache remains stale.

6. **Direct DB edits bypass invalidation.** Any manual data change outside admin widget routes will not call `invalidateWidgetCaches()`.

7. **History creation does not invalidate.** This is correct because it does not change rendered widget content. History restore does invalidate.

8. **Page-level spacing can be mistaken for widget gaps.** Some placement zones add `itemClass` margins/padding around the widget. Internal gaps between generated sections should be checked separately from wrapper/page spacing.

## Cache Risks

- Storefront L2 cache entries are not physically deleted. They are abandoned by changing the KV version. If the version does not bump for the actual hostname being visited, stale entries remain live.
- `clearL1ByPrefixes()` only clears the isolate that receives `/api/purge-cache`. Versioned keys protect other isolates only when `bumpVersion` succeeds.
- Cache version is hostname-specific. Production must purge `storefront.scalius.com` if that is the hostname customers visit. Purging a dashboard/admin hostname would not invalidate storefront HTML/data keys.
- The API invalidation prefix `api:widgets:active-homepage:` appears to be mostly historical/no-op because active homepage widgets are served through no-store routes and consolidated storefront data now drives homepage rendering.
- If `purgeStorefrontForGroups()` returns a non-OK response, admin widget routes currently log through helper behavior but do not expose a merchant-facing "storefront purge failed" state in the widget UI.
- A full HTML cache HIT can hide successful API changes. Production verification must inspect both API payloads and rendered storefront HTML.

## Production Verification Checklist

For a widget placed on `/testing-page`:

1. In the admin API, fetch the widget and verify `cssContent` does not contain old section gap rules such as `gap: clamp(...)`, `gap: 1rem`, or mobile `.widget-container` gap overrides.
2. Fetch `GET /api/v1/widgets/active/scope/page?scopeId={pageId}` and verify the widget appears with the expected active placement and current CSS.
3. Save/update the widget through the admin widget route, not by direct DB edit, so invalidation runs.
4. Confirm the storefront purge endpoint returns success and reports `htmlVersionBumped: true`.
5. Load the storefront page with `Cache-Control: no-cache` and inspect response headers:
   - `X-Cache-Status` should show the current version/build.
   - A second request may be HIT, but it must be a HIT for the new version.
6. Inspect rendered DOM for the widget scope class `sw-{widgetId}` and the expected inner `.widget-container`.
7. Use computed styles to verify the internal generated `.widget-container` gap is `0px`.
8. Measure adjacent `.widget-section` bounding boxes to confirm no unintended blank vertical gap.
9. Search the rendered HTML/CSS response for old gap strings.
10. Check browser console/page errors and horizontal overflow.
11. Repeat at desktop and mobile widths.
12. Verify top, before-content, after-content, and bottom slots separately because page templates add different wrapper spacing.

## Concrete Next Steps

1. Repair stale generated widget artifacts by creating a history snapshot, then saving updated widget CSS through the admin widget update route. Do not rely on cache purge alone when the persisted CSS still contains old gap declarations.
2. Add `data-widget-id={widget.id}` to placement-rendered `WidgetBlock.astro` in a future source change. Shortcodes already have it; placement widgets do not. This will make production verification and support debugging much easier.
3. Add an admin-side "rendered CSS audit" before publish/save that warns when generated CSS contains root container gaps, large root margins, root `min-height`, `position: fixed`, or broad reset selectors.
4. Add a production smoke script that logs in, updates a test widget, verifies purge success, loads the target storefront page, checks `X-Cache-Status`, checks computed section gap, and captures desktop/mobile screenshots.
5. Add regression tests for `WIDGET_CACHE_GROUPS` to ensure widget mutations always purge `page_render_`, `widgets_scope_`, `widget_`, and `storefront_homepage_` prefixes and always bump HTML.
6. Consider a migration/maintenance utility that scans active widgets for old staged-generator wrapper CSS and offers a safe admin-reviewed normalization patch with history snapshots.
7. Consider stricter UX-level CSS validation for generated widgets. Security sanitization is good, but it does not prevent aesthetically broken valid CSS.
8. Surface purge failures in the widget admin UI after save/update, because a successful DB write with failed storefront purge is operationally misleading.

