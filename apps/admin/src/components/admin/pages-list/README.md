# Pages List

Admin component for managing CMS pages with publish/unpublish workflow and bulk actions.

## Files

```
pages-list/
  PagesList.tsx              -- main orchestrator
  components/
    PageRow.tsx              -- row with status badge, edit/preview actions
    PageStatistics.tsx       -- total/published/draft counts
    PageToolbar.tsx          -- search + bulk action buttons
    PageTable.tsx            -- sortable table with selection
    PagePagination.tsx       -- page nav + page size selector
    PageDeleteDialog.tsx     -- delete/trash confirmation
  hooks/
    usePages.ts              -- fetch, pagination, search, sort
    usePageActions.ts        -- delete, restore operations
    useBulkActions.ts        -- multi-select bulk ops (trash, delete, restore, publish, unpublish)
  types/
    index.ts                 -- PageItem, Pagination, BulkAction, prop types
```

Uses shared `BulkActionDialog` from `@/components/admin/shared/BulkActionDialog`.
