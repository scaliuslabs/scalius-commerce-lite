# Widget List

Admin component for managing content widgets with status toggles and shortcode copy.

## Files

```
widget-list/
  WidgetsList.tsx              -- main orchestrator
  components/
    WidgetRow.tsx              -- row with status toggle, shortcode copy, placement info
    WidgetStatistics.tsx       -- total/active/inactive counts
    WidgetToolbar.tsx          -- search + OpenRouter key + bulk action buttons
    WidgetTable.tsx            -- table with selection
    WidgetDeleteDialog.tsx     -- delete/trash confirmation
  hooks/
    useWidgets.ts              -- data management + reload
    useWidgetActions.ts        -- CRUD operations
    useBulkActions.ts          -- multi-select bulk ops
  types/
    index.ts                   -- WidgetItem, CollectionOption, prop types
```

Uses shared `BulkActionDialog` from `@/components/admin/shared/BulkActionDialog`.
