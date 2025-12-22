# Collections List Manager

A modular, feature-rich component system for managing product collections in the admin panel.

## 📁 Structure

```
collections-list/
├── components/          # UI Components
│   ├── CollectionRow.tsx              # Individual collection row with inline editing & drag handle
│   ├── CollectionStatistics.tsx       # Compact statistics cards
│   ├── CollectionToolbar.tsx          # Search and bulk action toolbar
│   ├── CollectionTable.tsx            # Main table with drag-drop reordering
│   ├── CollectionPagination.tsx       # Pagination controls
│   ├── CollectionDeleteDialog.tsx     # Deletion confirmation dialog
│   ├── BulkActionDialog.tsx           # Bulk actions confirmation dialog
│   └── index.ts                       # Component exports
├── hooks/              # Custom React Hooks
│   ├── useCollections.ts              # Fetch and manage collections list with pagination
│   ├── useCollectionActions.ts        # CRUD operations (create, update, delete, restore, reorder)
│   ├── useBulkActions.ts              # Bulk operations and selection management
│   └── index.ts                       # Hook exports
├── types/              # TypeScript Definitions
│   └── index.ts                       # All type definitions and interfaces
├── utils/              # Utility Functions (reserved for future use)
├── CollectionsList.tsx                # Main orchestrator component
├── index.ts                           # Public API exports
└── README.md                          # This file
```

## 🚀 Usage

```tsx
import { CollectionsList } from "@/components/admin/collections-list";

// In your page/component
<CollectionsList showTrashed={false} />;
```

## 🧩 Component Breakdown

### Main Component

- **CollectionsList.tsx** - Orchestrates all sub-components and manages state flow

### UI Components

1. **CollectionRow** - Renders individual collection rows with:
   - Inline name editing with debouncing (700ms)
   - Drag handle for reordering (only on active collections)
   - Active/Inactive toggle switch with visual badge
   - Type indicator (Style 1 / Style 2)
   - Content source display (categories & products count)
   - Edit and Preview action buttons
   - Delete/Restore actions

2. **CollectionStatistics** - Displays three compact metrics:
   - Total collections count
   - Active collections count
   - Inactive collections count

3. **CollectionToolbar** - Provides:
   - Search input with debouncing (300ms)
   - Bulk action buttons (conditional based on selection):
     - Active view: Activate, Deactivate, Trash
     - Trash view: Restore, Delete
   - New Collection button

4. **CollectionTable** - Main data table with:
   - Drag-and-drop reordering (using @hello-pangea/dnd)
   - Sortable columns (name, type, status, updatedAt)
   - Select all checkbox
   - Empty state messaging
   - Loading state
   - Conditional drag handle column (hidden in trash)

5. **CollectionPagination** - Standard pagination with:
   - Page navigation (first, prev, next, last)
   - Rows per page selector (10, 20, 50, 100)
   - Current page indicator

6. **CollectionDeleteDialog** - Confirmation for delete/trash actions

7. **BulkActionDialog** - Confirmation for bulk operations

### Custom Hooks

1. **useCollections** - Manages collection list state:
   - Fetches paginated collections
   - Handles search and sort parameters
   - Provides pagination controls
   - Supports trash/active view filtering

2. **useCollectionActions** - CRUD operations:
   - Update collections (with debouncing)
   - Soft delete (move to trash)
   - Hard delete (permanent)
   - Restore from trash
   - Reorder collections (drag-and-drop)

3. **useBulkActions** - Bulk operations:
   - Selection management (individual/all)
   - Bulk trash/delete/restore
   - Bulk activate/deactivate
   - Action confirmation flow

## 🔄 Data Flow

```
CollectionsList (orchestrator)
  ├─> useCollections (data fetching & pagination)
  ├─> useCollectionActions (CRUD operations)
  ├─> useBulkActions (bulk operations & selection)
  └─> Components (presentation)
      ├─> CollectionStatistics
      ├─> CollectionToolbar
      ├─> CollectionTable
      │   └─> CollectionRow (per item with drag-and-drop)
      ├─> CollectionPagination
      └─> Dialogs (modals)
```

## 🎨 Features

- ✅ **Inline Editing** - Edit collection names directly in the table
- ✅ **Debounced Updates** - Auto-save after inactivity (700ms for name, 300ms for search)
- ✅ **Drag-and-Drop Reordering** - Visual reordering with instant feedback
- ✅ **Search & Filter** - Real-time search across collection names
- ✅ **Sorting** - Sort by name, type, status, or update date
- ✅ **Pagination** - Configurable page size (10, 20, 50, 100)
- ✅ **Bulk Actions** - Multi-select with bulk operations:
  - Trash/Delete/Restore
  - Activate/Deactivate
- ✅ **Soft Delete** - Move to trash before permanent deletion
- ✅ **Active/Inactive Toggle** - Quick status switching
- ✅ **Statistics** - Real-time metrics display (compact cards)
- ✅ **Responsive** - Mobile-friendly design
- ✅ **Dark Mode** - Full dark mode support

## 📡 API Endpoints

### Collections API

- `GET /api/collections` - List collections with pagination, search, sort, and trash filter
- `POST /api/collections` - Create new collection
- `GET /api/collections/[id]` - Get single collection
- `PUT /api/collections/[id]` - Update collection (partial updates supported)
- `DELETE /api/collections/[id]` - Soft delete (move to trash)

### Bulk Operations

- `POST /api/collections/bulk-delete` - Bulk trash or permanent delete
- `POST /api/collections/bulk-restore` - Bulk restore from trash
- `POST /api/collections/bulk-activate` - Bulk activate collections
- `POST /api/collections/bulk-deactivate` - Bulk deactivate collections

### Trash Operations

- `POST /api/collections/[id]/restore` - Restore single collection
- `DELETE /api/collections/[id]/permanent` - Permanently delete collection

### Reordering

- `POST /api/collections/reorder` - Update collection display order

## 📝 Type Safety

All components are fully typed with TypeScript. See `types/index.ts` for:

- `CollectionItem` - Main collection type with optional productCount
- `CollectionConfig` - Collection configuration structure
- `CollectionsManagerProps` - Main component props
- Component-specific prop types
- Pagination, sorting, and filter types

## 🎯 Collection Types

The system supports two collection display styles:

- **Style 1 (collection1)** - Grid layout with featured product
- **Style 2 (collection2)** - Horizontal scroll layout

Each collection can source products from:
- Specific categories (with optional additional products)
- Manually selected products

## 🧪 Testing Checklist

To test the component:

1. **Basic Operations**
   - ✓ View collections list
   - ✓ Search collections
   - ✓ Sort by different columns
   - ✓ Change page size
   - ✓ Navigate between pages

2. **Editing**
   - ✓ Edit collection name (inline)
   - ✓ Toggle active/inactive status
   - ✓ Drag-and-drop to reorder

3. **Single Actions**
   - ✓ Edit collection (navigate to edit page)
   - ✓ Preview collection (storefront preview)
   - ✓ Delete collection (move to trash)

4. **Bulk Actions**
   - ✓ Select multiple collections
   - ✓ Bulk activate
   - ✓ Bulk deactivate
   - ✓ Bulk trash

5. **Trash Management**
   - ✓ View trashed collections (`/admin/collections/trash`)
   - ✓ Restore collection from trash
   - ✓ Permanently delete collection
   - ✓ Bulk restore
   - ✓ Bulk permanent delete

6. **Statistics**
   - ✓ Verify total count accuracy
   - ✓ Verify active/inactive counts
   - ✓ Stats update after actions

## 🔗 Related Files

- **Pages**: 
  - `src/pages/admin/collections/index.astro` - Main collections page
  - `src/pages/admin/collections/trash.astro` - Trash page
  - `src/pages/admin/collections/new.astro` - Create collection page
  - `src/pages/admin/collections/[id]/edit.astro` - Edit collection page

- **API Routes**: `src/pages/api/collections/`

- **Database Schema**: `src/db/schema.ts` (collections table)

## 🚀 Future Enhancements

Potential additions:

- **Export/Import** - Bulk export/import collections
- **Duplicate** - Quick collection duplication
- **Templates** - Pre-configured collection templates
- **Preview Modal** - In-app collection preview
- **Advanced Filters** - Filter by type, status, date range
- **Batch Edit** - Edit multiple collections at once
- **Audit Log** - Track collection changes history

