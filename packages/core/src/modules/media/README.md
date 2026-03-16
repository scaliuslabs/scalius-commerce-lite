# Media

File upload/storage/folder management for product images and assets via Cloudflare R2.

## Files

- `index.ts` -- barrel exports
- `media.service.ts` -- `MediaService` (listFiles, uploadFiles, updateFile, deleteFile, moveFiles, listFolders, createFolder, deleteFolder)
- `media.schema.ts` -- Zod validation schemas

## Dependencies

- `@scalius/database` -- `media`, `mediaFolders`
- `@scalius/core/integrations/storage` -- R2 upload/delete helpers
