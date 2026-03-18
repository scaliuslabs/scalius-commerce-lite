# Media Module

Server-side media management: R2 upload/delete, folder organization, and DB CRUD for the `media` and `media_folders` tables.

## Files

```
media/
  index.ts             -- barrel exports (re-exports schema + service)
  media.schema.ts      -- Zod validation schemas (updateMedia, moveMedia, createFolder)
  media.service.ts     -- MediaService object with all business logic
```

## Database Tables

**`media`** (defined in `packages/database/src/schema/products.ts`)

| Column     | Type      | Notes                                           |
|------------|-----------|--------------------------------------------------|
| id         | text PK   | `"media_" + nanoid()`                            |
| filename   | text      | Original filename from upload                    |
| url        | text      | `"{R2_PUBLIC_URL}/{nanoid}.{ext}"` or bare key   |
| size       | integer   | File size in bytes                               |
| mimeType   | text      | e.g. `image/jpeg`, `image/webp`                  |
| folderId   | text null | FK to `media_folders.id`, ON DELETE SET NULL      |
| createdAt  | timestamp | Unix seconds                                     |
| updatedAt  | timestamp | Unix seconds                                     |
| deletedAt  | timestamp | Soft delete (currently unused by service -- hard deletes only) |

Indexes: `media_folder_id_idx`, `media_deleted_at_idx`

**`media_folders`** (defined in `packages/database/src/schema/products.ts`)

| Column     | Type      | Notes                          |
|------------|-----------|--------------------------------|
| id         | text PK   | `"folder_" + nanoid()`         |
| name       | text      |                                |
| parentId   | text null | Self-referential (no FK)       |
| createdAt  | timestamp | Unix seconds                   |
| updatedAt  | timestamp | Unix seconds                   |
| deletedAt  | timestamp | Soft delete                    |

## MediaService Methods

| Method        | Signature                                                             | Behavior                                                                                        |
|---------------|-----------------------------------------------------------------------|-------------------------------------------------------------------------------------------------|
| `listFiles`   | `(db, page, limit, searchQuery, folderId?) => {files, pagination}`   | Paginated list. `folderId` of `"all"` returns all, `"root"`/`"null"`/`""` returns root (no folder), else filters by folder ID. Filters by `deletedAt IS NULL`, optional LIKE search on filename. |
| `uploadFiles` | `(db, files: File[], folderId) => response`                         | Validates each file (max 20MB, max 50 files). Uploads in batches of 5 with 100ms inter-batch delay. Calls `uploadFile()` from `@scalius/core/integrations/storage`. Returns `{files, summary}` with status 201/207/400. On total failure throws `ValidationError`. |
| `updateFile`  | `(db, id, {filename?, folderId?}) => file`                          | Updates metadata only (filename, folder). Throws `NotFoundError` if missing.                   |
| `deleteFile`  | `(db, id) => void`                                                   | Extracts R2 key from URL (last path segment), calls `deleteFile()` from storage, then hard-deletes DB row. Throws `NotFoundError` if missing. |
| `moveFiles`   | `(db, fileIds[], folderId) => void`                                  | Bulk update `folderId` using `inArray`.                                                         |
| `listFolders` | `(db) => folders[]`                                                  | All folders where `deletedAt IS NULL`, ordered by `createdAt DESC`.                            |
| `createFolder`| `(db, name, parentId?) => folder`                                    | Inserts with `"folder_" + nanoid()` ID.                                                        |
| `deleteFolder`| `(db, id) => void`                                                   | Moves all files in folder to root (`folderId = null`), then soft-deletes the folder.           |

## R2 Storage Integration

File: `packages/core/src/integrations/storage.ts`

- **`initStorage(bucket, publicUrl)`** -- called once per Worker isolate from middleware to register the R2 binding and public URL.
- **`uploadFile(file, bucket?, publicUrl?)`** -- validates file (10MB limit, image-only MIME types: JPEG/PNG/GIF/WebP/SVG/BMP/TIFF), generates `nanoid().ext` key, uploads to R2 with `PUT`. Sets `Cache-Control: public, max-age=31536000, immutable` and `customMetadata` with original filename + timestamp. 30s upload timeout via `Promise.race`.
- **`deleteFile(key, bucket?)`** -- deletes object from R2 by key.
- **`getBucket()`** -- returns the registered R2 bucket binding.
- **`extractKeyFromUrl(url)`** -- extracts R2 object key from a full URL.

Upload result shape: `{ key, url, size, filename, mimeType }`.

URL stored in DB is `"{publicUrl}/{key}"` (e.g. `https://cloud.scalius.com/abc123.jpg`). If `R2_PUBLIC_URL` is not configured, only the bare key is stored.

## Image Optimization (Shared Utilities)

File: `packages/shared/src/image-optimizer.ts`

Uses Cloudflare Image Resizing (`/cdn-cgi/image/params/path`). Pure module -- callers pass `cdnBase` and `isDev` or they are auto-detected from `import.meta.env` / `window.location`.

**Key functions:**

| Function                | Purpose                                                                                   |
|-------------------------|-------------------------------------------------------------------------------------------|
| `getOptimizedImageUrl`  | Generates optimized URL. Merges with defaults (600x600, q85, cover, sharpen=1). Adds `onerror=redirect` for graceful fallback. Routes transforms through the image's own origin. Skips transforms in dev (localhost). |
| `getOriginalImageUrl`   | Strips `/cdn-cgi/image/` prefix to recover the original URL. Used for downloads and clipboard copy. |
| `isR2Image`             | Checks if a URL is hosted on the CDN domain.                                              |
| `getOptimizedImageProps`| Returns `{src, alt, loading: "lazy", decoding: "async"}` for `<img>` elements.            |
| `getResponsiveSrcSet`   | Generates srcset string for widths `[320, 640, 768, 1024, 1280]` (configurable).          |

**ImagePresets:**

| Preset              | Dimensions   | Quality |
|---------------------|-------------|---------|
| `productThumbnail`  | 200x200     | 75      |
| `productCard`       | 400x400     | 75      |
| `productDetail`     | 800x800     | 85      |
| `hero`              | 1920x600    | 90      |
| `heroMobile`        | 768x400     | 85      |

File: `packages/shared/src/media-url.ts`

**`resolveMediaUrl(url, cdnBase)`** -- resolves bare R2 keys (e.g. `abc123.jpg`) to full CDN URLs (`https://cloud.scalius.com/abc123.jpg`). Passes through absolute URLs, `/cdn-cgi/` paths, and local paths unchanged.

## API Endpoints

All mounted under `/api/v1/admin/media` (admin-only, auth required).

| Method   | Path                 | Description                     | Response       |
|----------|----------------------|---------------------------------|----------------|
| GET      | `/`                  | List files (paginated, search, folder filter) | 200 `{files, pagination}` |
| POST     | `/upload`            | Multipart upload (field: `files`, optional `folderId`) | 201/207 `{files, summary, warnings?}` |
| PATCH    | `/{id}`              | Update file metadata            | 200 `{file}`   |
| PUT      | `/{id}`              | Update file metadata (alias)    | 200 `{file}`   |
| DELETE   | `/{id}`              | Delete file (R2 + DB)           | 204            |
| POST     | `/move`              | Move files to folder            | 200 `{message}` |
| GET      | `/folders`           | List all folders                | 200 `{folders}` |
| POST     | `/folders`           | Create folder                   | 201 `{folder}` |
| DELETE   | `/folders/{id}`      | Delete folder (soft)            | 204            |

**Media server** (local dev only): `GET /media/{key}` -- serves R2 objects directly with `Cache-Control: public, max-age=31536000`. Defined in `apps/api/src/routes/media-server.ts`.

## Dependencies

- `@scalius/database` -- `media`, `mediaFolders` tables
- `@scalius/core/integrations/storage` -- R2 `uploadFile()`, `deleteFile()`
- `@scalius/core/errors` -- `NotFoundError`, `ValidationError`
- `nanoid` -- ID generation
- `drizzle-orm` -- query building

## Known Gaps

- **No `alt` field on media table** -- images have no alt-text metadata in DB.
- **No dimensions stored** -- width/height of uploaded images are not captured or stored.
- **Hard delete only** -- `MediaService.deleteFile()` hard-deletes the DB row despite the table having a `deletedAt` column. No soft-delete/trash for individual files.
- **Bulk delete is sequential** -- `MediaApiClient.deleteFiles()` deletes one-by-one in a loop (no batch endpoint). Slow for large selections.
- **No rename of R2 keys** -- renaming a file only updates `media.filename` in DB, not the R2 object key. The URL never changes.
- **Upload limit mismatch** -- service allows 50 files per upload, admin UI advertises "Max 20 files" and defaults `MAX_FILES_PER_UPLOAD = 20` in types. Storage layer validates 10MB, service validates 20MB.
- **`parentId` on folders is unused** -- the column exists, `createFolder` accepts it, but FolderBrowser is flat (no nested folder tree rendering).
- **No `sortBy`/`sortOrder` support server-side** -- `listFiles` always sorts by `createdAt DESC`. The filter bar sends `sortBy`/`sortOrder` params but the API ignores them.
