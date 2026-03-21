# Pages

CMS page management with TipTap rich text editing, publish/unpublish workflow, SEO metadata, shortcode processing, public query functions, and bulk operations.

## Content System

Pages use a TipTap rich text editor in the admin (lazy-loaded via `React.lazy`). The `content` field stores HTML output from TipTap. On the storefront, content is rendered through `RichContent.astro` with Tailwind prose styling.

### Shortcode Processing

Page content supports embedded shortcodes processed at render time by `apps/storefront/src/lib/shortcodes.ts`:

- `[widget id="wid_xxx"]` -- Embeds a standalone widget's HTML/CSS inline
- `[product slug="product-slug"]` -- Embeds a product card (hydrated client-side via React)

Shortcodes are parsed with regex, resolved via API calls (`getWidgetById`, `getProductBySlug`), and replaced with rendered HTML before the page is served.

### Display Controls

Each page has boolean flags controlling storefront layout:

- `hideHeader` -- suppresses the site header on this page
- `hideFooter` -- suppresses the site footer on this page
- `hideTitle` -- suppresses the `<h1>` title rendering on the page

These flags are passed through the storefront's `Layout` component and respected in `[slug].astro`.

## Slug System

Slugs are validated with regex `^[a-z0-9]+(?:-[a-z0-9]+)*$` (lowercase alphanumeric with hyphens). The admin form auto-generates slugs from the title. The slug prefix in the admin form shows `/` (matching the actual storefront route `/{slug}`). Duplicate slugs are rejected at the service layer (`ConflictError`), checked against non-deleted pages.

On the storefront, `[slug].astro` is the catch-all dynamic route. It performs early validation before making API calls:
1. Rejects empty slugs, file extensions, known non-page paths (`api`, `favicon`, `_astro`, etc.)
2. Validates slug format against the same regex pattern
3. Only then calls `getPageBySlug()` via the public API

## Soft Delete

- `getPageById(db, id)` filters `deletedAt IS NULL` -- soft-deleted pages are invisible to lookups
- `getPageBySlug(db, slug)` also filters `deletedAt IS NULL`
- `listPages` supports `showTrashed` flag: when true, shows only deleted pages (`deletedAt IS NOT NULL`); when false (default), shows only non-deleted pages
- `deletePage(db, id)` -- soft-delete (sets `deletedAt`)
- `bulkDeletePages(db, ids, permanent?)` -- soft delete by default; permanent=true does hard delete
- `restorePages(db, ids)` -- clears `deletedAt`

## Files

- `index.ts` -- barrel exports
- `pages.service.ts` -- all DB queries and mutations
- `pages.validation.ts` -- Zod schemas (`createPageSchema`, `updatePageSchema`)

### Service Functions

**Admin Queries:**
- `listPages(db, options)` -- paginated list with FTS5 search, sort (`title`/`createdAt`/`updatedAt`/`sortOrder`), trash filter. Defaults: page 1, limit 10, sort by `updatedAt` desc.
- `getPageById(db, id)` -- single page by ID (non-deleted only)
- `getPageBySlug(db, slug)` -- single page by slug (non-deleted only)

**Public Queries:**
- `getPublicPageById(db, id)` -- single published page by ID (non-deleted, `isPublished = true`)
- `getPublicPageBySlug(db, slug)` -- single published page by slug (non-deleted, `isPublished = true`)
- `getPublicPages(db, options?)` -- paginated list of published pages. Sort options: `title`, `createdAt`, `-title`, `-createdAt` (prefix `-` for descending). Defaults: page 1, limit 10, sort by `title` asc.

**Mutations:**
- `createPage(db, data)` -- inserts with `page_` prefixed nanoid; checks slug uniqueness among non-deleted pages; returns `{ id }`
- `updatePage(db, id, data)` -- partial update; validates slug uniqueness if slug changed; throws `NotFoundError` / `ConflictError`
- `deletePage(db, id)` -- soft-delete (sets `deletedAt`)
- `bulkDeletePages(db, ids, permanent?)` -- soft or hard delete
- `bulkPublishPages(db, ids)` / `bulkUnpublishPages(db, ids)` -- toggle `isPublished`
- `restorePages(db, ids)` -- clears `deletedAt`

### Validation Schema

- `title`: 3-100 chars
- `slug`: 3-100 chars, lowercase alphanumeric with hyphens
- `content`: required string (TipTap HTML)
- `metaTitle`, `metaDescription`: nullable strings
- `isPublished`: boolean (default true)
- `publishedAt`: optional date (auto-set on publish if not provided)
- `sortOrder`: number (default 0)
- `hideHeader`, `hideFooter`, `hideTitle`: boolean (default false)

Exported types: `CreatePageInput`, `UpdatePageInput`.

## API Endpoints

### Admin (authenticated, via `apps/api/src/routes/admin/pages.ts`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/pages` | List pages (paginated, searchable, sortable, trash filter) |
| POST | `/admin/pages` | Create page |
| GET | `/admin/pages/{id}` | Get page by ID |
| PUT | `/admin/pages/{id}` | Update page |
| DELETE | `/admin/pages/{id}` | Soft-delete page |
| DELETE | `/admin/pages/{id}/permanent` | Hard-delete page |
| POST | `/admin/pages/{id}/restore` | Restore soft-deleted page |
| POST | `/admin/pages/bulk-delete` | Bulk soft/hard delete (body: `{ pageIds, permanent }`) |
| POST | `/admin/pages/bulk-publish` | Bulk publish (body: `{ ids }`) |
| POST | `/admin/pages/bulk-unpublish` | Bulk unpublish (body: `{ ids }`) |
| POST | `/admin/pages/bulk-restore` | Bulk restore (body: `{ ids }`) |

Note: bulk-delete uses `pageIds` as the key name (not `ids`), unlike other bulk endpoints.

### Public (via `apps/api/src/routes/pages.ts`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/pages` | List pages (paginated, published-only by default, cached 1h) |
| GET | `/pages/slug/{slug}` | Get published page by slug (cached 1h) |
| GET | `/pages/{id}` | Get page by ID, non-deleted only (cached 1h) |

Public routes return `{ page }` or `{ pages, pagination }` inside the standard `{ success, data }` envelope.

## Storefront Integration

**Client library** (`apps/storefront/src/lib/api/pages.ts`):
- `getPageBySlug(slug)` -- fetches via `/pages/slug/{slug}`, edge-cached (24h TTL via `withEdgeCache`)
- `getAllPages(options)` -- fetches via `/pages`, edge-cached, returns `{ data: Page[], pagination }`

**Dynamic page route** (`apps/storefront/src/pages/[slug].astro`):
- Validates slug format before making API calls
- Fetches layout data and page data in parallel
- Processes shortcodes in page content
- Applies `hideHeader`, `hideFooter`, `hideTitle` flags

## Dependencies

- `@scalius/database` -- `pages` table
- `@scalius/core/search` -- FTS5 full-text search (`ftsMatch`)
- `@scalius/core/errors` -- `NotFoundError`, `ConflictError`
- `nanoid` -- ID generation

## Known Gaps

- **No version history**: Unlike widgets, pages have no content versioning system. There is no `pageHistory` table or restore-from-history capability.
- **Public route uses raw `db` import**: `apps/api/src/routes/pages.ts` imports `db` from `@scalius/database/client` instead of using `c.get("db")` from Hono context.
