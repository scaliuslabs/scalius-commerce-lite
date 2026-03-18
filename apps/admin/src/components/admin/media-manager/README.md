# Media Manager

Admin UI for file upload, storage, and folder management. Two modes: **dialog** (media picker for forms) and **page** (standalone `/admin/media` route).

## Files

```
media-manager/
  index.ts                 -- barrel exports (MediaManager, MediaManagerPage, types)
  MediaManager.tsx         -- dialog mode: opens in a Dialog, supports onSelect / onSelectMultiple
  MediaManagerPage.tsx     -- standalone page mode: full-page Card layout, drag-and-drop overlay
  api/
    index.ts               -- re-exports mediaClient
    mediaClient.ts         -- MediaApiClient: static methods for all API calls
  components/
    index.ts               -- re-exports all components
    MediaCard.tsx           -- individual file card with lazy-load, preview, actions dropdown
    MediaGallery.tsx        -- responsive grid (2-6 cols), skeleton loader, "Load More" pagination
    MediaUploadZone.tsx     -- file input + drag-and-drop zone (used standalone, not in current flow)
    MediaPreview.tsx        -- full-screen preview dialog with prev/next navigation
    MediaFilterBar.tsx      -- toolbar: upload button, search toggle, selection mode, bulk actions, move-to-folder
    FolderBrowser.tsx       -- collapsible sidebar: "All Files", "Uncategorized", named folders with color-coded icons
  hooks/
    index.ts               -- re-exports all hooks
    useMediaFiles.ts       -- file list state, pagination, search, delete (optimistic), race-condition prevention via requestId ref
    useMediaUpload.ts      -- upload orchestration with client-side validation, progress tracking, partial-success handling
    useFolders.ts          -- folder CRUD, currentFolderId state, auto-load option
  types/
    index.ts               -- all TypeScript interfaces and constants
  utils/
    index.ts               -- re-exports all utils
    formatters.ts          -- formatFileSize, formatDate, formatDateTime, formatFileType, truncateFilename, bytesToMB, mbToBytes
    validators.ts          -- validateFileSize, validateFileType, validateFiles, isImageFile, filterImageFiles
    debounce.ts            -- generic debounce function
```

## Usage

### Dialog Mode (Media Picker)

```tsx
import { MediaManager } from "@/components/admin/media-manager";

// Single select
<MediaManager onSelect={(file) => setImage(file)} triggerLabel="Choose Image" />

// Multi select
<MediaManager
  onSelectMultiple={(files) => setGallery(files)}
  selectedFiles={existingFiles}
/>
```

Props (`MediaManagerProps`):
- `onSelect?: (file: MediaFile) => void` -- single file selection, closes dialog
- `onSelectMultiple?: (files: MediaFile[]) => void` -- multi-select mode, "Add (N)" button
- `selectedFiles?: MediaFile[]` -- pre-selects files when dialog opens
- `triggerLabel?: string` -- button text (default: "Select Image")
- `acceptedFileTypes?: string` -- MIME filter (default: `"image/*"`)
- `maxFileSize?: number` -- max size in MB (default: 10)
- `dialogClassName?: string` -- custom className for DialogContent

### Page Mode

```astro
<!-- apps/admin/src/pages/admin/media.astro -->
<MediaManagerPage client:idle />
```

Full-page variant inside a Card. Same features as dialog but no file selection callbacks. Supports a full-page drag overlay for uploads.

### MediaPickerButton

File: `apps/admin/src/components/admin/MediaPickerButton.tsx`

Thin wrapper around `MediaManager` that renders a preview of the currently selected image above the picker button. Used in forms where a single image field is needed.

### DraggableImageGallery

File: `apps/admin/src/components/admin/DraggableImageGallery.tsx`

Drag-and-drop reorderable image grid for product forms. Uses `@dnd-kit/core` + `@dnd-kit/sortable` with `rectSortingStrategy`. Features:
- Drag-to-reorder with smooth animations (live reorder via `onDragOver`, not just `onDragEnd`)
- DragOverlay rendered via portal for correct stacking
- "Primary" badge on first image
- Optional color mapping (variant images mapped to color options)
- Expand/collapse beyond `maxVisible` (default 6) with gradient fade
- Uses `getOptimizedImageUrl()` from `@scalius/shared/image-optimizer` for thumbnail display
- Remove button per image (X icon, top-right)

## MediaApiClient Methods

All calls go through admin proxy at `/api/v1/admin/media/*`.

| Method               | HTTP                            | Notes                                                                 |
|----------------------|---------------------------------|-----------------------------------------------------------------------|
| `fetchFiles`         | `GET /`                         | Handles both raw API envelope and proxy-unwrapped response. Page size default: 12 (set in hook, not client). |
| `uploadFiles`        | `POST /upload`                  | Multipart FormData. Returns `MediaFile[]` or `{files, warnings, summary}`. Handles 201/207/4xx/5xx. |
| `deleteFile`         | `DELETE /{id}`                  | Single file.                                                          |
| `deleteFiles`        | Sequential `DELETE /{id}` loop  | No batch endpoint. Returns `{success, failed}` counts.                |
| `fetchFolders`       | `GET /folders`                  | Handles both envelope formats.                                        |
| `createFolder`       | `POST /folders`                 | Body: `{name, parentId?}`.                                            |
| `deleteFolder`       | `DELETE /folders/{id}`          |                                                                       |
| `moveFilesToFolder`  | `POST /move`                    | Body: `{fileIds[], folderId}`.                                        |
| `updateFileMetadata` | `PATCH /{id}`                   | Body: `{filename?, folderId?}`. Not used in current UI flow.          |

Envelope handling: all `fetchFiles`/`fetchFolders`/`updateFileMetadata` methods check for `json.data` (raw API envelope) vs top-level fields (proxy-unwrapped), handling both transparently.

## Hooks

### useMediaFiles(autoLoad)

State: `files`, `isLoading`, `isLoadingMore`, `currentPage`, `totalPages`, `filters`.

- Uses `currentRequestId` ref to prevent race conditions when rapidly switching folders
- Deduplicates files by ID on infinite-scroll append to prevent React key crashes
- Optimistic delete: removes from UI immediately, reverts on API error
- Does not clear files on page 1 reload to prevent "no files" flicker
- Page size: 12 items (hardcoded in hook)

### useMediaUpload(options)

Options: `maxSizeMB`, `acceptedTypes`, `maxFiles`, `folderId`, `onUploadComplete`.

- Validates all files client-side before upload (size, type, count)
- Single API call with all files in one FormData
- Handles partial success (207): shows summary toast + detailed failure toast after 600ms delay
- Returns `{isUploading, uploadProgress, currentUploadStatus, uploadFiles}`

### useFolders(autoLoad)

- `currentFolderId` defaults to `"all"` (shows all files across all folders)
- `moveToFolder(folderId)` just sets state; file reload is driven by useEffect on `currentFolderId`
- Optimistic folder delete: removes from state, resets to root if current folder was deleted

## Component Details

### MediaCard

- IntersectionObserver-based lazy loading with 50px rootMargin
- Uses `getOptimizedImageUrl()` for thumbnails (default 600x600)
- Uses `getOriginalImageUrl()` for copy-URL and download actions
- Hover overlay with: preview (ZoomIn), dropdown (Copy URL, Download, Delete)
- Selection mode: checkbox overlay, ring-2 highlight, CheckCircle2 center icon
- Constrains rendered image to max 300x300px with `will-change: auto`

### MediaGallery

- Responsive grid: 2/3/4/5/6 columns at breakpoints
- Skeleton loader: 12 cards matching page size
- "Load More" button for infinite-scroll pagination
- Shows loading indicator when switching folders (overlay on existing files)

### FolderBrowser

- Collapsible sidebar (chevron toggle, default expanded)
- Three top-level items: "All Files" (shows everything), "Uncategorized" (root, no folder), named folders
- Folder search/filter input
- Color-coded folder icons via hash of folder ID
- Create folder dialog (Enter key to submit)
- Delete folder with AlertDialog confirmation
- Collapsed mode: icon-only buttons

### MediaFilterBar

- Upload button (creates hidden file input, triggers `onUpload`)
- Expandable search input (toggle visibility)
- Selection mode toggle (Select/Exit)
- When selection active: count display, Select All, move-to-folder dropdown, Add (N) button (multi-select), bulk delete
- Move-to-folder: Select dropdown with "Uncategorized" + all folders

### MediaPreview

- Full-screen dialog (max-w-5xl, 90vh)
- Prev/Next navigation arrows
- Header: filename, size, MIME type, date, position counter
- Optional "Select This Image" button (dialog mode only)
- Uses `getOptimizedImageUrl()` for display

### MediaUploadZone

- Standalone upload component (not currently wired into the main flow -- upload goes through MediaFilterBar button and dialog-level drag-and-drop)
- Drag-and-drop with overlay animation
- File input with `accept` filter
- Progress bars per file
- `filterImageFiles()` on drop to reject non-images

## ID Prefixing

When files are selected (single or multi), their IDs are prefixed with `"temp_"` before passing to `onSelect`/`onSelectMultiple`. This distinguishes newly-selected media manager files from existing product image IDs in the parent form. The `selectedFiles` effect strips `"temp_"` prefix when re-opening the dialog.

## Known Gaps

- **No file rename UI** -- `MediaApiClient.updateFileMetadata` exists but no component exposes it (no inline rename in MediaCard).
- **Upload progress is fake** -- `uploadProgress` state is initialized but never updated with real progress. The upload is a single fetch call, not chunked. The progress bar shows 100% with pulse animation.
- **MediaUploadZone is orphaned** -- the component exists but is not used in either MediaManager or MediaManagerPage. Upload is handled by the MediaFilterBar button and dialog-level drag-and-drop handlers.
- **No sort controls** -- `MediaFilterOptions` defines `sortBy`/`sortOrder` fields and `MediaApiClient.fetchFiles` sends them as query params, but the API ignores them (always `createdAt DESC`) and no UI sort controls exist.
- **No file type filter** -- `MediaFilterOptions.fileType` exists in types but is never set or used.
- **No date range filter** -- `MediaFilterOptions.dateFrom`/`dateTo` exist in types but are never set or used.
- **Bulk delete is sequential** -- no batch delete API endpoint; files are deleted one at a time.
- **Page size mismatch** -- `ITEMS_PER_PAGE` in types is 20, but `useMediaFiles` hardcodes 12 in the `fetchFiles` call.
