# Attributes Manager

A modular, maintainable component system for managing product attributes in the admin panel.

## 📁 Structure

```
attributes-manager/
├── components/          # UI Components
│   ├── AttributeRow.tsx              # Individual attribute row with inline editing
│   ├── AttributeStatistics.tsx       # Statistics cards showing metrics
│   ├── AttributeToolbar.tsx          # Search and action toolbar
│   ├── AttributeTable.tsx            # Main table with sorting and selection
│   ├── AttributePagination.tsx       # Pagination controls
│   ├── AttributeCreateDialog.tsx     # Dialog for creating new attributes
│   ├── AttributeDeleteDialog.tsx     # Confirmation dialog for deletion
│   ├── BulkActionDialog.tsx          # Bulk actions confirmation dialog
│   ├── AttributeValuesViewer.tsx     # Dialog to view attribute values
│   └── index.ts                      # Component exports
├── hooks/              # Custom React Hooks
│   ├── useAttributes.ts              # Fetch and manage attributes list
│   ├── useAttributeActions.ts        # CRUD operations (create, update, delete, restore)
│   ├── useBulkActions.ts             # Bulk operations and selection
│   └── index.ts                      # Hook exports
├── types/              # TypeScript Definitions
│   └── index.ts                      # All type definitions and interfaces
├── utils/              # Utility Functions (reserved for future use)
├── AttributesManager.tsx              # Main orchestrator component
├── index.ts                           # Public API exports
└── README.md                          # This file

```

## 🚀 Usage

```tsx
import { AttributesManager } from "@/components/admin/attributes-manager";

// In your page/component
<AttributesManager showTrashed={false} />;
```

## 🧩 Component Breakdown

### Main Component

- **AttributesManager.tsx** - Orchestrates all sub-components and manages state flow

### UI Components

1. **AttributeRow** - Renders individual attribute rows with:

   - Inline name/slug editing with debouncing
   - Filterable toggle
   - Value count display (clickable to view details)
   - Delete/Restore actions

2. **AttributeStatistics** - Displays three key metrics:

   - Total active attributes
   - Filterable attributes count
   - Total unique values across all products

3. **AttributeToolbar** - Provides:

   - Search input with debouncing
   - Bulk action buttons (conditional based on selection)
   - Create attribute button

4. **AttributeTable** - Main data table with:

   - Sortable columns (name, slug, filterable, updatedAt)
   - Select all checkbox
   - Empty state messaging
   - Loading state

5. **AttributePagination** - Standard pagination with:

   - Page navigation
   - Rows per page selector
   - Current page indicator

6. **AttributeCreateDialog** - Modal for creating attributes:

   - Auto-generates slug from name
   - Filterable toggle
   - Validation

7. **AttributeDeleteDialog** - Confirmation for delete/trash actions

8. **BulkActionDialog** - Confirmation for bulk operations

9. **AttributeValuesViewer** - Shows all values for an attribute:
   - Search functionality
   - Product count per value
   - Example products using each value

### Custom Hooks

1. **useAttributes** - Manages attribute list state:

   - Fetches paginated attributes
   - Handles search and sort
   - Provides pagination controls

2. **useAttributeActions** - CRUD operations:

   - Create new attributes
   - Update existing attributes (with debouncing)
   - Soft delete (move to trash)
   - Hard delete (permanent)
   - Restore from trash

3. **useBulkActions** - Bulk operations:
   - Selection management (individual/all)
   - Bulk trash/delete/restore
   - Action confirmation flow

## 🔄 Data Flow

```
AttributesManager (orchestrator)
  ├─> useAttributes (data fetching)
  ├─> useAttributeActions (CRUD operations)
  ├─> useBulkActions (bulk operations)
  └─> Components (presentation)
      ├─> AttributeStatistics
      ├─> AttributeToolbar
      ├─> AttributeTable
      │   └─> AttributeRow (per item)
      ├─> AttributePagination
      └─> Dialogs (modals)
```

## 🎨 Features

- ✅ **Inline Editing** - Edit name and slug directly in table
- ✅ **Debounced Updates** - Auto-save after 700ms of inactivity
- ✅ **Search & Filter** - Real-time search across name and slug
- ✅ **Sorting** - Sort by name, slug, or filterable status
- ✅ **Pagination** - Configurable page size (10, 20, 50, 100)
- ✅ **Bulk Actions** - Trash, delete, or restore multiple items
- ✅ **Soft Delete** - Move to trash before permanent deletion
- ✅ **Value Viewer** - See where attributes are used
- ✅ **Statistics** - Real-time metrics display
- ✅ **Responsive** - Mobile-friendly design

## 🛠️ Future Enhancements

Potential additions to the `utils/` folder:

- Attribute validation functions
- Slug generation utilities
- Export/import helpers
- Attribute merge utilities

## 📝 Type Safety

All components are fully typed with TypeScript. See `types/index.ts` for:

- `Attribute` - Main attribute type with optional valueCount
- `AttributesManagerProps` - Main component props
- Component-specific prop types
- Pagination, sorting, and filter types

## 🧪 Testing

To test the component:

1. Navigate to `/admin/attributes` in your browser
2. Test creating, editing, deleting attributes
3. Test bulk operations
4. Test search and sorting
5. Test pagination
6. View attribute values
7. Test trash/restore functionality via `/admin/attributes?trashed=true`

## 🤝 Contributing

When adding new features:

1. Add types to `types/index.ts`
2. Create utility functions in `utils/`
3. Extract reusable logic to hooks in `hooks/`
4. Keep components focused and single-purpose in `components/`
5. Update this README with new features

## 📚 Related Files

- API Routes: `src/pages/api/admin/attributes/`
- Database Schema: `src/db/schema.ts` (productAttributes table)
- Page Implementation: `src/pages/admin/attributes/index.astro`
