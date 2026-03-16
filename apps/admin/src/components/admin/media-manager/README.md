# Media Manager

Admin component for file upload, storage, and folder management. Dialog mode for selecting media, page mode for standalone management.

## Files

```
media-manager/
  MediaManager.tsx           -- dialog mode (select media)
  MediaManagerPage.tsx       -- standalone page mode
  api/
    mediaClient.ts           -- centralized API calls
  components/
    MediaCard.tsx            -- individual file card
    MediaGallery.tsx         -- grid gallery view
    MediaUploadZone.tsx      -- upload with drag-and-drop
    MediaPreview.tsx         -- full-screen preview dialog
    MediaFilterBar.tsx       -- search and filter controls
    FolderBrowser.tsx        -- folder navigation sidebar
  hooks/
    useMediaFiles.ts         -- file management state
    useMediaUpload.ts        -- upload handling
    useFolders.ts            -- folder management
  types/
    index.ts                 -- MediaFile, MediaManagerProps
  utils/
    formatters.ts            -- date, size formatters
    validators.ts            -- file validation
    debounce.ts              -- debounce utility
```

No local BulkActionDialog -- uses inline multi-select with bulk delete.
