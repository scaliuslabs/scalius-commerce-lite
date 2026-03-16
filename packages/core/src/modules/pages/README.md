# Pages

CMS page management with publish/unpublish workflow and bulk operations.

## Files

- `index.ts` -- barrel exports
- `pages.service.ts` -- `listPages()`, `getPageById()`, `getPageBySlug()`, `createPage()`, `updatePage()`, `deletePage()`, `bulkDeletePages()`, `bulkPublishPages()`, `bulkUnpublishPages()`, `restorePages()`

## Dependencies

- `@scalius/database` -- `pages`
- `@scalius/core/search` -- FTS5
