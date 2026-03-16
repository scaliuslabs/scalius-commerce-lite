# Collections

Curated product groups displayed on the homepage, with drag-and-drop reordering.

## Files

- `index.ts` -- barrel exports
- `collections.service.ts` -- `listCollections()`, `getCollectionById()`, `createCollection()`, `updateCollection()`, `deleteCollection()`, `bulkDeleteCollections()`, `bulkActivateCollections()`, `bulkDeactivateCollections()`, `reorderCollections()`, `restoreCollections()`
- `collections.schema.ts` -- `CreateCollectionInput`, `UpdateCollectionInput`, Zod schemas

## Dependencies

- `@scalius/database` -- `collections`
