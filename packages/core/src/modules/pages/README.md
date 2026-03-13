# Pages

CMS page management for static/landing pages with publish/unpublish workflow.

## Exports

- `listPages()` — paginated, searchable page list for admin
- `getPageById()` / `getPageBySlug()` — single page lookup
- `createPage()` / `updatePage()` / `deletePage()` — admin mutations
- `bulkDeletePages()` / `bulkPublishPages()` / `bulkUnpublishPages()` / `restorePages()` — bulk ops
- `createPageSchema` / `updatePageSchema` — Zod validation schemas
- `CreatePageInput` / `UpdatePageInput` — TypeScript types

## Dependencies

- `@scalius/database` — `pages` table
- `@scalius/core/search` — FTS5 full-text search

## API Routes

- `GET /api/v1/pages` — list pages (admin)
- `GET /api/v1/pages/:id` — get page by ID
- `POST /api/v1/pages` — create page
- `PUT /api/v1/pages/:id` — update page
- `DELETE /api/v1/pages/:id` — soft-delete page
