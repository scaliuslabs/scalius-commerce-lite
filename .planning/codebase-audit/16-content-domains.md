# Audit 16 -- Content Domains (Navigation, Pages, Widgets)

## 1. Overview

Three content modules power the CMS-like layer of the platform:

| Module | Core service | Admin routes | Public routes | Admin UI |
|--------|-------------|-------------|---------------|----------|
| Navigation | `navigation.service.ts` (51 LOC) | `admin/navigation.ts` (203 LOC) | `navigation.ts` (249 LOC) | `NavigationBuilder` + `SortableNavItem` + `AddNavItemDialog` |
| Pages | `pages.service.ts` (170 LOC) | `admin/pages.ts` (298 LOC) | `pages.ts` (278 LOC) | `PageForm.tsx` (470 LOC) + `pages-list/` |
| Widgets | `widgets.service.ts` (217 LOC) | `admin/widgets.ts` (412 LOC) | `widgets.ts` (160 LOC) | `WidgetForm.tsx` (578 LOC) + `widget-list/` + AI assistant |

Database schema: `packages/database/src/schema/content.ts` -- 6 tables: `pages`, `widgets`, `widgetHistory`, `heroSections`, `heroSliders`, `pageTemplates`.

---

## 2. Navigation

### 2.1 Architecture

Navigation has **no dedicated table**. The configuration is stored as JSON blobs inside the `siteSettings` singleton row (`headerConfig` / `footerConfig` TEXT columns). This is an intentional design choice -- navigation is site-wide config, not an entity with CRUD lifecycle.

**Admin service** (`navigation.service.ts`): Fetches categories + published pages to serve as "available items" when building menus. Returns `{ categories, pages }` with pre-built URLs.

**Admin API** (`admin/navigation.ts`): Four routes:
- `GET /items` -- available nav items (categories + pages)
- `GET /` -- current header/footer config from `siteSettings`
- `POST /` -- save header or footer config (create-or-update)
- `PUT /{id}` -- update by settings ID
- `DELETE /{id}` -- reset config to empty `{}`

**Public API** (`navigation.ts`): Two routes:
- `GET /` -- returns navigation with type filter (`header`, `footer`, `all`); falls back to auto-generated nav from categories + pages when no config exists
- `GET /{id}` -- lookup by ID (`header`, `footer`, or a footer sub-menu ID)

### 2.2 Admin UI

The `NavigationBuilder` component is well-structured:
- Drag-and-drop reordering via `@hello-pangea/dnd`
- Path-based tree operations (indent/outdent/add-child/remove)
- Recursive `SortableNavItem` with depth coloring
- `AddNavItemDialog` supports 5 item types: Category, Page, Dynamic (attribute-filtered URL), Custom Link, Label

`MAX_NAV_DEPTH` = 10 levels (generous, practically 3-4 is normal).

### 2.3 Issues

**P1 -- Public navigation route uses module-level `db` singleton** (`apps/api/src/routes/navigation.ts` line 2):
```
import { db } from "@scalius/database/client";
```
All other public and admin routes use `c.get("db")` from Hono context. This singleton import was identified in a previous refactoring pass (the service accepts `db: Database` param correctly) but the public route file was missed. The route handlers inside the file use the module-level `db` directly rather than `c.get("db")`. This is inconsistent and may cause issues if the DB binding is request-scoped in production.

**P2 -- Dead endpoint reference in AddNavItemDialog**: The dialog fetches `/api/v1/admin/navigation/preview-products` (line 200) but no such route exists in the API. This call will silently 404 -- the UI shows a preview count for dynamic nav items that can never populate.

**P2 -- Storefront requests `format=nested` query param** (`storefront/src/lib/api/navigation.ts` line 20): The API route does not handle a `format` parameter at all. It is ignored harmlessly but indicates a spec mismatch.

**P2 -- Storefront requests `mobile_menu` type**: The `getNavigationData` function accepts `"mobile_menu"` but the API only handles `"header"`, `"footer"`, `"all"`. A `mobile_menu` request would fall through to the default behavior.

**P3 -- `saveConfigSchema` uses `z.record(z.string(), z.any())`**: The navigation config body is effectively unvalidated. Any JSON structure is accepted for header/footer config. This is intentional flexibility but means invalid structures could be saved that break the storefront parser.

**P3 -- DELETE route has a body**: `DELETE /{id}` requires `{ type: "header" | "footer" }` in the request body. While functional, DELETE with a body is unusual and some HTTP clients/proxies may strip it.

---

## 3. Pages

### 3.1 Architecture

**Schema**: `pages` table with standard fields: `id`, `title`, `slug` (indexed), `content` (TEXT -- stores HTML from TipTap), `metaTitle`, `metaDescription`, `isPublished`, `hideHeader`, `hideFooter`, `hideTitle`, `publishedAt`, `sortOrder`, soft-delete via `deletedAt`.

**Service** (`pages.service.ts`): Clean CRUD with:
- `listPages` -- pagination, FTS5 search, sort, trash filter
- `getPageById` / `getPageBySlug` -- simple lookups
- `createPage` / `updatePage` -- with slug uniqueness check
- `deletePage` / `bulkDeletePages` / `bulkPublishPages` / `bulkUnpublishPages` / `restorePages`

**Validation** (`pages.validation.ts`): Zod schemas with slug regex validation (`^[a-z0-9]+(?:-[a-z0-9]+)*$`).

**Admin API** (`admin/pages.ts`): Full CRUD + bulk operations + restore + permanent delete. Well-structured, uses `ok()`/`created()`/`noContent()` helpers.

**Public API** (`pages.ts`): Three routes:
- `GET /` -- paginated list with `publishedOnly` filter
- `GET /slug/{slug}` -- lookup by slug (published + non-deleted only)
- `GET /{id}` -- lookup by ID (non-deleted, no publish check)

### 3.2 Admin UI

`PageForm.tsx` is a single-file React component:
- TipTap rich text editor (lazy-loaded)
- Auto-slug generation from title
- SEO fields with character counters in a collapsible card
- Display toggles (hideHeader/hideFooter/hideTitle)
- Published status toggle
- Sort order field
- "View on Storefront" link for edit mode
- Uses `FormStickyHeader` for consistent save UX

### 3.3 Storefront Rendering

`[slug].astro` performs thorough slug validation before API calls:
- Rejects empty, file extensions, known system paths, invalid formats
- Parallel fetches layout + page data
- Processes shortcodes (`[widget id="..."]`, `[product slug="..."]`)
- Renders via `RichContent.astro` with Tailwind typography prose classes
- Supports product shortcode hydration scripts

### 3.4 Issues

**P2 -- Public page-by-ID route has no publish check** (`pages.ts` line 240-266): `GET /pages/{id}` only checks `isNull(pages.deletedAt)` but NOT `isPublished`. This means unpublished pages are accessible via direct ID lookup on the public API. The slug route correctly checks publish status. If the storefront or any public consumer uses the ID route, draft pages leak.

**P2 -- `publishedAt` field stored but never meaningfully used**: The schema has `publishedAt` (timestamp mode), the validation transforms it, the form sets it on publish -- but no query ever uses it for scheduling. There is no "publish at a future date" behavior. The field is written but never read in any conditional logic.

**P3 -- `listPages` service duplicates the public routes query logic**: The admin service has `listPages` with pagination, but the public `GET /pages` route rebuilds its own query from scratch instead of reusing `listPages` with a `publishedOnly` option. Two independent implementations of the same pagination pattern.

**P3 -- Admin create route catches `ConflictError` as generic**: The `createPage` admin handler (line 76-83) catches all errors and re-throws as `ApiError(400)`, losing the 409 status code that `ConflictError` would provide. The `updatePage` handler has the same issue. The service correctly throws `ConflictError` (which has `statusCode: 409`) but the route handler overrides it.

---

## 4. Widgets

### 4.1 Architecture

**Schema**: `widgets` table stores raw HTML/CSS content blocks:
- `htmlContent` (TEXT, required) -- the HTML body
- `cssContent` (TEXT, optional) -- scoped CSS
- `aiContext` (TEXT, optional) -- JSON blob with AI generation metadata
- `displayTarget` (enum: `"homepage"` only currently)
- `placementRule` (enum: 5 values -- `before_collection`, `after_collection`, `fixed_top_homepage`, `fixed_bottom_homepage`, `standalone`)
- `referenceCollectionId` (FK to collections, nullable)
- `sortOrder`, soft-delete, timestamps

`widgetHistory` table tracks version snapshots: `widgetId`, `htmlContent`, `cssContent`, `reason`, `createdAt`. Cascading delete from parent widget.

**Service** (`widgets.service.ts`): Standard CRUD plus:
- `listWidgets` -- also fetches `availableCollections` for the form
- History: `createHistoryEntry`, `getWidgetHistory`, `restoreFromHistory` (auto-snapshots before restore), `deleteHistoryEntry`

**Validation**: Base schema with `.refine()` on create (requires `referenceCollectionId` for `BEFORE_COLLECTION`/`AFTER_COLLECTION` rules). Update schema is `.partial()` without the refinement -- correct pattern to avoid issues with partial updates.

### 4.2 Admin API

Full CRUD + bulk operations + toggle status + complete history CRUD:
- `GET/POST/PUT/DELETE /{id}` -- standard
- `POST /bulk-delete`, `/bulk-activate`, `/bulk-deactivate`, `/bulk-restore`
- `PATCH /{id}/toggle-status`
- `GET /{id}/history`, `POST /{id}/history`, `POST /{id}/history/restore`, `DELETE /{id}/history/{versionId}`

### 4.3 Admin UI

`WidgetForm.tsx` is the most complex content form:
- Raw HTML/CSS textarea editing
- AI generation system: `useAiGenerator`, `useAiImprover`, `useAiContext` hooks
- Staged generation with section-by-section improvement
- Full-screen editor/preview with multiple modes
- Version history modal with restore/delete
- Paste modal for importing AI-generated content
- AI context persistence (saved images, products, categories, improvement history)
- Placement rule picker with conditional collection selector
- Active toggle and sort order

`widget-list/` provides the list view with:
- Statistics (total/active/inactive)
- Bulk actions
- Trash view
- Table with toggle, delete, and row actions

### 4.4 Storefront Rendering

Widgets render in two contexts:

1. **Homepage** (`index.astro`): Widgets are fetched via `getActiveHomepageWidgets()` and sorted into 4 buckets by placement rule. They render as raw `set:html` with CSS injected via `<style>` tags:
```astro
{widget.cssContent && <style set:html={widget.cssContent} />}
<div set:html={widget.htmlContent} />
```

2. **Shortcodes** (`shortcodes.ts`): `[widget id="..."]` syntax in page content fetches widget by ID and injects HTML+CSS inline.

### 4.5 Issues

**P1 -- No CSS scoping on widget output**: Widget CSS is injected as global `<style>` tags. If two widgets have conflicting selectors (e.g., `.banner { color: red }` and `.banner { color: blue }`), they will clash. On the homepage with multiple widgets, this is a real risk. The shortcode renderer does add a `data-widget-id` attribute but the CSS itself is not scoped to that attribute.

**P2 -- Public widget-by-ID route only returns active widgets** (`widgets.ts` line 96-98): The `GET /widgets/{id}` public route filters `eq(widgets.isActive, true)`. This means shortcodes referencing a deactivated widget will silently fail, showing an error message. This is arguably correct behavior, but the admin should be aware that deactivating a widget also breaks any shortcode references to it in page content.

**P2 -- `displayTarget` is hardcoded to `"homepage"` only**: The schema enum, validation, and queries all assume `homepage` is the only display target. There is no mechanism for widgets on other pages. The `STANDALONE` placement rule exists (for shortcodes) but it still requires `displayTarget: "homepage"`. This is semantically confusing -- a standalone widget embedded via shortcode on a non-homepage page must still have `displayTarget: "homepage"`.

**P2 -- Timestamp conversion duplication**: The public `widgets.ts` route has a 28-line `convertTimestampToISO` function that handles unix-to-ISO conversion with multiple type guards. This same pattern exists in the admin loader (`loaders/admin/widgets.ts`). Both exist because the DB stores integer timestamps but consumers expect different formats. Should be centralized in `@scalius/shared`.

**P3 -- `aiContext` uses `z.any()` in validation**: The AI context field accepts any value. While intentional (it is a flexible JSON blob), there is a typed schema (`AiContext` from `@scalius/core/modules/ai/ai-context-schema`) that could be used for at least structural validation.

**P3 -- Widget history has no auto-snapshot on update**: The `updateWidget` service function does not automatically create a history entry. History is only created manually (via `POST /{id}/history`) or automatically before a restore. This means a user could overwrite widget content with no history unless they explicitly save a version first.

---

## 5. Content Model Analysis

### 5.1 Storage Patterns

| Content type | Storage | Format |
|-------------|---------|--------|
| Page content | `pages.content` TEXT | HTML (from TipTap editor) |
| Widget HTML | `widgets.htmlContent` TEXT | Raw HTML |
| Widget CSS | `widgets.cssContent` TEXT | Raw CSS |
| Widget AI context | `widgets.aiContext` TEXT | JSON blob |
| Header nav config | `siteSettings.headerConfig` TEXT | JSON (recursive NavigationItem[]) |
| Footer nav config | `siteSettings.footerConfig` TEXT | JSON (menus with links) |
| Hero config | `heroSections.config` TEXT | JSON |
| Hero images | `heroSliders.images` TEXT | JSON |
| Page templates | `pageTemplates.config` TEXT | JSON |

All content is stored as TEXT in SQLite. JSON parsing happens at the route/service level with no schema validation on read (parse errors would throw at runtime).

### 5.2 Unused Schema Tables

`heroSections`, `heroSliders`, and `pageTemplates` are defined in `content.ts` and have routes in `apps/api/src/routes/hero.ts` and `apps/api/src/routes/admin/settings/hero-sliders.ts`, but they are outside the scope of this audit. They are referenced for completeness.

---

## 6. Cross-Cutting Concerns

### 6.1 Caching

All public content routes apply `cacheMiddleware` with `ttl: 3600` (1 hour):
- Navigation: `api:navigation:*`
- Pages: `api:pages:*`
- Widgets: `api:widgets:active-homepage:*` and `api:widgets:single:*`

Admin navigation save/update/delete calls `invalidateSiteSettingsCache(getKv())`. Pages and widgets do NOT trigger cache invalidation after admin mutations. This means storefront content updates take up to 1 hour to reflect unless the purge-cache endpoint is called manually.

### 6.2 Edge Caching (Storefront)

The storefront wraps all content fetches with `withEdgeCache`:
- Navigation: `CACHE_TTL.LONG`
- Pages: `CACHE_TTL.LONG`
- Widgets: `CACHE_TTL.LONG`

All use the same long TTL. Invalidation happens via purge-cache endpoint.

### 6.3 Shortcode System

The shortcode processor in `apps/storefront/src/lib/shortcodes.ts` supports:
- `[widget id="..."]` -- fetches and renders a widget inline
- `[product slug="..."]` -- fetches and renders a product card inline

Shortcodes are processed in `RichContent.astro` and in `[slug].astro`. The `RichContent` component also does responsive image rewriting for Cloudflare Image Resizing URLs.

---

## 7. LLM-Friendliness Assessment

**Strengths**:
- Clean service layer separation -- each module has validation, service, and index files
- Consistent barrel exports via `index.ts`
- Well-documented widget form (`WidgetForm.tsx` header comment explains the architecture)
- `NavigationItem` type is consistent across admin and storefront (recursive `subMenu`)
- Clear enum for widget placement rules

**Weaknesses**:
- Navigation has no dedicated service for config CRUD -- logic is inline in the admin route file
- Three separate `NavigationItem` type definitions (admin `types.ts`, storefront `types.ts`, API route inline interface) that are structurally identical but not shared
- Widget `aiContext` is opaque `z.any()` at the API boundary -- an LLM reading the validation schema cannot infer the structure
- Public routes (`navigation.ts`, `pages.ts`, `widgets.ts`) duplicate logic from the core service rather than reusing it
- `displayTarget` being locked to `"homepage"` creates confusion about standalone widgets

---

## 8. Summary of Issues by Priority

### P1 (Fix Soon)
1. **Public navigation route uses module-level `db` singleton** instead of `c.get("db")` -- inconsistent with all other routes and potentially broken in production if DB is request-scoped.
2. **No CSS scoping on storefront widget output** -- multiple widgets can have conflicting global styles.

### P2 (Fix When Touching)
3. **Dead `preview-products` endpoint** referenced in AddNavItemDialog -- preview count UI never works.
4. **Storefront sends `format=nested` and `mobile_menu`** parameters the API does not handle.
5. **Public `GET /pages/{id}` does not check `isPublished`** -- draft pages are accessible.
6. **`publishedAt` field is stored but never used** for scheduling or display.
7. **Admin page create/update routes swallow `ConflictError`** status code.
8. **`displayTarget` locked to `"homepage"`** creates semantic confusion for standalone widgets.
9. **Timestamp conversion logic duplicated** across public routes and admin loaders.

### P3 (Track)
10. **Navigation config body is unvalidated** (`z.any()` passthrough).
11. **Public page list duplicates** the admin service pagination logic.
12. **Widget `aiContext` accepts `z.any()`** despite a typed schema existing.
13. **No auto-snapshot on widget update** -- history is manual-only.
14. **DELETE navigation route uses request body** (unconventional HTTP pattern).
15. **Page/widget admin mutations do not invalidate API cache** (navigation does).
