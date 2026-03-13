# Collections

Manages product collections (curated groups displayed on the homepage). Collections reference products by ID or by category.

## Exports

- `listCollections()` — paginated admin list with search and sort
- `getCollectionById()` — single collection lookup
- `createCollection()` / `updateCollection()` / `deleteCollection()` — admin mutations
- `bulkDeleteCollections()` / `bulkActivateCollections()` / `bulkDeactivateCollections()` — bulk ops
- `reorderCollections()` — update sort order for drag-and-drop
- `restoreCollections()` — restore soft-deleted collections
- `CreateCollectionInput` / `UpdateCollectionInput` — Zod-validated input types

## Dependencies

- `@scalius/database` — `collections` table

## API Routes

- `GET /api/v1/collections` — list collections
- `POST /api/v1/collections` — create collection
- `PUT /api/v1/collections/:id` — update collection
- `DELETE /api/v1/collections/:id` — soft-delete collection
