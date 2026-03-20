# 15 — Media Domain Audit

**Auditor:** Claude Opus 4.6
**Date:** 2026-03-20
**Scope:** Media upload, R2 storage, image optimization, CDN serving, admin media manager UI

---

## 1. Architecture Overview

The media pipeline spans five layers:

```
Admin UI (media-manager/)
  -> MediaApiClient (browser fetch)
    -> Hono API routes (apps/api/src/routes/admin/media.ts)
      -> Core service (packages/core/src/modules/media/media.service.ts)
        -> R2 storage integration (packages/core/src/integrations/storage.ts)
          -> Cloudflare R2 bucket

CDN serving (production):
  R2 -> cloud.scalius.com (R2 public bucket) -> /cdn-cgi/image/ (Cloudflare Image Resizing)

Local dev serving:
  R2 -> /media/:key route (apps/api/src/routes/media-server.ts, dev-only)
```

The image optimizer (`@scalius/shared/image-optimizer`) and URL resolver (`@scalius/shared/media-url`) are pure functions consumed by both admin and storefront -- no server-side coupling.

### Key Files

| Layer | File | Purpose |
|-------|------|---------|
| Schema | `packages/database/src/schema/products.ts:212-229` | `media` + `mediaFolders` tables |
| Validation | `packages/core/src/modules/media/media.validation.ts` | Zod schemas for update/move/folder |
| Service | `packages/core/src/modules/media/media.service.ts` | CRUD, upload orchestration, folder management |
| Storage | `packages/core/src/integrations/storage.ts` | R2 upload/delete, file validation, module-level state |
| API Routes | `apps/api/src/routes/admin/media.ts` | OpenAPI admin endpoints (8 routes) |
| Dev Server | `apps/api/src/routes/media-server.ts` | Local R2 object serving (dev-only) |
| Image Optimizer | `packages/shared/src/image-optimizer.ts` | Cloudflare Image Resizing URL generation |
| URL Resolver | `packages/shared/src/media-url.ts` | Bare key -> full CDN URL resolution |
| Admin UI | `apps/admin/src/components/admin/media-manager/` | Full media manager (22 files) |
| Drag Gallery | `apps/admin/src/components/admin/DraggableImageGallery.tsx` | Product image reordering |

---

## 2. Upload Flow

### Pipeline

1. **Browser**: User selects files or drag-drops onto the dialog/page.
2. **Client validation** (`utils/validators.ts`): Checks file count (max 20), size (max 10MB), MIME type (`image/*`).
3. **FormData POST** to `/api/v1/admin/media/upload` via `MediaApiClient.uploadFiles()`.
4. **API route** (`media.ts` upload handler): Parses multipart body with `c.req.parseBody({ all: true })`, extracts `File` instances, delegates to service.
5. **Service** (`uploadMediaFiles`): Iterates in batches of 5 with 100ms delay between batches. Per-file validation: name, empty check, 20MB max. Calls `uploadFile()` from storage integration.
6. **Storage** (`uploadFile`): Second validation layer (10MB limit, MIME allowlist, extension allowlist). Generates `nanoid().ext` key. Reads file into `ArrayBuffer`. Uploads to R2 with `httpMetadata` (contentType, cacheControl) and `customMetadata` (originalFilename, uploadedAt). 30-second timeout.
7. **DB insert**: Stores media record with `media_` prefixed nanoid, filename, URL, size, mimeType, folderId.

### Partial Success Handling

The service returns HTTP 207 for partial success (some files fail, some succeed). The client handles this by showing both success and failure toasts. Full failure throws `ValidationError` which becomes HTTP 400.

---

## 3. Image Optimization

### Cloudflare Image Resizing Strategy

`getOptimizedImageUrl()` in `@scalius/shared/image-optimizer` transforms URLs through Cloudflare's `/cdn-cgi/image/` endpoint:

```
Input:  https://cloud.scalius.com/abc123.jpg
Output: https://cloud.scalius.com/cdn-cgi/image/onerror=redirect,width=600,height=600,quality=85,format=auto,fit=cover,sharpen=1/abc123.jpg
```

Key design decisions:
- **Origin routing**: Transforms route through the image's own origin (`cloud.scalius.com`), so Image Resizing only needs to be enabled on the CDN zone.
- **`onerror=redirect`**: Always included for graceful degradation (if transform fails, serves original).
- **Dev bypass**: Detects localhost/dev environments and skips `/cdn-cgi/` (which 404s locally).
- **Auto-detection fallbacks**: `detectIsDev()` checks `import.meta.env.MODE`, `window.location.hostname`, `process.env.NODE_ENV`. `detectCdnBase()` reads `R2_PUBLIC_URL` and `CDN_DOMAIN_URL` from build-time env vars.
- **Pure functions**: Both `image-optimizer.ts` and `media-url.ts` accept context parameters, making them testable and SSR-safe.

### Presets

```
productThumbnail: 200x200, quality 75
productCard:      400x400, quality 75
productDetail:    800x800, quality 85
hero:             1920x600, quality 90
heroMobile:       768x400, quality 85
```

### Responsive Srcset

`getResponsiveSrcSet()` generates srcset strings at widths [320, 640, 768, 1024, 1280] -- useful for `<img srcset>`.

---

## 4. Media Management (CRUD + Folders)

### API Endpoints (mounted at `/api/v1/admin/media`)

| Method | Path | Handler |
|--------|------|---------|
| GET | `/` | List media with pagination, search, folder filter |
| POST | `/upload` | Multipart file upload |
| PATCH | `/{id}` | Update filename/folder |
| PUT | `/{id}` | Update filename/folder (duplicate of PATCH) |
| DELETE | `/{id}` | Delete file (R2 + DB) |
| POST | `/move` | Bulk move files to folder |
| GET | `/folders` | List all folders |
| POST | `/folders` | Create folder |
| DELETE | `/folders/{id}` | Soft-delete folder (files moved to root) |

### Folder System

- Flat folder list with `parentId` support in schema (but the UI does not render nested hierarchies).
- "All Files" view shows everything, "Uncategorized" shows files with `folderId=null`.
- Folder deletion is soft-delete (`deletedAt` set). Files in deleted folder are moved to root (`folderId=null`).
- Folder colors are deterministically generated from folder ID hash.

### Search

Simple `LIKE %query%` on filename. No FTS5 integration for media (unlike products/orders).

---

## 5. URL Generation and CDN

### URL Resolution Chain

1. **Upload**: R2 returns bare key `abc123.jpg`. If `R2_PUBLIC_URL` is configured, stored URL is `https://cloud.scalius.com/abc123.jpg`. If not, stored URL is just `/abc123.jpg` (bare key).
2. **Display**: `resolveMediaUrl()` handles both forms -- already-absolute URLs pass through, bare keys get CDN base prepended.
3. **Optimization**: `getOptimizedImageUrl()` wraps resolved URL with `/cdn-cgi/image/` transform params.
4. **Original access**: `getOriginalImageUrl()` strips `/cdn-cgi/image/` prefix for downloads and URL copying.

### Local Dev

The media-server route (`/media/:key`) serves R2 objects directly in development, with `Cache-Control: public, max-age=31536000` and ETag headers. This route is only mounted when `NODE_ENV === "development"`.

---

## 6. Security Analysis

### File Type Validation -- Two Layers

**Layer 1: Storage integration** (`storage.ts`):
- MIME type allowlist: JPEG, PNG, GIF, WebP, SVG, BMP, TIFF
- Extension allowlist: jpg, jpeg, png, gif, webp, svg, bmp, tiff, tif
- 10MB size limit
- Both MIME and extension must match

**Layer 2: Service** (`media.service.ts`):
- 20MB size limit (inconsistent with storage layer -- see Issue B1)
- Empty file check, filename validation
- No MIME type check (relies on storage layer)

**Layer 3: Client** (`validators.ts`):
- Client-side validation with configurable `maxSizeMB` (default 10MB)
- MIME type check via `image/*` wildcard
- File count limit (default 20)

### Path Traversal

- R2 keys are generated server-side as `nanoid().ext` -- user-supplied filenames are never used as storage keys. This effectively prevents path traversal.
- The `extractKeyFromUrl()` function parses URLs safely via `new URL()`.

### SVG Uploads

SVG files (`image/svg+xml`) are allowed. SVGs can contain JavaScript and are a common XSS vector when served inline. However, since they are served from R2 via a separate CDN domain (`cloud.scalius.com`), the XSS risk is contained to the CDN origin, not the app origin. The `Cache-Control: immutable` header further reduces risk of payload mutation.

### Delete Key Extraction

`deleteMediaFile` extracts the R2 key via `file.url.split("/").pop()!`. This works for both `https://cloud.scalius.com/abc123.jpg` (extracts `abc123.jpg`) and bare keys. However, the non-null assertion (`!`) could cause issues with malformed URLs.

### Authentication

All media routes are under `/admin/media`, which is protected by the admin auth middleware. No public media upload endpoint exists.

---

## 7. Admin UI Analysis

### Component Architecture

The media manager has two modes:
1. **Dialog mode** (`MediaManager.tsx`): Triggered from product forms, widget editors, etc. Allows single or multi-select.
2. **Page mode** (`MediaManagerPage.tsx`): Standalone page at `/admin/media`. Same functionality, no selection callbacks.

Both share the same hooks and components -- significant code duplication between the two (see Issue B3).

### Hook Design

| Hook | Purpose |
|------|---------|
| `useMediaFiles` | File listing, pagination, optimistic deletes, race condition prevention via request IDs |
| `useMediaUpload` | Upload orchestration, progress tracking, client validation |
| `useFolders` | Folder CRUD, current folder state |

### UX Patterns

- **Drag-and-drop**: Both the dialog and page support dropping files anywhere on the component.
- **Optimistic deletes**: Files are removed from UI immediately, reverted on API failure.
- **Race condition prevention**: `useMediaFiles` tracks request IDs to prevent stale data from folder switches.
- **Intersection Observer lazy loading**: `MediaCard` uses `IntersectionObserver` with 50px rootMargin for image loading.
- **Auto-select after upload**: Newly uploaded files are auto-selected in selection mode (with 400ms delay for data refresh).
- **Skeleton loading**: 12-card skeleton grid during initial load prevents layout shift.
- **Debounced search**: 500ms debounce on search input.

### DraggableImageGallery

Separate from the media manager -- used in product forms for reordering product images. Uses `@dnd-kit/core` + `@dnd-kit/sortable` with:
- Pointer sensor (8px activation distance) and keyboard sensor
- Portal-based drag overlay for smooth z-index behavior
- Live reorder during drag (via `onDragOver`)
- Color variant mapping support
- Expand/collapse for galleries with many images (default maxVisible=6)

---

## 8. Issues and Recommendations

### A. Critical Issues

**(A1) File Size Limit Mismatch**

The storage layer enforces 10MB but the service layer allows 20MB:

```
storage.ts:     MAX_FILE_SIZE = 10 * 1024 * 1024;  // 10 MB
media.service:  MAX_FILE_SIZE_MB = 20;              // 20 MB
```

A 15MB file passes the service check but fails at the storage layer, producing a confusing error. The UI says "Max 10MB each" in the description text. **Fix: Align all three to the same limit.**

**(A2) Module-Level R2 State is Not Request-Scoped**

`storage.ts` uses module-level variables `_bucket` and `_publicUrl`, set once per isolate via `initStorage()`. In Cloudflare Workers, each isolate handles many requests sequentially, and the middleware calls `initStorage()` on every request. This works today because it is single-tenant, but:
- If two requests overlap (unlikely in Workers but possible during streaming), state could be corrupted.
- The pattern is brittle -- any code path that skips the middleware will get stale or undefined state.

The `uploadFile()` and `deleteFile()` functions accept optional `bucket` parameters as escape hatches, but the media service calls `uploadFile(file)` without them, relying entirely on module state.

### B. Moderate Issues

**(B1) Bulk Delete is Serial, Not Batched**

`MediaApiClient.deleteFiles()` deletes files one-by-one in a loop, making N sequential HTTP requests. For 20 files, this could take 10+ seconds. There is no bulk delete API endpoint.

**Recommendation:** Add a `DELETE /api/v1/admin/media/bulk` endpoint accepting `{ fileIds: string[] }` and use `db.batch()` for atomic deletion.

**(B2) Upload Response Envelope Inconsistency**

The upload route handler checks `result.status` to decide between `created(c, result)` and `ok(c, result)`:

```typescript
return result.status === 201 ? created(c, result) : ok(c, result);
```

But `result` already contains a `status` field inside the response body. The client then checks `response.status` (HTTP status) for 201 vs 207, but the Hono `created()` helper always returns HTTP 201, and `ok()` returns HTTP 200. The HTTP 207 status is only in the body, not the actual HTTP response code.

The client at `mediaClient.ts:103` checks `response.status === 207 || response.status === 201`, but will never see 207 because the HTTP status is always 200 or 201. This means partial success responses (`result.status === 207`) arrive as HTTP 200, and the client's `207` branch is unreachable. **The code still works because it falls through to the `!response.ok` check correctly**, but the intent is misleading.

**(B3) MediaManager and MediaManagerPage Duplication**

`MediaManager.tsx` (533 lines) and `MediaManagerPage.tsx` (433 lines) share roughly 80% of their logic -- same state management, same handlers, same rendering for gallery/folders/filters/dialogs. The dialog wrapper is the only meaningful difference. This violates DRY and makes bugs easy to fix in one place and miss in the other.

**Recommendation:** Extract shared logic into a `useMediaManager()` hook that returns all state and handlers. Both components become thin wrappers.

**(B4) No Rename Support in Storage**

`updateMediaFile` can change `filename` in the database, but the R2 object key remains the original `nanoid().ext`. This is actually fine (key is opaque), but the original filename stored in R2 `customMetadata.originalFilename` becomes stale after rename. Minor inconsistency.

**(B5) Folder Deletion Doesn't Check Nested Folders**

`deleteMediaFolder` soft-deletes the folder and moves its files to root, but doesn't handle child folders (folders with `parentId` pointing to the deleted folder). Those child folders become orphaned -- they still exist but their parent is soft-deleted.

### C. Minor Issues / Improvements

**(C1) Search is LIKE-Only**

Media search uses `LIKE %query%` which doesn't use indexes effectively. For large media libraries, this will be slow. FTS5 is used elsewhere in the codebase but not for media.

**(C2) No Image Dimension Storage**

The `media` table stores filename, url, size, mimeType but not width/height. Image dimensions are useful for layout (preventing CLS), responsive image generation, and admin display.

**(C3) PATCH and PUT Are Identical**

The API defines both `PATCH /{id}` and `PUT /{id}` with identical behavior and schema. PUT typically implies full replacement while PATCH implies partial update. One should be removed.

**(C4) Upload Progress is Fake**

The `uploadProgress` state in `useMediaUpload` initializes with 0% for all files but never updates progress -- it goes from 0% to completion. The UI shows a pulsing progress bar at 100% width as a workaround. True progress tracking would require `XMLHttpRequest` or `ReadableStream` (fetch doesn't support upload progress natively).

**(C5) debounce() Loses Return Type**

The debounce utility at `utils/debounce.ts` types the return as `ReturnType<F>`, but debounced functions always return `void` (they schedule execution via setTimeout). The cast `as (...args: Parameters<F>) => ReturnType<F>` is technically incorrect.

**(C6) `temp_` ID Prefix Convention**

When the dialog selects files, it prefixes IDs with `temp_` (`id: \`temp_${file.id}\``). Later, on dialog reopen, it strips `temp_` to match against real IDs. This convention is fragile and undocumented -- any consumer unaware of it will have mismatched IDs.

**(C7) Preview Dialog Shows Optimized Image, Not Original**

`MediaPreview.tsx` passes `getOptimizedImageUrl(file.url)` for the preview image. For a full-screen preview, users likely want the original resolution. Should use `getOriginalImageUrl()` or a high-resolution preset.

**(C8) `pointer-events-none` as HTML Attribute**

In `DraggableImageGallery.tsx` line 353, `pointer-events-none` is used as a raw HTML attribute on a `<div>`. This is a CSS class name that should be in the `className` prop, not a standalone attribute. It likely gets ignored by the browser.

---

## 9. Data Flow Diagram

```
┌─────────────┐     FormData POST      ┌──────────────────┐
│  Admin UI   │ ──────────────────────> │  API Route       │
│  (React)    │                         │  /admin/media    │
│             │ <────────────────────── │  /upload         │
│  MediaApi   │     JSON response       │                  │
│  Client     │                         └────────┬─────────┘
└─────────────┘                                  │
                                                 │ delegates
                                                 v
                                    ┌───────────────────────┐
                                    │  media.service.ts     │
                                    │  - batch processing   │
                                    │  - per-file validation│
                                    │  - DB insert          │
                                    └────────────┬──────────┘
                                                 │ calls
                                                 v
                                    ┌───────────────────────┐
                                    │  storage.ts           │
                                    │  - MIME/ext validation │
                                    │  - nanoid key gen     │
                                    │  - R2 PUT with timeout│
                                    │  - metadata + headers │
                                    └────────────┬──────────┘
                                                 │
                                                 v
                                    ┌───────────────────────┐
                                    │  Cloudflare R2        │
                                    │  (BUCKET binding)     │
                                    └───────────────────────┘

CDN Serving:
┌─────────────┐    optimized URL     ┌──────────────────────┐
│  Browser    │ ──────────────────> │ cloud.scalius.com    │
│  <img src>  │                      │ /cdn-cgi/image/...   │
│             │ <────────────────── │ (Image Resizing)     │
│             │    transformed img   │         │             │
└─────────────┘                      │         v             │
                                     │   R2 origin fetch     │
                                     └──────────────────────┘
```

---

## 10. LLM-Friendliness Assessment

**Score: 7/10**

Strengths:
- Clean separation: storage integration is isolated from media service, which is isolated from API routes.
- Pure utility functions (`image-optimizer`, `media-url`) with explicit parameters instead of hidden env reads.
- Well-typed interfaces in `types/index.ts` with clear naming.
- Admin hooks follow consistent patterns (autoLoad flag, loading states, error handling).

Weaknesses:
- Module-level mutable state in `storage.ts` (`_bucket`, `_publicUrl`) is an unexpected side-effect pattern.
- The `temp_` ID prefix convention is implicit and not documented in types.
- MediaManager and MediaManagerPage duplication makes it hard to know which is the "canonical" implementation.
- The upload response status handling (body `status` vs HTTP status) requires careful tracing to understand.

---

## 11. Summary

The media domain is functionally complete with a solid upload pipeline, proper R2 integration, and a polished admin UI. The Cloudflare Image Resizing strategy is well-designed -- pure functions, origin routing, graceful degradation, dev bypass. The admin media manager provides good UX (drag-drop, optimistic updates, race condition prevention, lazy loading).

The primary concerns are the file size limit mismatch between layers (A1), the unreachable HTTP 207 branch in upload response handling (B2), and the substantial code duplication between MediaManager and MediaManagerPage (B3). The module-level R2 state pattern (A2) works for the current single-tenant architecture but should be refactored if the system scales to multi-tenant.
