# Collections List

Admin component for managing product collections with drag-and-drop reordering.

## Files

```
collections-list/
  CollectionsList.tsx          -- main orchestrator
  components/
    CollectionRow.tsx          -- row with inline editing, drag handle, status toggle
    CollectionStatistics.tsx   -- total/active/inactive counts
    CollectionToolbar.tsx      -- search + bulk action buttons
    CollectionTable.tsx        -- drag-drop table (@hello-pangea/dnd)
    CollectionPagination.tsx   -- page nav + page size selector
    CollectionDeleteDialog.tsx -- delete/trash confirmation
  hooks/
    useCollections.ts          -- fetch, pagination, search, sort
    useCollectionActions.ts    -- CRUD + reorder
    useBulkActions.ts          -- multi-select bulk ops
  types/
    index.ts                   -- CollectionItem, CollectionConfig, prop types
```

Uses shared `BulkActionDialog` from `@/components/admin/shared/BulkActionDialog`.
