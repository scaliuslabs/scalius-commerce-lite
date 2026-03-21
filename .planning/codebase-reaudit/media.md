# Media Domain Re-Audit

**Re-Audit Date:** 2026-03-21
**Previous Audit:** 2026-03-20
**Scope:** Complete vertical slice -- schema, core service, storage integration, API routes, admin UI (including new `useMediaManager` hook), shared utilities

## Summary

The major fix session introduced a new `useMediaManager` hook that consolidates all shared state and handlers between `MediaManager.tsx` (dialog) and `MediaManagerPage.tsx` (standalone page). This directly addresses the previous audit's highest-priority code quality finding (#4, massive code duplication). The hook successfully eliminates all duplicated state declarations, handler logic, and hook composition from both components.

However, the API route layer and core service remain unchanged -- all critical issues (non-atomic delete, fragile key extraction, upload timeout leak) persist. The `useMediaManager` refactor also introduced its own debounce issue, and both components still contain verbatim-identical upload overlay JSX and delete dialog JSX that could be further extracted. The `status` field was removed from the upload response (fixing #2), but the PUT route, sequential bulk delete, and sort/filter dead code all remain.

**Overall quality: 5.5/10** (up from ~5/10)

The `useMediaManager` hook is a clear structural improvement, but most data-integrity and correctness issues from the original audit are untouched.

---

## Previous Findings Status

### Critical Issues

#### #1. Delete is non-atomic: R2 deletion before DB deletion -- STILL OPEN

**Files:** `packages/core/src/modules/media/media.service.ts` lines 166-173

```typescript
export async function deleteMediaFile(dbOp: Database, id: string) {
    const [file] = await dbOp.select().from(media).where(eq(media.id, id));
    if (!file) throw new NotFoundError("File not found");
    const key = file.url.split("/").pop()!;  // still fragile extraction
    await deleteFile(key);                    // R2 delete still first
    await dbOp.delete(media).where(eq(media.id, id));  // DB delete still second
}
```

No change. R2 is still deleted before DB. The fragile `file.url.split("/").pop()!` key extraction is still used instead of `extractKeyFromUrl()` from `packages/core/src/integrations/storage.ts` line 203.

**Fix:** Reverse the operation order. Use `extractKeyFromUrl()`.

#### #2. Upload response includes `status` field inside response data -- FIXED

**Files:** `packages/core/src/modules/media/media.service.ts` lines 132-149

The service now returns a properly typed response object with `files`, `summary`, optional `warnings`, and optional `partialSuccess` boolean -- no more `status` field. The API route at `apps/api/src/routes/admin/media.ts` line 95 uses `result.partialSuccess` to decide between `ok()` and `created()`. This is a clean fix.

#### #3. No orphan cleanup mechanism for R2 objects -- STILL OPEN

No change. No cleanup job or reference counting mechanism exists.

### Code Quality Issues

#### #4. Massive code duplication: MediaManager vs MediaManagerPage -- FIXED

**Files:**
- `apps/admin/src/components/admin/media-manager/hooks/useMediaManager.ts` (290 lines, new)
- `apps/admin/src/components/admin/media-manager/MediaManager.tsx` (337 lines, down from 533)
- `apps/admin/src/components/admin/media-manager/MediaManagerPage.tsx` (263 lines, down from 432)

All shared state, hooks, and handlers are now in `useMediaManager.ts`. Both components call `useMediaManager()` and consume the returned `mm` object. The state declarations, handler implementations, and hook composition are fully deduplicated.

**Remaining duplication:** The upload overlay JSX (~37 lines, lines 193-229 in MediaManager, lines 134-170 in MediaManagerPage) and both delete confirmation dialog blocks (~55 lines each) are still verbatim copies across both files. These could be extracted into shared components (e.g., `UploadOverlay` and `DeleteConfirmationDialogs`), but this is minor compared to the original ~400 lines of logic duplication.

#### #5. API route error handling bypasses established patterns -- FIXED

**Files:** `apps/api/src/routes/admin/media.ts`

All `try/catch` blocks with unsafe `as` casts have been removed. The route handlers now let service errors (e.g., `NotFoundError`, `ValidationError`) propagate to the global error handler, matching the codebase convention. Only the upload handler has a conditional (`result.partialSuccess` check), which is appropriate.

#### #6. Redundant PATCH + PUT routes for the same operation -- STILL OPEN

**Files:** `apps/api/src/routes/admin/media.ts` lines 126-152

Both `patchMediaRoute` and `putMediaRoute` still exist with identical handler implementations. The admin UI uses only PATCH (in `mediaClient.ts` line 266). PUT is dead code polluting the OpenAPI spec.

#### #7. `debounce` utility returns wrong type and is duplicated -- PARTIALLY FIXED

**Files:** `apps/admin/src/components/admin/media-manager/utils/debounce.ts`

The `debounce` function still casts the return type incorrectly:
```typescript
return debounced as (...args: Parameters<F>) => ReturnType<F>;
```
The debounced function returns `void`, not `ReturnType<F>`.

However, the duplication issue is partially addressed: both components no longer wrap `debounce` in their own `useCallback`. Instead, `useMediaManager.ts` line 115-121 creates one `debouncedApplyFilters`:
```typescript
const debouncedApplyFilters = useCallback(
    debounce((newFilters: typeof filters) => {
        applyFilters({ ...newFilters, folderId: folderParam });
    }, 500),
    [applyFilters, currentFolderId],
);
```

The problem: `useCallback` with `debounce` is still broken here. When `applyFilters` or `currentFolderId` changes, `useCallback` creates a new debounced function, resetting the internal timer. This defeats debouncing during folder navigation and makes search debounce unreliable.

### Pattern Violations

#### #8. File size limit mismatch across layers -- STILL OPEN (minor)

The 10MB limit is consistent between storage (`storage.ts` line 6), service (`media.service.ts` line 9), and UI types (`types/index.ts` line 101). However, the core module README (`packages/core/src/modules/media/README.md` line 48) still says "max 20MB" and line 133 still says "service validates 20MB". The README is stale.

#### #9. Max files per upload mismatch -- STILL OPEN

Service: 50 files (`media.service.ts` line 11). UI: 20 files (`types/index.ts` line 102, `useMediaUpload.ts` line 22 default). UI text: "Max 20 files" (MediaManager.tsx line 159, MediaManagerPage.tsx line 102). No change.

#### #10. `sortBy` and `sortOrder` filter params are sent but ignored -- STILL OPEN

`mediaClient.ts` lines 43-49 still sends `sortBy` and `sortOrder`. `listMediaFiles` in `media.service.ts` still ignores them, always sorting `desc(media.createdAt)`. No UI sort controls exist. The `MediaFilterOptions` type still defines `sortBy`, `sortOrder`, `fileType`, `dateFrom`, `dateTo` -- all dead fields.

#### #11. `temp_` ID prefix convention is fragile and undocumented in types -- STILL OPEN

The `temp_` prefix is still used in three locations within `useMediaManager.ts`:
- Line 88: `id: \`temp_\${file.id}\`` in `onUploadComplete` for single select
- Line 145: `id: \`temp_\${file.id}\`` in `handleFileSelect`
- Line 214: `id: \`temp_\${file.id}\`` in `handleAddSelectedFiles`

And in `MediaManager.tsx` line 268: `id: \`temp_\${file.id}\`` in the preview select handler.

Plus the strip in `MediaManager.tsx` line 75: `f.id.replace(/^temp_/, "")`.

The `MediaFile` type still has plain `id: string` with no indication of this convention.

### Maintainability Concerns

#### #12. Media tables live in `products.ts` schema file -- STILL OPEN

`packages/database/src/schema/products.ts` lines 200-230 still define `media` and `mediaFolders` tables. No `packages/database/src/schema/media.ts` exists.

#### #13. Untyped service return values -- PARTIALLY FIXED

`uploadMediaFiles` now returns a properly shaped object with explicit type annotation (lines 132-137):
```typescript
const response: {
    files: typeof uploadedFiles;
    summary: string;
    warnings?: Array<{ filename: string; error: string }>;
    partialSuccess?: boolean;
} = { ... };
```

However, `updateMediaFile` still returns an untyped Drizzle result (`const [updatedFile] = await dbOp.update(...).returning()`). The API route wraps it as `{ file }` but no return type is declared.

#### #14. Three layers of file validation -- STILL OPEN

Still three separate validation layers with different logic:
1. Admin UI (`utils/validators.ts`): `image/*` wildcard, configurable max size/count
2. Core service (`media.service.ts`): count 50, size 10MB, filename, empty check
3. Storage (`storage.ts`): size 10MB, specific MIME allowlist, extension allowlist

The UI accepts `image/avif` (matches `image/*`) but storage rejects it (not in `ALLOWED_IMAGE_TYPES`). No change.

#### #15. No shared error types between admin UI and API -- STILL OPEN

`mediaClient.ts` line 105 still constructs ad-hoc error objects:
```typescript
const error: Error & { details?: ...; summary?: string } = new Error(errorMessage);
```
The fix session improved error extraction by using `extractApiError()` and `extractApiErrorDetails()` from `@/lib/api-helpers`, but the augmented Error type is still ad-hoc.

### Performance & Scalability

#### #16. Bulk delete is N sequential HTTP requests -- STILL OPEN

`mediaClient.ts` lines 164-182 still loops through `fileIds` with sequential `this.deleteFile()` calls. No bulk delete endpoint exists.

#### #17. Upload batching uses `setTimeout` delay in Worker context -- STILL OPEN

`media.service.ts` lines 120-122 still has:
```typescript
if (batchEnd < files.length) {
    await new Promise(resolve => setTimeout(resolve, 100));
}
```

#### #18. List query runs two separate queries -- STILL OPEN

`media.service.ts` lines 29-38 still runs count and select as two separate D1 round-trips.

#### #19. MediaCard IntersectionObserver creates one observer per card -- STILL OPEN

`MediaCard.tsx` lines 52-72 still creates a per-card IntersectionObserver instance.

#### #20. Image optimization uses default 600x600 for thumbnails -- STILL OPEN

`MediaCard.tsx` line 164: `src={getOptimizedImageUrl(file.url)}` still uses defaults (600x600) for cards rendered at 300x300.

`MediaPreview.tsx` line 56: `src={getOptimizedImageUrl(file.url)}` still uses defaults (600x600) for a preview dialog rendered at up to 90vh.

### Robustness Gaps

#### #21. No upload retry on transient R2 failures -- STILL OPEN

`storage.ts` lines 160-169 still has no retry logic.

#### #22. Upload timeout leaks on success -- STILL OPEN

`storage.ts` lines 153-158 still creates a `setTimeout` that is never cleared on success.

#### #23. Folder delete does not check for child folders -- STILL OPEN

`media.service.ts` lines 196-198 still does not handle child folders. A folder with `parentId` pointing to the deleted folder becomes orphaned.

#### #24. `listMediaFiles` is vulnerable to SQL wildcard injection -- STILL OPEN

`media.service.ts` line 18 still uses:
```typescript
if (searchQuery) conditions.push(like(media.filename, `%${searchQuery}%`));
```
No escaping of `%` or `_` characters.

#### #25. No protection against concurrent uploads to the same folder -- STILL OPEN

No change.

#### #26. `createFolder` does not check for duplicate folder names -- STILL OPEN

`media.service.ts` lines 184-193 still inserts without checking for existing folders with the same name and parentId.

---

## New Issues Found

### NEW-1. `MediaApiClient.createFolder` calls `response.json()` twice -- BUG

**Files:** `apps/admin/src/components/admin/media-manager/api/mediaClient.ts` lines 214-221

```typescript
if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));  // first .json()
    throw new Error(extractApiError(errorData, "Failed to create folder"));
}

const json = await response.json();  // second .json() - body already consumed
const data = unwrapEnvelope(json);
return data.folder;
```

On a successful response (201), `response.json()` is called on line 219. Since the error branch did not execute, this is the first and only call -- this is fine. But the pattern is fragile: if `response.ok` is `true` but a future refactor adds logging that calls `.json()` in the error path, the second call would fail with "body already consumed."

More critically, on an error response (non-ok), `response.json()` is called twice: once at line 215 (inside the `if (!response.ok)` block) and, if an exception is somehow caught, a second time at line 219. The `throw` prevents reaching line 219 in the normal error path, but the pattern differs from all other methods in the same class (e.g., `deleteFile` and `moveFilesToFolder` which correctly return/throw before reaching a second `.json()` call).

This is a minor correctness issue -- it works in practice because the `throw` prevents the second call -- but it is inconsistent with the other methods and could break on refactoring.

### NEW-2. `useMediaManager` debounce is recreated on every dependency change

**Files:** `apps/admin/src/components/admin/media-manager/hooks/useMediaManager.ts` lines 115-121

```typescript
const debouncedApplyFilters = useCallback(
    debounce((newFilters: typeof filters) => {
        const folderParam = currentFolderId === "all" ? "all" : currentFolderId;
        applyFilters({ ...newFilters, folderId: folderParam });
    }, 500),
    [applyFilters, currentFolderId],
);
```

Every time `applyFilters` or `currentFolderId` changes, `useCallback` creates a new debounced function. This resets the internal `setTimeout` handle, so any in-flight debounced search is cancelled. During folder navigation, this means:
1. User types in search
2. User clicks a folder
3. `currentFolderId` changes
4. Debounced function is recreated
5. Pending search is lost

**Fix:** Use `useRef` for the debounce timer, or use a stable callback reference with `useRef` + `useEffect` pattern.

### NEW-3. Upload overlay and delete confirmation dialogs are still duplicated

**Files:**
- `apps/admin/src/components/admin/media-manager/MediaManager.tsx` lines 193-229 (upload overlay), lines 280-333 (delete dialogs)
- `apps/admin/src/components/admin/media-manager/MediaManagerPage.tsx` lines 134-170 (upload overlay), lines 207-261 (delete dialogs)

The `useMediaManager` hook consolidated all state and logic, but the JSX for these three UI elements is still copied verbatim between both files (~92 lines total per file). This is the remaining ~30% of duplication that was not addressed.

**Fix:** Extract `UploadOverlay`, `DeleteConfirmDialog`, and `BulkDeleteConfirmDialog` as shared components in `./components/`.

### NEW-4. `useMediaUpload` wrapper function is unnecessary

**Files:** `apps/admin/src/components/admin/media-manager/hooks/useMediaUpload.ts` lines 117-122

```typescript
const uploadFilesWrapper = useCallback(
    async (files: FileList | null) => {
        await uploadFiles(files);
    },
    [uploadFiles],
);
```

This wrapper converts `uploadFiles` (which accepts `FileList | File[] | null`) to only accept `FileList | null`. It discards the return value. This narrows the type for no clear reason -- `useMediaManager` calls `mm.uploadFiles(droppedFiles)` where `droppedFiles` is `FileList`, which already matches the original `uploadFiles` signature. The wrapper creates an extra `useCallback` allocation per render cycle.

### NEW-5. `useMediaManager` exposes too many raw setters

**Files:** `apps/admin/src/components/admin/media-manager/hooks/useMediaManager.ts` lines 257-263

The hook returns 8 raw state setters:
```typescript
setSelectionMode, setSelectedFileIds, setShowPreview, setPreviewFile,
setShowDeleteDialog, setPendingDeleteFileId, setShowBulkDeleteDialog,
setFolderSidebarCollapsed
```

These break encapsulation. Consumers can set `showDeleteDialog = true` without setting `pendingDeleteFileId`, creating invalid state. The hook already exposes action methods (`handleDeleteConfirmation`, `handleBulkDeleteConfirmation`) that correctly coordinate state transitions. The raw setters should be removed from the public API or marked internal.

### NEW-6. `onUploadComplete` callback uses `setTimeout` for UI state updates

**Files:** `apps/admin/src/components/admin/media-manager/hooks/useMediaManager.ts` lines 78-101

```typescript
if (onSelectMultiple && uploadedFiles.length > 0) {
    setTimeout(() => {
        setSelectedFileIds(newFileIds);
        setSelectionMode(true);
        toast.success("Upload Complete", { ... });
    }, 400);
}
```

A 400ms `setTimeout` is used to delay selection state updates after upload. This is a race condition: if the component unmounts within 400ms (e.g., user navigates away), the `setSelectedFileIds` and `setSelectionMode` calls will fire on an unmounted component. This should use `requestAnimationFrame` or be guarded by a mounted ref.

### NEW-7. README for core media module has multiple inaccuracies

**Files:** `packages/core/src/modules/media/README.md`

- Line 10: Says `media.schema.ts` but actual file is `media.validation.ts`
- Line 11: Says `MediaService object` but the module exports standalone functions, not a class/object
- Line 48: Says "max 20MB" -- should be 10MB
- Line 133: Says "service validates 20MB" -- should be 10MB (same stale data from audit #8)

---

## File Index (Updated)

### Schema
- `packages/database/src/schema/products.ts` lines 200-230 -- `media` and `mediaFolders` tables (unchanged)

### Core Service
- `packages/core/src/modules/media/media.service.ts` -- All business logic (unchanged except upload return type)
- `packages/core/src/modules/media/media.validation.ts` -- Zod schemas (unchanged)
- `packages/core/src/modules/media/index.ts` -- Barrel exports (unchanged)
- `packages/core/src/modules/media/README.md` -- Documentation (unchanged, stale)

### R2 Storage
- `packages/core/src/integrations/storage.ts` -- `initStorage()`, `uploadFile()`, `deleteFile()`, `extractKeyFromUrl()` (unchanged)

### API Routes
- `apps/api/src/routes/admin/media.ts` -- 9 OpenAPI routes (error handling fixed, PUT still present)

### Admin UI
- `apps/admin/src/components/admin/media-manager/MediaManager.tsx` -- Dialog-based media picker (337 lines, down from 533)
- `apps/admin/src/components/admin/media-manager/MediaManagerPage.tsx` -- Standalone media page (263 lines, down from 432)
- `apps/admin/src/components/admin/media-manager/hooks/useMediaManager.ts` -- **NEW** Shared state/handlers hook (290 lines)
- `apps/admin/src/components/admin/media-manager/hooks/useMediaFiles.ts` -- File state management (unchanged)
- `apps/admin/src/components/admin/media-manager/hooks/useMediaUpload.ts` -- Upload state management (unchanged)
- `apps/admin/src/components/admin/media-manager/hooks/useFolders.ts` -- Folder state management (unchanged)
- `apps/admin/src/components/admin/media-manager/api/mediaClient.ts` -- MediaApiClient class (unchanged)
- `apps/admin/src/components/admin/media-manager/types/index.ts` -- All TypeScript interfaces and constants (unchanged)
- `apps/admin/src/components/admin/media-manager/components/MediaGallery.tsx` -- Grid display (unchanged)
- `apps/admin/src/components/admin/media-manager/components/MediaCard.tsx` -- Individual card (unchanged)
- `apps/admin/src/components/admin/media-manager/components/MediaFilterBar.tsx` -- Toolbar (unchanged)
- `apps/admin/src/components/admin/media-manager/components/MediaPreview.tsx` -- Preview dialog (unchanged)
- `apps/admin/src/components/admin/media-manager/components/MediaUploadZone.tsx` -- Upload zone (unused, unchanged)
- `apps/admin/src/components/admin/media-manager/components/FolderBrowser.tsx` -- Folder sidebar (unchanged)
- `apps/admin/src/components/admin/media-manager/utils/validators.ts` -- Client-side validation (unchanged)
- `apps/admin/src/components/admin/media-manager/utils/formatters.ts` -- Formatting utilities (unchanged)
- `apps/admin/src/components/admin/media-manager/utils/debounce.ts` -- Debounce utility (unchanged)
- `apps/admin/src/components/admin/media-manager/README.md` -- Component documentation (updated)

### Shared Utilities
- `packages/shared/src/image-optimizer.ts` -- Cloudflare Image Resizing (unchanged)
- `packages/shared/src/media-url.ts` -- `resolveMediaUrl()` (unchanged)

---

## Scoreboard

| # | Finding | Status | Severity |
|---|---------|--------|----------|
| 1 | Non-atomic delete (R2 before DB) | STILL OPEN | Critical |
| 2 | Upload response `status` field in envelope | FIXED | Critical |
| 3 | No R2 orphan cleanup | STILL OPEN | Medium |
| 4 | MediaManager/MediaManagerPage duplication | FIXED | High |
| 5 | API route error handling antipatterns | FIXED | Medium |
| 6 | Redundant PUT route | STILL OPEN | Low |
| 7 | `debounce` return type + useCallback issue | PARTIALLY FIXED | Medium |
| 8 | File size limit README mismatch | STILL OPEN | Low |
| 9 | Max files per upload mismatch (50 vs 20) | STILL OPEN | Low |
| 10 | sortBy/sortOrder dead params | STILL OPEN | Low |
| 11 | `temp_` ID prefix convention undocumented | STILL OPEN | Medium |
| 12 | Media tables in products.ts | STILL OPEN | Low |
| 13 | Untyped service return values | PARTIALLY FIXED | Low |
| 14 | Three layers of file validation | STILL OPEN | Medium |
| 15 | No shared error types | STILL OPEN | Low |
| 16 | Bulk delete is N sequential requests | STILL OPEN | Medium |
| 17 | Upload setTimeout in Worker context | STILL OPEN | Low |
| 18 | Two separate list queries | STILL OPEN | Low |
| 19 | Per-card IntersectionObserver | STILL OPEN | Low |
| 20 | Oversized image optimization defaults | STILL OPEN | Low |
| 21 | No upload retry | STILL OPEN | Low |
| 22 | Upload timeout never cleared | STILL OPEN | Low |
| 23 | Folder delete ignores child folders | STILL OPEN | Medium |
| 24 | SQL wildcard injection in search | STILL OPEN | Medium |
| 25 | No concurrent upload protection | STILL OPEN | Low |
| 26 | Duplicate folder names allowed | STILL OPEN | Low |
| N1 | createFolder double response.json() | NEW | Low |
| N2 | useMediaManager debounce recreated on dep change | NEW | Medium |
| N3 | Upload overlay + delete dialogs still duplicated | NEW | Low |
| N4 | Unnecessary uploadFiles wrapper | NEW | Low |
| N5 | Too many raw setters exposed from hook | NEW | Low |
| N6 | setTimeout in onUploadComplete (unmount risk) | NEW | Medium |
| N7 | Core README inaccuracies | NEW | Low |

**Fixed:** 3 (issues #2, #4, #5)
**Partially Fixed:** 2 (issues #7, #13)
**Still Open:** 21
**New Issues:** 7

---

## Rating: 5.5 / 10

**Rationale:**

The `useMediaManager` hook is a solid structural win -- it correctly solves the largest code quality issue (80% logic duplication) and demonstrates good React patterns (centralized state, composable hooks). The API error handling cleanup is also correct and follows codebase conventions.

However, the domain still carries significant technical debt:
- The critical non-atomic delete (#1) is unchanged and could cause data integrity issues in production
- SQL wildcard injection (#24) is a correctness bug
- The debounce implementation (#7, N2) is functionally broken -- it appears to work by coincidence but will fail under rapid interaction
- 21 of 26 original findings are completely untouched
- The new hook introduces its own issues (debounce recreation, unmount-unsafe setTimeout, excessive setter exposure)

The score reflects a domain that is structurally improving but has unaddressed correctness and robustness issues in the service and storage layers.
