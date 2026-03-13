# Media Manager - Modular Architecture

## Overview

The MediaManager has been completely refactored into a modular, maintainable, and feature-rich system. The component has been broken down from a monolithic 1000+ line file into a well-organized folder structure with reusable components, hooks, utilities, and API clients.

## 📁 Folder Structure

```
src/components/admin/media-manager/
├── api/                    # API client utilities
│   ├── mediaClient.ts      # Centralized API calls
│   └── index.ts
├── components/             # Reusable UI components
│   ├── MediaCard.tsx       # Individual media file card
│   ├── MediaGallery.tsx    # Grid gallery view
│   ├── MediaUploadZone.tsx # Upload with drag & drop
│   ├── MediaPreview.tsx    # Full-screen preview dialog
│   ├── MediaFilterBar.tsx  # Search and filter controls
│   ├── FolderBrowser.tsx   # Folder navigation sidebar
│   └── index.ts
├── hooks/                  # Custom React hooks
│   ├── useMediaFiles.ts    # File management state
│   ├── useMediaUpload.ts   # Upload handling
│   ├── useFolders.ts       # Folder management
│   └── index.ts
├── types/                  # TypeScript interfaces
│   └── index.ts
├── utils/                  # Utility functions
│   ├── formatters.ts       # Date, size formatters
│   ├── validators.ts       # File validation
│   ├── debounce.ts         # Debounce utility
│   └── index.ts
├── MediaManager.tsx        # Main dialog component
├── MediaManagerPage.tsx    # Standalone page component
├── index.ts                # Public exports
└── README.md               # This file
```

## 🎯 Key Features

### ✅ Implemented Features

1. **Folder/Collection Organization**

   - Create, delete, and organize files into folders
   - Navigate folder hierarchy
   - Move files between folders
   - Folder-based filtering

2. **Advanced Upload**

   - Drag and drop support
   - Bulk file upload
   - Upload progress tracking
   - File type validation
   - File size limits (configurable, default 10MB)

3. **File Management**

   - Multi-select mode
   - Bulk delete operations
   - Individual file actions
   - Copy URL to clipboard
   - Download files
   - File metadata editing

4. **Search & Filter**

   - Real-time search (debounced)
   - Filter by folder
   - Filter by search query
   - Pagination support

5. **Preview & Navigation**

   - Full-screen image preview
   - Navigate between images
   - Quick preview from gallery
   - Select from preview

6. **UI/UX Improvements**
   - Responsive grid layout
   - Loading states
   - Error handling with toast notifications
   - Optimistic UI updates
   - Keyboard navigation
   - Accessible components

## 🔧 Usage

### As a Dialog (For Selecting Media)

```tsx
import { MediaManager } from "@/components/admin/media-manager";

function MyComponent() {
  const handleSelect = (file) => {
    console.log("Selected file:", file);
  };

  const handleSelectMultiple = (files) => {
    console.log("Selected files:", files);
  };

  return (
    <MediaManager
      onSelect={handleSelect}
      onSelectMultiple={handleSelectMultiple}
      selectedFiles={[]}
      triggerLabel="Choose Image"
      acceptedFileTypes="image/*"
      maxFileSize={10}
    />
  );
}
```

### As a Standalone Page

```tsx
import { MediaManagerPage } from "@/components/admin/media-manager";

function MediaPage() {
  return <MediaManagerPage />;
}
```

### Backward Compatibility

Old imports still work via wrapper files:

```tsx
// Old way (still works)
import { MediaManager } from "@/components/admin/MediaManager";

// New way (recommended)
import { MediaManager } from "@/components/admin/media-manager";
```

## 🗄️ Database Schema

### New Tables

**`media_folders`** - Folder organization

```sql
CREATE TABLE media_folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
```

**Updated `media` table** - Added folder support

```sql
ALTER TABLE media ADD COLUMN folder_id TEXT;
```

## 🌐 API Endpoints

### Media Files

- `GET /api/media` - List files with pagination and filtering
  - Query params: `page`, `limit`, `search`, `folderId`
- `POST /api/media/upload` - Upload files
  - Body: `FormData` with `files` and optional `folderId`
- `GET /api/media/:id` - Get file details
- `PATCH /api/media/:id` - Update file metadata
  - Body: `{ filename?, folderId? }`
- `DELETE /api/media/:id` - Delete file

### Folders

- `GET /api/media/folders` - List all folders
- `POST /api/media/folders` - Create folder
  - Body: `{ name, parentId? }`
- `DELETE /api/media/folders/:id` - Delete folder (moves files to root)

### Bulk Operations

- `POST /api/media/move` - Move files to folder
  - Body: `{ fileIds: string[], folderId: string | null }`

## 🔐 Security

All media API endpoints are protected by authentication middleware:

- Clerk authentication required
- Organization gating (if `CLERK_ALLOWED_ORG_ID` is set)
- See `src/middleware.ts` for details

## 🎨 Components API

### MediaManager Props

```typescript
interface MediaManagerProps {
  onSelect?: (file: MediaFile) => void;
  onSelectMultiple?: (files: MediaFile[]) => void;
  maxFiles?: number;
  selectedFiles?: MediaFile[];
  triggerLabel?: string;
  acceptedFileTypes?: string; // e.g., "image/*"
  maxFileSize?: number; // in MB
}
```

### MediaFile Type

```typescript
interface MediaFile {
  id: string;
  url: string;
  filename: string;
  size: number;
  mimeType: string;
  folderId?: string | null;
  createdAt: Date;
  updatedAt?: Date;
}
```

## 🔨 Customization

### Adjusting File Size Limits

```tsx
<MediaManager maxFileSize={20} /> // 20MB limit
```

### Accepting Different File Types

```tsx
<MediaManager acceptedFileTypes="image/png,image/jpeg" />
```

### Custom Validation

Extend `src/components/admin/media-manager/utils/validators.ts` for custom validation logic.

## 📊 Performance

- **Pagination**: Loads 20 files per page by default
- **Debounced Search**: 500ms delay to reduce API calls
- **Lazy Loading**: Images use `loading="lazy"`
- **Optimistic Updates**: UI updates before API confirms
- **Error Recovery**: Automatic rollback on failed operations

## 🧪 Testing Checklist

Before deploying, verify:

- [ ] File upload (single and multiple)
- [ ] Drag and drop upload
- [ ] File deletion (single and bulk)
- [ ] Folder creation and deletion
- [ ] Moving files between folders
- [ ] Search functionality
- [ ] Pagination (load more)
- [ ] Preview dialog navigation
- [ ] Copy URL functionality
- [ ] Download functionality
- [ ] Selection mode
- [ ] All existing components using MediaManager still work

## 🚀 Migration Path

### For Existing Implementations

No changes required! The backward-compatible wrappers maintain the old import paths:

```tsx
// This still works
import { MediaManager } from "@/components/admin/MediaManager";
```

### Database Migration

Run the migration to add folder support:

```bash
npx drizzle-kit generate --name add_media_folders
npx drizzle-kit migrate
```

## 📝 Future Enhancements

Potential improvements for future iterations:

1. **Image Optimization**

   - Automatic image compression
   - Multiple size variants
   - WebP conversion

2. **Advanced Features**

   - Tags and labels
   - Advanced sorting
   - Date range filtering
   - File type filtering
   - Bulk editing
   - Duplicate detection

3. **Performance**

   - Virtual scrolling for large galleries
   - Image thumbnails
   - CDN integration

4. **Accessibility**
   - Screen reader improvements
   - Keyboard shortcuts
   - Focus management

## 🐛 Troubleshooting

### Files not uploading

- Check file size limits
- Verify R2 credentials in environment variables
- Check browser console for errors

### Folder not showing

- Ensure database migration has run
- Check API endpoint connectivity
- Verify authentication

### Search not working

- Ensure debounce is configured
- Check API query parameters
- Verify database connection

## 📞 Support

For issues or questions:

1. Check this README
2. Review component source code
3. Check browser console for errors
4. Verify API responses in Network tab
