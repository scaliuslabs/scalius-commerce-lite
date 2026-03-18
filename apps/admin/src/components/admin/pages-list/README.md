# Pages List

Admin component for managing CMS pages with publish/unpublish workflow, server-side pagination and search, sortable columns, and bulk actions.

## Architecture

```
pages-list/
  PagesList.tsx                -- main orchestrator (state, selection, bulk actions)
  index.ts                     -- barrel export (PagesList + types)
  components/
    PageRow.tsx                -- table row: status badge, edit link, storefront preview link, delete
    PageStatistics.tsx         -- stat cards: total / published / drafts
    PageToolbar.tsx            -- search input + bulk action dropdown
    PageTable.tsx              -- sortable table with header controls, select-all, empty states
    PagePagination.tsx         -- wrapper around shared AdminListPagination
    PageDeleteDialog.tsx       -- trash/permanent delete confirmation
    index.ts                   -- barrel export for components
  hooks/
    usePages.ts                -- fetch, debounced search, server-side pagination+sort
    usePageActions.ts          -- single-page delete, restore
    useBulkActions.ts          -- multi-select state + bulk API calls
    index.ts                   -- barrel export for hooks
  types/
    index.ts                   -- PageItem, Pagination, SortField, SortOrder, BulkAction, prop interfaces
```

## Data Flow

1. **Astro page** (`apps/admin/src/pages/admin/pages/index.astro`) renders `PagesList` with `client:idle`. No server-side data fetching -- all data is fetched client-side.
2. `usePages` fetches pages from `GET /admin/pages` with query params (`page`, `limit`, `trashed`, `search`, `sort`, `order`).
3. Search is debounced (300ms) and triggers a server-side re-fetch (FTS5 search via the API).
4. Pagination, sort field, and sort order are all server-side (API returns paginated results).
5. `useEffect` with `fetchPages` as dependency triggers re-fetch when any query parameter changes.

## Features

### Page Table
- Sortable columns: Title, Sort Order, Last Updated (click column header to toggle sort direction)
- Columns: checkbox, title, slug, sort order, status (Published/Draft badge), last updated, actions
- Actions per row: view on storefront (external link to `/{slug}`), edit (`/admin/pages/{id}/edit`), soft-delete
- Trash view: restore, permanent delete

### Publish Status
Pages have `isPublished` boolean. Published pages show a green "Published" badge, drafts show a gray "Draft" badge. Publishing/unpublishing is done via bulk actions only (no inline toggle).

### Bulk Actions
Available via dropdown menu when items are selected:
- **Active view**: Publish, Unpublish, Move to Trash
- **Trash view**: Restore, Delete Permanently

Endpoint mapping:
- `trash` / `delete` -> `POST /admin/pages/bulk-delete` (with `pageIds` array, `permanent` flag for delete)
- `restore` -> `POST /admin/pages/bulk-restore` (with `ids` array)
- `publish` -> `POST /admin/pages/bulk-publish` (with `ids` array)
- `unpublish` -> `POST /admin/pages/bulk-unpublish` (with `ids` array)

Note: `trash` and `delete` use `pageIds` as the key name, while other actions use `ids`.

### Statistics Cards
Three stat cards (total, published, drafts) shown in active view. Published/draft counts are computed client-side from the current page of results. Total comes from the API's pagination metadata.

### Storefront Preview
Each page row has an external link icon that opens the page on the storefront. The URL is computed via `useStorefrontUrl` hook, pointing to `/{slug}`.

## Pages

| Route | File | Description |
|-------|------|-------------|
| `/admin/pages` | `apps/admin/src/pages/admin/pages/index.astro` | Page list (active) |
| `/admin/pages/trash` | `apps/admin/src/pages/admin/pages/trash.astro` | Page list (trashed) |
| `/admin/pages/new` | `apps/admin/src/pages/admin/pages/new.astro` | Create new page (PageForm) |
| `/admin/pages/{id}/edit` | `apps/admin/src/pages/admin/pages/[id]/edit.astro` | Edit page (PageForm with defaultValues) |

## Page Form

`apps/admin/src/components/admin/PageForm.tsx` handles both create and edit:

- Two-column layout: content (left 2/3), settings (right 1/3)
- TipTap rich text editor (lazy-loaded) for content
- Auto-slug generation from title
- Slug prefix shows `/` (matching the storefront route `/{slug}`)
- Status & Display card: isPublished, hideHeader, hideFooter, hideTitle toggles
- URL & Settings card: slug input, sort order, "View on Storefront" link (edit mode only)
- Collapsible SEO card: metaTitle (with 60-char counter), metaDescription (with 160-char counter)
- Submits directly to `POST /admin/pages` (create) or `PUT /admin/pages/{id}` (edit)
- Sticky header with save/cancel actions via `FormStickyHeader`

## Date Handling

The `usePages` hook converts timestamps from the API response. It handles both ISO string format (with "T") and Unix timestamp format via `unixToDate` from `@scalius/shared/utils`.

## Dependencies

- Shared `BulkActionDialog` from `@/components/admin/shared/BulkActionDialog`
- Shared `AdminListPagination` from `@/components/admin/shared/AdminListPagination`
- `@scalius/shared/utils` -- `cn`, `unixToDate`
- `@/hooks/use-debounce` -- debounced search
- `@/hooks/use-storefront-url` -- storefront URL generation
- `@/components/admin/FormStickyHeader` -- sticky save/cancel bar
- `@/components/admin/product-form/CollapsibleCard` -- collapsible SEO section
- `@/components/ui/tiptap` -- TipTap editor (lazy-loaded)
- `@/lib/client/navigate` -- `navigateTo` for Astro View Transitions

## Known Gaps

- **Statistics are partial**: Published/draft counts are computed from the current page of results only, not from all pages. The total count comes from API pagination metadata but published/draft breakdown requires all pages or a dedicated stats endpoint.
- **No inline publish toggle**: Unlike widgets (which have an inline active/inactive switch), pages require bulk actions to change publish status.
- **Loader split**: The page edit route uses `getPageEditData` from `@/loaders/admin/catalog` (not a pages-specific loader). The list page has no loader -- data is fully client-side fetched.
