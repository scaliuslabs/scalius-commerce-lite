# Media

File upload, storage, and folder management for product images and other media assets. Uploads to Cloudflare R2.

## Exports

- `MediaService.listFiles()` — paginated file listing with search and folder filtering
- `MediaService.uploadFiles()` — batch file upload to R2 with size/count validation
- `MediaService.updateFile()` / `MediaService.deleteFile()` — file mutations
- `MediaService.moveFiles()` — bulk move files between folders
- `MediaService.listFolders()` / `MediaService.createFolder()` / `MediaService.deleteFolder()` — folder CRUD
- `mediaSchema` — Zod validation schemas

## Dependencies

- `@scalius/database` — `media`, `mediaFolders` tables
- `@scalius/core/integrations/storage` — R2 upload/delete helpers

## API Routes

- `GET /api/v1/media` — list media files
- `POST /api/v1/media` — upload files
- `DELETE /api/v1/media/:id` — delete a file
- `GET /api/v1/media/folders` — list folders
