# Attributes Manager

Admin component for managing product attributes with inline editing and value viewer.

## Files

```
attributes-manager/
  AttributesManager.tsx          -- main orchestrator
  components/
    AttributeRow.tsx             -- row with inline name/slug editing, filterable toggle
    AttributeStatistics.tsx      -- total/filterable/values counts
    AttributeToolbar.tsx         -- search + create + bulk action buttons
    AttributeTable.tsx           -- sortable table with selection
    AttributePagination.tsx      -- page nav + page size selector
    AttributeCreateDialog.tsx    -- new attribute dialog (auto-slug)
    AttributeDeleteDialog.tsx    -- delete/trash confirmation
    AttributeValuesViewer.tsx    -- view values with product counts
    AttributeValueEditor.tsx     -- edit attribute values
  hooks/
    useAttributes.ts             -- fetch, pagination, search, sort
    useAttributeActions.ts       -- CRUD operations
    useBulkActions.ts            -- multi-select bulk ops
  types/
    index.ts                     -- Attribute, prop types
```

Uses shared `BulkActionDialog` from `@/components/admin/shared/BulkActionDialog`.
