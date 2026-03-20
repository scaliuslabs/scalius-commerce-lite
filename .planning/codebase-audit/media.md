# Media Domain Audit

**Analysis Date:** 2026-03-20
**Scope:** Complete vertical slice -- schema, core service, storage integration, API routes, admin UI, shared utilities, storefront wrappers

## Summary

The media domain is a fully functional image upload/management system built on Cloudflare R2. The architecture follows a clean vertical slice: schema in `packages/database/src/schema/products.ts`, core service in `packages/core/src/modules/media/`, R2 integration in `packages/core/src/integrations/storage.ts`, API routes in `apps/api/src/routes/admin/media.ts`, a well-organized admin UI component tree in `apps/admin/src/components/admin/media-manager/`, and shared image optimization utilities in `packages/shared/src/`. The storefront wraps shared utilities with runtime CDN context.

**Overall quality:** Solid for its scope. Good separation of concerns, well-structured admin UI with barrel exports, and a robust shared image optimization layer. However, there are several consistency issues between layers (limit mismatches, duplicate validation, non-atomic delete), a significant code duplication between MediaManager and MediaManagerPage, and the API route layer contains error handling antipatterns that bypass the codebase's established patterns.

---

## Critical Issues

### 1. Delete is non-atomic: R2 deletion before DB deletion

**Files:** `packages/core/src/modules/media/media.service.ts` (lines 171-179)

```typescript
export async function deleteMediaFile(dbOp: Database, id: string) {
    const [file] = await dbOp.select().from(media).where(eq(media.id, id));
    if (!file) throw new NotFoundError("File not found");
    const key = file.url.split("/").pop()!;  // fragile extraction
    await deleteFile(key);                    // R2 delete first
    await dbOp.delete(media).where(eq(media.id, id));  // DB delete second
}
```

**Problem:** If R2 delete succeeds but DB delete fails (e.g., D1 transient error), the R2 file is permanently deleted but the media row persists as an orphan pointing to a nonexistent file. The user sees the entry but the image is gone.

**Also:** The key extraction `file.url.split("/").pop()!` is fragile. If the URL contains query parameters or a trailing slash, it extracts the wrong key. The codebase already has `extractKeyFromUrl()` in `packages/core/src/integrations/storage.ts` (line 203) which properly uses `new URL()` parsing, but it is not used here.

**Fix:** Reverse the operation order -- delete DB row first (or soft-delete), then R2. If R2 delete fails, the orphaned R2 object is harmless (just storage cost) and can be cleaned up later. Also use `extractKeyFromUrl()` instead of manual string splitting.

### 2. Upload response includes `status` field inside response data -- envelope violation

**Files:**
- `packages/core/src/modules/media/media.service.ts` (lines 125-154)
- `apps/api/src/routes/admin/media.ts` (line 96)

The `uploadMediaFiles()` service returns a `Record<string, unknown>` with a `status` field (201, 207, or 400). The API route then inspects `result.status === 201` to decide between `created(c, result)` and `ok(c, result)`. The problem: the `status` field is included *inside* the response envelope's `data` field, so the client receives:

```json
{ "success": true, "data": { "files": [...], "summary": "...", "status": 201 } }
```

This violates the documented response envelope contract (CLAUDE.md: "The T passed to ok(c, T) must be the FINAL payload -- never include redundant success: true or data: wrapping inside T"). The `status` field bleeds service-internal logic into the API contract.

**Fix:** The service should return `{ files, summary, warnings? }` only. Move the status code decision to the API route layer where it belongs. Use the presence of `warnings` (or `errors.length > 0`) to determine 207 vs 201.

### 3. No orphan cleanup mechanism for R2 objects

**Files:** Entire media domain

When a product image is removed from a product (via the product form), the `product_images` row is deleted but the R2 object is never removed. The same URL can exist in both `media.url` and `product_images.url` without any reference counting. There is no scheduled cleanup job to identify R2 objects that have no DB references.

**Impact:** R2 storage costs grow indefinitely. Over time, a significant portion of R2 storage may be orphaned files that no DB row references.

---

## Code Quality Issues

### 4. Massive code duplication: MediaManager vs MediaManagerPage (~80% identical)

**Files:**
- `apps/admin/src/components/admin/media-manager/MediaManager.tsx` (533 lines)
- `apps/admin/src/components/admin/media-manager/MediaManagerPage.tsx` (432 lines)

These two components share approximately 80% identical logic:
- Same state declarations (selectionMode, selectedFileIds, showPreview, previewFile, showDeleteDialog, pendingDeleteFileId, showBulkDeleteDialog, folderSidebarCollapsed)
- Same hook usage (useMediaFiles, useMediaUpload, useFolders)
- Same handler implementations (handleFileSelect, handleFilePreview, handleDeleteConfirmation, handleFileDelete, handleBulkDelete, handleMoveToFolder, navigateToNextImage, navigateToPrevImage)
- Same JSX for delete/bulk-delete confirmation dialogs (verbatim copy)
- Same upload overlay JSX (verbatim copy)

The only structural differences:
1. MediaManager wraps content in a `<Dialog>` with trigger; MediaManagerPage wraps in a `<Card>`
2. MediaManager has `onSelect`/`onSelectMultiple` callbacks; MediaManagerPage does not
3. MediaManager has dialog open/close lifecycle effects; MediaManagerPage mounts directly

**Fix:** Extract a shared `MediaManagerCore` component that accepts a `mode: "dialog" | "page"` prop or uses render props for the outer container. All state, hooks, and handlers should live in a single place.

### 5. API route error handling bypasses established patterns

**Files:** `apps/api/src/routes/admin/media.ts` (lines 97-100, 130-133, 163-166, 217-220)

Four route handlers catch errors with this antipattern:

```typescript
} catch (error: unknown) {
    const err = error as { message?: string; statusCode?: number };
    throw new ApiError(err.statusCode || 400, "ERROR", err.message || "Unknown error");
}
```

This is problematic because:
1. The service already throws `NotFoundError` and `ValidationError` which the global error handler catches correctly. Wrapping them in a generic `ApiError` loses the specific error code/type.
2. The `as` cast is unsafe -- `error` could be anything.
3. The generic "ERROR" code is not useful for debugging.

The codebase convention (CLAUDE.md, other routes like orders/products) is to let service errors propagate to the global handler. These `try/catch` blocks should be removed entirely for the PATCH, PUT, and DELETE handlers. The upload handler needs custom logic for the 201/207 status decision but should still let `ValidationError` propagate.

### 6. Redundant PATCH + PUT routes for the same operation

**Files:** `apps/api/src/routes/admin/media.ts` (lines 103-167)

Two separate route definitions (`patchMediaRoute` and `putMediaRoute`) with identical handler implementations. Both call `updateMediaFile()` with the same arguments. The admin UI uses only PATCH (in `mediaClient.ts` line 266: `method: "PATCH"`). PUT is dead code that pollutes the OpenAPI spec.

**Fix:** Remove the PUT route. PATCH is the semantically correct method for partial updates.

### 7. `debounce` utility returns wrong type and is duplicated

**Files:** `apps/admin/src/components/admin/media-manager/utils/debounce.ts`

```typescript
return debounced as (...args: Parameters<F>) => ReturnType<F>;
```

The debounced function returns `void` (sets a timeout), not `ReturnType<F>`. The type cast lies about the return type. Any caller relying on the return value gets `undefined` at runtime.

Also, `useCallback` wrappers in both MediaManager.tsx (line 149-155) and MediaManagerPage.tsx (line 85-91) pass `debounce` into `useCallback` with dependencies, which means the debounce timer is reset every time dependencies change -- defeating the purpose of debouncing.

---

## Pattern Violations

### 8. File size limit mismatch across layers

| Layer | File | Limit |
|-------|------|-------|
| R2 storage | `packages/core/src/integrations/storage.ts` line 6 | 10 MB |
| Media service | `packages/core/src/modules/media/media.service.ts` line 9 | 10 MB |
| Admin UI types | `apps/admin/src/components/admin/media-manager/types/index.ts` line 101 | 10 MB |
| Admin UI text | MediaManager.tsx line 356-359, MediaManagerPage.tsx line 271-274 | "Max 20 files, 10MB" |
| README | `packages/core/src/modules/media/README.md` line 48 | Claims "max 20MB" |

The 10MB limit is now consistent between storage and service, but the README still says 20MB. The README at line 133 also incorrectly states "service validates 20MB".

### 9. Max files per upload mismatch

| Layer | File | Limit |
|-------|------|-------|
| Media service | `media.service.ts` line 11 | 50 files |
| Admin UI types | `types/index.ts` line 102 | 20 files |
| Admin UI text | MediaManager.tsx line 356 | "Max 20 files" |
| useMediaUpload hook | `hooks/useMediaUpload.ts` line 23 | 20 files (default) |

The service accepts 50 files but the UI caps at 20. Either the service limit is too generous or the UI is unnecessarily restrictive. These should be unified.

### 10. `sortBy` and `sortOrder` filter params are sent but ignored

**Files:**
- `apps/admin/src/components/admin/media-manager/api/mediaClient.ts` (lines 43-49) -- sends `sortBy` and `sortOrder` params
- `apps/admin/src/components/admin/media-manager/types/index.ts` (lines 88-89) -- defines `sortBy` and `sortOrder` in `MediaFilterOptions`
- `packages/core/src/modules/media/media.service.ts` -- `listMediaFiles` has no `sortBy`/`sortOrder` parameters at all, always uses `desc(media.createdAt)`

This is a dead feature -- the UI sends params that the API accepts but the service ignores.

### 11. `temp_` ID prefix convention is fragile and undocumented in types

**Files:** `apps/admin/src/components/admin/media-manager/MediaManager.tsx` (lines 106, 138, 195, 262, 465)

When files are selected, their IDs are prefixed with `"temp_"`. This is stripped back when re-opening the dialog (line 138). The purpose is to distinguish "newly selected from media manager" from "existing product image IDs." However:

1. The `MediaFile` type has `id: string` with no indication that it may be `temp_`-prefixed
2. Any consumer that receives selected files must know about this convention
3. If a media ID legitimately started with `temp_`, the stripping would corrupt it (unlikely with nanoid but still a code smell)

This should be replaced with a proper discriminated type (e.g., `{ source: "media-manager", mediaId: string }`) or handled entirely within the product form layer.

---

## Maintainability Concerns

### 12. Media tables live in `products.ts` schema file

**Files:** `packages/database/src/schema/products.ts` (lines 200-230)

The `media` and `mediaFolders` tables are defined in the products schema file despite being a standalone domain. Other domains have their own schema files (orders, customers, settings). Media should have its own `packages/database/src/schema/media.ts`.

### 13. Untyped service return values

**Files:** `packages/core/src/modules/media/media.service.ts`

`uploadMediaFiles` returns `Record<string, unknown>` (line 125). This loses all type information and forces the API route to cast blindly. Other domain services return properly typed objects.

`updateMediaFile` returns the raw Drizzle result without a defined return type. The API route wraps it as `{ file }` but there is no type contract.

### 14. Three layers of file validation

File validation happens in three separate layers with slightly different logic:

1. **Admin UI** (`utils/validators.ts`): Checks file count, size, and MIME type against `image/*` wildcard
2. **Core service** (`media.service.ts`): Checks file count (50 limit), size (10MB), empty files, filename
3. **Storage** (`storage.ts`): Checks size (10MB), MIME type against specific allowlist, file extension

Validation at layer 1 can reject files that layer 3 would accept (e.g., specific types), or accept files that layer 3 rejects (e.g., `image/avif` matches `image/*` but is not in `ALLOWED_IMAGE_TYPES`). The storage layer's MIME type allowlist and extension allowlist are the source of truth but the UI gives misleading feedback.

### 15. No shared error types between admin UI and API

**Files:** `apps/admin/src/components/admin/media-manager/api/mediaClient.ts`

The upload client manually constructs error objects with ad-hoc `details` and `summary` properties (lines 105-113):

```typescript
const error: Error & { details?: ...; summary?: string } = new Error(errorMessage);
```

This is brittle -- if the API changes its error shape, the client silently loses information. A shared error type or at minimum a documented contract would prevent drift.

---

## Performance & Scalability

### 16. Bulk delete is N sequential HTTP requests

**Files:** `apps/admin/src/components/admin/media-manager/api/mediaClient.ts` (lines 164-182)

```typescript
static async deleteFiles(fileIds: string[]): Promise<{ success: number; failed: number }> {
    for (const fileId of fileIds) {
        try {
            await this.deleteFile(fileId);  // One HTTP request per file
            success++;
        } catch { failed++; }
    }
}
```

For a user selecting 20 files and clicking "Delete All", this fires 20 sequential HTTP round-trips. Each one hits the API, queries the DB, deletes from R2, then deletes from DB. With typical worker latency, this takes 5-10 seconds.

**Fix:** Add a bulk delete API endpoint (`DELETE /api/v1/admin/media` with body `{ ids: string[] }`) that handles all deletions in a single request using `db.batch()` for the DB operations.

### 17. Upload batching uses `setTimeout` delay in Worker context

**Files:** `packages/core/src/modules/media/media.service.ts` (lines 120-122)

```typescript
if (batchEnd < files.length) {
    await new Promise(resolve => setTimeout(resolve, 100));
}
```

The service uploads files in batches of 5 with a 100ms inter-batch delay. In a Cloudflare Worker context, this delay is wasted CPU time that counts against the request duration limit. R2 PUT operations are already handled by the R2 binding and do not benefit from artificial throttling. The Worker subrequest limit (1000 per request) is the actual constraint, and 50 uploads is well under that.

### 18. List query runs two separate queries instead of using COUNT with window function

**Files:** `packages/core/src/modules/media/media.service.ts` (lines 29-38)

```typescript
const countArr = await dbOp.select({ count: sql<number>`count(*)` }).from(media).where(whereClause);
const files = await dbOp.select().from(media).where(whereClause).orderBy(...).limit(...).offset(...);
```

Two separate D1 round-trips for every page load. These could be batched with `db.batch()` or, for SQLite/D1, use a window function `COUNT(*) OVER()` in a single query.

### 19. MediaCard IntersectionObserver creates one observer per card

**Files:** `apps/admin/src/components/admin/media-manager/components/MediaCard.tsx` (lines 52-72)

Each MediaCard creates its own `IntersectionObserver` instance. With 12 cards per page (plus any from "Load More"), this is 12+ observer instances. A single shared observer at the gallery level would be more efficient.

### 20. Image optimization in admin uses default 600x600 for thumbnails

**Files:** `apps/admin/src/components/admin/media-manager/components/MediaCard.tsx` (line 164)

```typescript
src={getOptimizedImageUrl(file.url)}
```

Called without any options, this uses the default `600x600, quality 85` -- oversized for the gallery card which renders at `maxWidth: 300px, maxHeight: 300px`. Using `ImagePresets.productThumbnail` (200x200) or a custom `{ width: 300, height: 300, quality: 75 }` would reduce bandwidth by ~75%.

Similarly, `MediaPreview.tsx` line 56 uses default 600x600 for a full-screen preview where the image renders at up to 90vh height. It should use at least `{ width: 1200, height: 1200, quality: 90 }`.

---

## Robustness Gaps

### 21. No upload retry on transient R2 failures

**Files:** `packages/core/src/integrations/storage.ts` (lines 141-169)

If the R2 PUT operation fails with a transient error (e.g., `NetworkingError`), the upload fails permanently. The user must re-upload manually. A single retry with exponential backoff would cover most transient failures.

### 22. Upload timeout leaks on success

**Files:** `packages/core/src/integrations/storage.ts` (lines 153-158)

```typescript
const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Upload timeout after ${UPLOAD_TIMEOUT} ms`)), UPLOAD_TIMEOUT)
);
await Promise.race([uploadPromise, timeoutPromise]);
```

If the upload succeeds quickly, the timeout `setTimeout` still fires after 30 seconds. In a Cloudflare Worker, this extends the request lifetime unnecessarily. The timeout should be cleared on upload success using `AbortController` or by storing and clearing the timer ID.

### 23. Folder delete does not check for child folders

**Files:** `packages/core/src/modules/media/media.service.ts` (lines 201-204)

```typescript
export async function deleteMediaFolder(dbOp: Database, id: string) {
    await dbOp.update(media).set({ folderId: null, ... }).where(eq(media.folderId, id));
    await dbOp.update(mediaFolders).set({ deletedAt: new Date() }).where(eq(mediaFolders.id, id));
}
```

If the folder has child folders (via `parentId`), those child folders become orphaned -- their `parentId` points to a soft-deleted folder. The function should either recursively soft-delete children or re-parent them to null.

### 24. `listMediaFiles` is vulnerable to SQL wildcard injection

**Files:** `packages/core/src/modules/media/media.service.ts` (line 18)

```typescript
if (searchQuery) conditions.push(like(media.filename, `%${searchQuery}%`));
```

If `searchQuery` contains `%` or `_` characters, they are interpreted as SQL wildcards. A search for `50%_off.png` would match far more files than intended. The query should escape these characters: `searchQuery.replace(/%/g, '\\%').replace(/_/g, '\\_')`.

### 25. No protection against concurrent uploads to the same folder

**Files:** `packages/core/src/modules/media/media.service.ts` (lines 51-155)

Two simultaneous bulk uploads can interleave their DB inserts without any coordination. While this is unlikely to cause data corruption (each insert is independent), the response `summary` counts may be misleading if the caller is counting total files. More importantly, the DB count query for pagination could return stale results if another upload completes mid-listing.

### 26. `createFolder` does not check for duplicate folder names

**Files:** `packages/core/src/modules/media/media.service.ts` (lines 189-199)

A user can create multiple folders with the exact same name at the same level. The UI does not prevent this and the service does not enforce uniqueness. This leads to confusion when multiple folders named "Products" appear in the sidebar.

---

## LLM-Friendliness

### Strengths

1. **Clean barrel exports** -- Every subdirectory in the media-manager component tree has an `index.ts` that re-exports named exports. Navigation is straightforward.

2. **README.md in core module** -- `packages/core/src/modules/media/README.md` has comprehensive documentation including table schemas, method signatures, API endpoints, and known gaps. An LLM can understand the domain from this single file.

3. **Typed interfaces** -- `types/index.ts` defines clear interfaces for MediaFile, MediaFolder, MediaManagerProps, etc. The type surface is discoverable.

4. **Separation of concerns** -- Hooks (state), api (HTTP), components (rendering), utils (pure functions) are in dedicated subdirectories with clear responsibilities.

5. **Image optimizer is pure** -- `packages/shared/src/image-optimizer.ts` accepts explicit `ImageContext` rather than reaching into environment, making it testable and predictable.

### Weaknesses

1. **`Record<string, unknown>` return type** in `uploadMediaFiles` forces any consumer to guess the shape. An LLM modifying the upload flow would have to trace the implementation to understand what fields are available.

2. **`temp_` ID prefix convention** is not documented in types and requires reading MediaManager.tsx comments to understand. An LLM adding a new consumer of MediaManager would likely not prefix/strip IDs correctly.

3. **Dual component code** -- An LLM asked to "add a rename feature to the media manager" would need to modify both MediaManager.tsx and MediaManagerPage.tsx identically. There is no indication that changes to one must be mirrored in the other.

4. **Error handling in the API route** uses `as` casts that an LLM would propagate when adding new routes: `const err = error as { message?: string; statusCode?: number }`. This pattern should be replaced with `instanceof` checks or let errors propagate.

5. **Magic strings** -- `"all"`, `"root"`, `"null"` are used as special folder IDs throughout the codebase without a central enum or constant definition.

---

## Recommended Changes

### Priority 1 -- Data Integrity

1. **Reverse delete order in `deleteMediaFile`**: Delete DB row first, then R2 object. Use `extractKeyFromUrl()` instead of `file.url.split("/").pop()!`.
   - File: `packages/core/src/modules/media/media.service.ts` lines 171-179

2. **Remove `status` field from upload response data**: Return only `{ files, summary, warnings? }` from `uploadMediaFiles`. Move the 201/207 decision to the API route layer by checking `warnings?.length > 0`.
   - Files: `packages/core/src/modules/media/media.service.ts` lines 125-154, `apps/api/src/routes/admin/media.ts` line 96

### Priority 2 -- Maintainability

3. **Extract shared MediaManagerCore component**: Merge ~400 lines of duplicated state/handlers/UI from MediaManager.tsx and MediaManagerPage.tsx into a single component with mode prop.
   - Files: `apps/admin/src/components/admin/media-manager/MediaManager.tsx`, `MediaManagerPage.tsx`

4. **Remove try/catch wrappers from API route handlers**: Let `NotFoundError`/`ValidationError` propagate to the global handler. Remove the PATCH, PUT, and DELETE catch blocks entirely.
   - File: `apps/api/src/routes/admin/media.ts` lines 127-133, 160-166, 217-220

5. **Remove the duplicate PUT route**: Only PATCH is needed and used.
   - File: `apps/api/src/routes/admin/media.ts` lines 138-167

6. **Move media tables to their own schema file**: Create `packages/database/src/schema/media.ts`.
   - File: `packages/database/src/schema/products.ts` lines 200-230

### Priority 3 -- Performance

7. **Add bulk delete endpoint**: Create `DELETE /api/v1/admin/media/bulk` that accepts `{ ids: string[] }` and deletes all in one request using `db.batch()`.
   - Files: `apps/api/src/routes/admin/media.ts`, `packages/core/src/modules/media/media.service.ts`

8. **Use appropriate image presets in MediaCard and MediaPreview**: Pass `{ width: 300, height: 300, quality: 75 }` to cards, `{ width: 1200, height: 1200, quality: 90 }` to preview.
   - Files: `apps/admin/src/components/admin/media-manager/components/MediaCard.tsx` line 164, `MediaPreview.tsx` line 56

9. **Batch the count + list queries**: Use `db.batch()` to run both in a single D1 round-trip.
   - File: `packages/core/src/modules/media/media.service.ts` lines 29-38

10. **Remove artificial `setTimeout` delay between upload batches**: Unnecessary in Worker context.
    - File: `packages/core/src/modules/media/media.service.ts` lines 120-122

### Priority 4 -- Consistency

11. **Unify file count limits**: Align service (50) and UI (20) to a single shared constant. Either raise the UI to 50 or lower the service to 20.
    - Files: `media.service.ts` line 11, `types/index.ts` line 102

12. **Add `sortBy`/`sortOrder` support to `listMediaFiles`** or remove the dead params from the client and types.
    - Files: `media.service.ts`, `mediaClient.ts`, `types/index.ts`

13. **Fix README inaccuracies**: Update `packages/core/src/modules/media/README.md` line 48 (says 20MB, should say 10MB) and line 133 (same issue).

14. **Escape SQL wildcards in search**: `searchQuery.replace(/%/g, '\\%').replace(/_/g, '\\_')` before passing to `like()`.
    - File: `packages/core/src/modules/media/media.service.ts` line 18

15. **Define folder ID constants**: Replace magic strings `"all"`, `"root"`, `"null"` with named constants exported from types.
    - File: `apps/admin/src/components/admin/media-manager/types/index.ts`

### Priority 5 -- Robustness

16. **Clear upload timeout on success**: Store timer ID and clear it after `Promise.race` resolves successfully.
    - File: `packages/core/src/integrations/storage.ts` lines 153-158

17. **Check for duplicate folder names on creation**: Query existing folders with same name + parentId before inserting.
    - File: `packages/core/src/modules/media/media.service.ts` lines 189-199

18. **Handle child folders on folder delete**: Re-parent or recursively soft-delete child folders.
    - File: `packages/core/src/modules/media/media.service.ts` lines 201-204

### Priority 6 -- Future

19. **Add `alt`, `width`, `height` columns to media table**: The `productImages` table already has `alt`. The `media` table should too, along with image dimensions that can be extracted at upload time.
    - Files: `packages/database/src/schema/products.ts` lines 213-230, `packages/core/src/integrations/storage.ts`

20. **Implement orphan cleanup job**: Periodic Cron Trigger that lists R2 objects and checks each key against `media.url` and `product_images.url`. Delete R2 objects with no DB reference.

---

## File Index

### Schema
- `packages/database/src/schema/products.ts` -- `media` table (lines 213-230), `mediaFolders` table (lines 200-211), `productImages` table (lines 42-57)

### Core Service
- `packages/core/src/modules/media/media.service.ts` -- All business logic (list, upload, update, delete, move, folder CRUD)
- `packages/core/src/modules/media/media.validation.ts` -- Zod schemas (updateMedia, moveMedia, createFolder)
- `packages/core/src/modules/media/index.ts` -- Barrel exports

### R2 Storage
- `packages/core/src/integrations/storage.ts` -- `initStorage()`, `uploadFile()`, `deleteFile()`, `getBucket()`, `extractKeyFromUrl()`

### API Routes
- `apps/api/src/routes/admin/media.ts` -- All 9 OpenAPI routes (list, upload, patch, put, delete, move, folders CRUD)
- `apps/api/src/routes/media-server.ts` -- Dev-only R2 object serving

### Admin UI
- `apps/admin/src/components/admin/media-manager/MediaManager.tsx` -- Dialog-based media picker (533 lines)
- `apps/admin/src/components/admin/media-manager/MediaManagerPage.tsx` -- Standalone media page (432 lines)
- `apps/admin/src/components/admin/media-manager/api/mediaClient.ts` -- MediaApiClient class
- `apps/admin/src/components/admin/media-manager/types/index.ts` -- All TypeScript interfaces and constants
- `apps/admin/src/components/admin/media-manager/hooks/useMediaFiles.ts` -- File state management with race condition prevention
- `apps/admin/src/components/admin/media-manager/hooks/useMediaUpload.ts` -- Upload state management
- `apps/admin/src/components/admin/media-manager/hooks/useFolders.ts` -- Folder state management
- `apps/admin/src/components/admin/media-manager/components/MediaGallery.tsx` -- Grid display with skeleton loading
- `apps/admin/src/components/admin/media-manager/components/MediaCard.tsx` -- Individual card with IntersectionObserver lazy loading
- `apps/admin/src/components/admin/media-manager/components/MediaFilterBar.tsx` -- Search/filter/selection toolbar
- `apps/admin/src/components/admin/media-manager/components/MediaPreview.tsx` -- Full-size image preview dialog
- `apps/admin/src/components/admin/media-manager/components/MediaUploadZone.tsx` -- Drag-and-drop upload zone
- `apps/admin/src/components/admin/media-manager/components/FolderBrowser.tsx` -- Folder sidebar with create/delete
- `apps/admin/src/components/admin/media-manager/utils/validators.ts` -- Client-side file validation
- `apps/admin/src/components/admin/media-manager/utils/formatters.ts` -- File size/date/type formatting
- `apps/admin/src/components/admin/media-manager/utils/debounce.ts` -- Debounce utility
- `apps/admin/src/components/admin/DraggableImageGallery.tsx` -- Drag-and-drop image reordering (product form)

### Shared Utilities
- `packages/shared/src/image-optimizer.ts` -- Cloudflare Image Resizing URL generation, presets, responsive srcset
- `packages/shared/src/media-url.ts` -- `resolveMediaUrl()` bare key to CDN URL resolution

### Storefront Wrappers
- `apps/storefront/src/lib/media-url.ts` -- Runtime CDN base resolution wrapping shared `resolveMediaUrl`
- `apps/storefront/src/lib/image-optimizer.ts` -- Pre-bound image optimizer with storefront context
