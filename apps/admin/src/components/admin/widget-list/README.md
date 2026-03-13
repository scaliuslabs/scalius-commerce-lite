# Widget List Manager

A modular, feature-rich component system for managing content widgets in the admin panel.

## 📁 Structure

```
widget-list/
├── components/          # UI Components
│   ├── WidgetRow.tsx                  # Individual widget row with actions
│   ├── WidgetStatistics.tsx           # Compact statistics cards
│   ├── WidgetToolbar.tsx              # Search and bulk action toolbar
│   ├── WidgetTable.tsx                # Main table with widgets
│   ├── WidgetDeleteDialog.tsx         # Deletion confirmation dialog
│   ├── BulkActionDialog.tsx           # Bulk actions confirmation dialog
│   └── index.ts                       # Component exports
├── hooks/              # Custom React Hooks
│   ├── useWidgets.ts                  # Fetch and manage widgets list
│   ├── useWidgetActions.ts            # CRUD operations (update, delete, restore)
│   ├── useBulkActions.ts              # Bulk operations and selection management
│   └── index.ts                       # Hook exports
├── types/              # TypeScript Definitions
│   └── index.ts                       # All type definitions and interfaces
├── WidgetsList.tsx                    # Main orchestrator component
├── index.ts                           # Public API exports
└── README.md                          # This file
```

## 🚀 Usage

```tsx
import { WidgetsList } from "@/components/admin/widget-list";

// In your page/component
<WidgetsList
  showTrashed={false}
  initialWidgets={widgets}
  initialCollections={collections}
  initialStats={stats}
  initialSearch={searchQuery}
/>;
```

## 🧩 Component Breakdown

### Main Component

- **WidgetsList.tsx** - Orchestrates all sub-components and manages state flow

### UI Components

1. **WidgetRow** - Renders individual widget rows with:
   - Checkbox for selection
   - Widget name display
   - Placement rule information
   - Active/Inactive toggle switch with visual badge
   - Sort order display
   - Edit and Copy Shortcode buttons
   - Delete/Restore actions

2. **WidgetStatistics** - Displays three compact metrics:
   - Total widgets count
   - Active widgets count
   - Inactive widgets count

3. **WidgetToolbar** - Provides:
   - Search input for widget names
   - Bulk action buttons (conditional based on selection):
     - Active view: Activate, Deactivate, Trash
     - Trash view: Restore, Delete
   - OpenRouter API Key settings button
   - New Widget button

4. **WidgetTable** - Main data table with:
   - Select all checkbox
   - Widget name column
   - Placement column (shows placement rule and referenced collection)
   - Status column (switch + badge)
   - Order column
   - Actions column
   - Empty state messaging
   - Loading state

5. **WidgetDeleteDialog** - Confirmation for delete/trash actions

6. **BulkActionDialog** - Confirmation for bulk operations

### Custom Hooks

1. **useWidgets** - Manages widget list state:
   - Holds widget data
   - Manages collections reference
   - Provides statistics
   - Handles reload functionality

2. **useWidgetActions** - CRUD operations:
   - Update widgets (status, properties)
   - Soft delete (move to trash)
   - Hard delete (permanent)
   - Restore from trash
   - Individual action tracking

3. **useBulkActions** - Bulk operations:
   - Selection management (individual/all)
   - Bulk trash/delete/restore
   - Bulk activate/deactivate
   - Action confirmation flow

## 🔄 Data Flow

```
WidgetsList (orchestrator)
  ├─> useWidgets (data management)
  ├─> useWidgetActions (CRUD operations)
  ├─> useBulkActions (bulk operations & selection)
  └─> Components (presentation)
      ├─> WidgetStatistics
      ├─> WidgetToolbar
      ├─> WidgetTable
      │   └─> WidgetRow (per item)
      └─> Dialogs (modals)
```

## 🎨 Features

- ✅ **Search** - Real-time search across widget names
- ✅ **Status Toggle** - Quick active/inactive switching
- ✅ **Bulk Actions** - Multi-select with bulk operations:
  - Trash/Delete/Restore
  - Activate/Deactivate
- ✅ **Soft Delete** - Move to trash before permanent deletion
- ✅ **Shortcode Copy** - Quick copy widget shortcode for embedding
- ✅ **Statistics** - Real-time metrics display (compact cards)
- ✅ **API Key Management** - In-app OpenRouter API key configuration
- ✅ **Responsive** - Mobile-friendly design
- ✅ **Dark Mode** - Full dark mode support

## 📡 API Endpoints

### Widgets API

- `GET /api/widgets` - List widgets
- `POST /api/widgets` - Create new widget
- `GET /api/widgets/[id]` - Get single widget
- `PUT /api/widgets/[id]` - Update widget (partial updates supported)
- `DELETE /api/widgets/[id]` - Soft delete (move to trash)

### Bulk Operations

- `POST /api/widgets/bulk-delete` - Bulk trash or permanent delete
- `POST /api/widgets/bulk-restore` - Bulk restore from trash
- `POST /api/widgets/bulk-activate` - Bulk activate widgets
- `POST /api/widgets/bulk-deactivate` - Bulk deactivate widgets

### Widget Operations

- `POST /api/widgets/[id]/restore` - Restore single widget
- `DELETE /api/widgets/[id]/permanent` - Permanently delete widget
- `PATCH /api/widgets/[id]/toggle-status` - Toggle widget active status

### Settings

- `GET /api/settings/openrouter` - Get OpenRouter API key
- `POST /api/settings/openrouter` - Save OpenRouter API key

## 📝 Type Safety

All components are fully typed with TypeScript. See `types/index.ts` for:

- `WidgetItem` - Main widget type with all properties
- `CollectionOption` - Reference to collections
- `WidgetStatistics` - Statistics structure
- `WidgetsManagerProps` - Main component props
- Component-specific prop types
- Dialog and action types

## 🎯 Widget Placement Rules

The system supports the following placement rules:

- **before_collection** - Display before a specific collection
- **after_collection** - Display after a specific collection
- **fixed_top_homepage** - Fixed position at top of homepage
- **fixed_bottom_homepage** - Fixed position at bottom of homepage
- **standalone** - Standalone widget (embedded via shortcode)

Each widget can be:
- Activated or deactivated
- Assigned a sort order for display priority
- Linked to a reference collection (for before/after placement)

## 🧪 Testing Checklist

To test the component:

1. **Basic Operations**
   - ✓ View widgets list
   - ✓ Search widgets
   - ✓ Toggle active/inactive status

2. **Single Actions**
   - ✓ Edit widget (navigate to edit page)
   - ✓ Copy widget shortcode
   - ✓ Delete widget (move to trash)

3. **Bulk Actions**
   - ✓ Select multiple widgets
   - ✓ Bulk activate
   - ✓ Bulk deactivate
   - ✓ Bulk trash

4. **Trash Management**
   - ✓ View trashed widgets (`/admin/widgets/trash`)
   - ✓ Restore widget from trash
   - ✓ Permanently delete widget
   - ✓ Bulk restore
   - ✓ Bulk permanent delete

5. **Statistics**
   - ✓ Verify total count accuracy
   - ✓ Verify active/inactive counts
   - ✓ Stats update after actions

6. **API Key Management**
   - ✓ Open settings dialog
   - ✓ Save OpenRouter API key
   - ✓ Load existing API key

## 🔗 Related Files

- **Pages**: 
  - `src/pages/admin/widgets/index.astro` - Main widgets page
  - `src/pages/admin/widgets/trash.astro` - Trash page
  - `src/pages/admin/widgets/create.astro` - Create widget page
  - `src/pages/admin/widgets/[id].astro` - Edit widget page

- **API Routes**: `src/pages/api/widgets/`

- **Database Schema**: `src/db/schema.ts` (widgets table)

## 🚀 Future Enhancements

Potential additions:

- **Export/Import** - Bulk export/import widgets
- **Duplicate** - Quick widget duplication
- **Templates** - Pre-configured widget templates
- **Preview Modal** - In-app widget preview
- **Advanced Filters** - Filter by placement, status
- **Version History** - Track widget changes over time
- **Drag-and-Drop Reordering** - Visual reordering of widgets
- **Batch Edit** - Edit multiple widgets at once

## 🎨 Design Inspiration

This module follows the same design patterns and structure as the `collections-list` module, providing a consistent admin experience across different content types.

