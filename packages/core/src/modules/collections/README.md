# Collections

Curated product groups displayed on the homepage, with drag-and-drop reordering.

## Files

- `index.ts` -- barrel exports
- `collections.service.ts` -- `listCollections()`, `getCollectionById()`, `createCollection()`, `updateCollection()`, `deleteCollection()`, `bulkDeleteCollections()`, `bulkActivateCollections()`, `bulkDeactivateCollections()`, `reorderCollections()`, `restoreCollections()`
- `collections.schema.ts` -- `CreateCollectionInput`, `UpdateCollectionInput`, Zod schemas

## Collection types

Collection types are `"manual"` (admin-curated products) and `"dynamic"` (rule-based). Previously named `"collection1"`/`"collection2"` — migrated in migration 0024.

## Dependencies

- `@scalius/database` -- `collections`
