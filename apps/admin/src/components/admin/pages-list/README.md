# Pages List Component

A comprehensive, modular component system for managing website pages with full CRUD operations, trash functionality, and bulk actions.

## Architecture

This module follows a clean, modular architecture inspired by modern React best practices:

```
pages-list/
├── PagesList.tsx          # Main orchestrator component
├── types/
│   └── index.ts          # TypeScript interfaces and types
├── hooks/
│   ├── usePages.ts       # Data fetching, pagination, search, sort
│   ├── usePageActions.ts # CRUD operations (delete, restore)
│   └── useBulkActions.ts # Bulk operations handler
├── components/
│   ├── PageStatistics.tsx   # Statistics cards display
│   ├── PageToolbar.tsx      # Search and bulk actions toolbar
│   ├── PageTable.tsx        # Main table with sorting
│   ├── PageRow.tsx          # Individual page row
│   ├── PagePagination.tsx   # Pagination controls
│   ├── PageDeleteDialog.tsx # Delete confirmation dialog
│   └── BulkActionDialog.tsx # Bulk action confirmation
└── index.ts              # Public API exports
```

## Features

### Core Functionality

- ✅ **CRUD Operations**: Create, read, update, and delete pages
- ✅ **Soft Delete**: Pages are moved to trash before permanent deletion
- ✅ **Restore**: Recover pages from trash
- ✅ **Search**: Real-time search with 300ms debounce
- ✅ **Sorting**: Multi-field sorting (title, sort order, updated date)
- ✅ **Pagination**: Configurable page sizes (10, 20, 50, 100)
- ✅ **Bulk Actions**: Batch operations on multiple pages

### Bulk Operations

- **Trash**: Move multiple pages to trash
- **Restore**: Recover multiple pages from trash
- **Delete**: Permanently delete multiple pages
- **Publish**: Publish multiple draft pages
- **Unpublish**: Unpublish multiple published pages

### UI Features

- **Statistics Cards**: Display total, published, and draft counts
- **Status Badges**: Visual indicators for published/draft status
- **Empty States**: Helpful messages when no data is available
- **Loading States**: Smooth loading indicators
- **Responsive Design**: Works on all screen sizes
- **Dark Mode**: Full dark mode support

## Usage

### Basic Implementation

```tsx
import { PagesList } from "@/components/admin/pages-list";

// Active pages
<PagesList showTrashed={false} />

// Trash page
<PagesList showTrashed={true} />
```

### In Astro Pages

```astro
---
// src/pages/admin/pages/index.astro
import AdminLayout from "@/layouts/AdminLayout.astro";
import { PagesList } from "@/components/admin/pages-list";
---

<AdminLayout title="Pages">
  <PagesList client:load showTrashed={false} />
</AdminLayout>
```

## API Endpoints

The component interacts with the following API endpoints:

### GET /api/pages

Fetch pages with filtering and pagination.

**Query Parameters:**

- `page` (number): Page number (default: 1)
- `limit` (number): Items per page (default: 20)
- `search` (string): Search query
- `sort` (string): Sort field (title, sortOrder, updatedAt)
- `order` (string): Sort order (asc, desc)
- `trashed` (boolean): Show trashed items

**Response:**

```json
{
  "pages": [...],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 45,
    "totalPages": 3
  }
}
```

### DELETE /api/pages/[id]

Soft delete (trash) a page.

### DELETE /api/pages/[id]/permanent

Permanently delete a page.

### POST /api/pages/[id]/restore

Restore a page from trash.

### POST /api/pages/bulk-delete

Bulk soft or permanent delete.

**Body:**

```json
{
  "pageIds": ["page_123", "page_456"],
  "permanent": false
}
```

### POST /api/pages/bulk-restore

Bulk restore pages from trash.

**Body:**

```json
{
  "pageIds": ["page_123", "page_456"]
}
```

### POST /api/pages/bulk-publish

Bulk publish pages.

**Body:**

```json
{
  "pageIds": ["page_123", "page_456"]
}
```

### POST /api/pages/bulk-unpublish

Bulk unpublish pages.

**Body:**

```json
{
  "pageIds": ["page_123", "page_456"]
}
```

## Component Props

### PagesList

| Prop          | Type      | Default | Description                               |
| ------------- | --------- | ------- | ----------------------------------------- |
| `showTrashed` | `boolean` | `false` | Show trashed pages instead of active ones |

## Custom Hooks

### usePages

Manages page data, search, sorting, and pagination.

```tsx
const {
  pages,
  pagination,
  isLoading,
  searchQuery,
  setSearchQuery,
  sortField,
  sortOrder,
  goToPage,
  changePageSize,
  handleSort,
  fetchPages,
} = usePages(showTrashed);
```

### usePageActions

Handles individual page operations (delete, restore).

```tsx
const { isActionLoading, handleDelete, handleRestore } =
  usePageActions(fetchPages);
```

### useBulkActions

Manages bulk operations on multiple pages.

```tsx
const { isBulkActionLoading, handleBulkAction } = useBulkActions(
  selectedIds,
  setSelectedIds,
  fetchPages,
);
```

## Type Definitions

### PageItem

```typescript
interface PageItem extends Page {
  // Inherits all fields from Page schema
}
```

### Pagination

```typescript
interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}
```

### BulkAction

```typescript
type BulkAction =
  | "trash"
  | "delete"
  | "restore"
  | "publish"
  | "unpublish"
  | null;
```

## Date Handling

The component properly handles dates received from the API:

1. **API Response**: Returns ISO 8601 date strings
2. **Frontend Conversion**: Converts to JavaScript Date objects
3. **Display**: Formats as "MMM DD, YYYY" (e.g., "Dec 15, 2024")

```typescript
// In usePages.ts
const formattedPages = data.pages.map((page: any) => ({
  ...page,
  createdAt: page.createdAt ? new Date(page.createdAt) : null,
  updatedAt: page.updatedAt ? new Date(page.updatedAt) : null,
  deletedAt: page.deletedAt ? new Date(page.deletedAt) : null,
  publishedAt: page.publishedAt ? new Date(page.publishedAt) : null,
}));
```

## Toast Notifications

Uses `sonner` for user feedback:

```typescript
toast.success("Page deleted successfully");
toast.error("Failed to delete page", {
  description: "Error details here",
  duration: 8000,
});
```

## Performance Optimizations

- **Debounced Search**: 300ms delay to reduce API calls
- **Memoization**: Uses React.memo and useCallback where appropriate
- **Efficient Re-renders**: Only affected components re-render on state changes
- **Optimistic UI**: Loading states for better perceived performance

## Error Handling

All operations include comprehensive error handling:

```typescript
try {
  const response = await fetch(endpoint);
  if (!response.ok) throw new Error("Failed to delete page");
  toast.success("Page deleted");
  fetchPages();
} catch (error: any) {
  toast.error("Deletion Failed", {
    description: error.message,
    duration: 8000,
  });
}
```

## Styling

Components use Tailwind CSS with shadcn/ui design system:

- Consistent spacing and typography
- Responsive design patterns
- Dark mode support
- Accessible color contrasts
- Smooth transitions and animations

## Accessibility

- Semantic HTML structure
- ARIA labels for icon buttons
- Keyboard navigation support
- Focus management in dialogs
- Screen reader friendly

## Future Enhancements

Potential improvements for future versions:

- [ ] Drag-and-drop reordering
- [ ] Advanced filters (date range, author)
- [ ] Export pages (JSON/CSV)
- [ ] Duplicate page functionality
- [ ] Version history
- [ ] Preview mode
- [ ] Scheduled publishing

## Dependencies

- React 18+
- sonner (toast notifications)
- lucide-react (icons)
- @/components/ui/\* (shadcn/ui components)
- @/hooks/use-debounce
- @/hooks/use-storefront-url

## Contributing

When adding new features:

1. Add types to `types/index.ts`
2. Create reusable hooks in `hooks/`
3. Build UI components in `components/`
4. Update the main orchestrator in `PagesList.tsx`
5. Add corresponding API endpoints
6. Update this README

## Related Components

- **PageForm**: Form for creating/editing pages (`/admin/pages/new`, `/admin/pages/[id]/edit`)
- **AttributesManager**: Similar modular architecture for attributes
- **CollectionsList**: Similar modular architecture for collections
- **ProductList**: Reference implementation for complex data tables
