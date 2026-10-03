# Media

The Files library: durable uploads, folders, trash, WebP renditions, the usage index and guarded permanent delete. Audience: contributors and operators.

How other records point at a stored file (the published key and URL projection, the deleting-reference guard) lives in [`media-references`](../media-references/README.md).

## Entries

`index.ts` is the only entry. There is no `browser.ts`. It re-exports `media.validation` (zod schemas), `media.service` and `media.usage`.

## Layer and imports

- Layer L2. Imports `media-references` and `settings`. The usage index reads the `business` and `seo` settings documents, so this domain sits above `settings`. It also uses `packages/core/src/integrations/storage.ts` and `settings-store`.
- No other core domain imports it. The API routes, the queue consumer and the cron call it.

## Tables

| Table | Role and constraints |
|-------|----------------------|
| `media` | One file. `kind` is `image` or `video`. `object_key` is unique. `status` is `ready`, `trashed`, `deleting` or `deleted` (CHECK ties timestamps to status). `version` is the CAS token. `variant_width` is the largest rendition (NULL means original only). `poster_media_id` points to a poster image. |
| `media_folders` | Flat folders. Unique case-insensitive live name. `version` CAS. |
| `media_upload_sessions`, `media_upload_parts` | Durable multipart intent (state, expected parts, expiry, R2 completion time) and stored part evidence (etag, size, `signature_verified`; primary key `(session_id, part_number)`). |

Product photos are `product_media` rows that point at `media` with `restrict`. Order lines keep `order_items.product_image_media_id`.

## Storage

- One R2 bucket (binding `BUCKET`, name `scalius-media`). Public objects use `media/<id>.<ext>`. Renditions use `media/<id>.<ext>/<width>.webp`. The same bucket holds private prefixes that no public route serves: `private/digital/`, `private/conversations/` and `private/agent-artifacts/`.
- D1 stores the object key. A public URL derives from the current media base URL and is never durable authority.
- The base URL is `mediaUrl` in the `platform` settings document (dashboard: Settings > Store details > Web addresses > Image address; served at `GET /api/v1/platform`). The API Worker resolves it to `env.R2_PUBLIC_URL` at entry. On localhost it is `<origin>/api/v1/media`, served by `apps/api/src/routes/media-server.ts` (mounted only when `NODE_ENV` is `development`; it refuses `private/`).
- `withPublicMediaUrl()` wraps each API request in `AsyncLocalStorage` with only the normalized base URL, and deep media projections read it through `getCurrentMediaUrl()`.

## Uploads

- The policy is `@scalius/shared/media-policy`. JPEG, PNG, GIF, WebP and AVIF go up to 20 MiB. MP4 and WebM go up to 100 MiB. Extension, MIME type and file signature must agree.
- Parts are 5 MiB (`MEDIA_MULTIPART_PART_SIZE_BYTES`), at most 20 per file. The API reads exactly one part into memory per request (`readExactMediaPart`), never the whole file. Part 1 needs a signature check.
- Initiate commits an `initializing` session before it creates the R2 upload. Complete claims `completing`, finishes the R2 object, then commits the media row and the `committed` session in one batch. A retry is safe at every step.
- A session expires after 24 hours. `reconcileExpiredMediaUploads` claims `aborting` before the R2 abort and handles at most 50 sessions per call.

## Lifecycle

- Metadata, poster, folder moves, trash and restore need the current `version`. Renditions are derived storage and do not advance it.
- A trashed file still shows everywhere it is used (projections accept `ready` and `trashed`).
- A video poster must be a ready image. Image-only buyer and discovery surfaces use an image or a poster, never a video URL.
- Permanent delete needs the file in trash, no usage and no order-line image snapshot. Otherwise it answers `409 MEDIA_DEPENDENCY_CONFLICT` with the usage. It claims `deleting` behind the `noMediaUsage` guard, deletes the original and renditions from R2, then commits `deleted`. A retry on a `deleting` row finishes the job.
- Deleting a folder moves its files to the root.

## Renditions

- The ladder is `MEDIA_VARIANT_WIDTHS` in `@scalius/shared/media-variants` (1.2x steps from 144 to 1600 px). The master rendition is the source width, capped at 2,400 px. All are WebP. Only JPEG, PNG, WebP and AVIF get renditions. A GIF keeps its original.
- The published URL is the largest rendition. Consumers derive the smaller ones from that URL alone. Changing the ladder needs a migration that sends every image back to its original.
- Who renders:
  - The dashboard browser encodes the ladder and sends it to `POST /{id}/variants` (`components/admin/media-manager/utils/media-variants.ts`).
  - Upload completion enqueues the `media.render_variants` job on `JOBS_QUEUE` with a 120 second delay. The consumer `renderMissingMediaVariants` renders only if `variant_width` is still NULL. It needs the `IMAGES` binding.
  - The cron (`*/15 * * * *`) fans the backlog out to the queue (`enqueueMediaVariantsBacklog`). Without a queue it renders inline (`backfillMissingMediaVariants`, limited by the plan profile). It skips files touched in the last 10 minutes.
  - On the Paid plan profile, a public read that renders a still original queues the job at once (`apps/api/src/utils/media-rendition-hints.ts`, KV marker `media:rendition-hint:<id>`, at most 24 ids per read).
- Plan limits: [`docs/FREE-PLAN.md`](../../../../../docs/FREE-PLAN.md).

## Usage index

- `media.usage.ts` lists every place that can show a file. The Files list, the "Used in" panel and the delete guard share it.
- It matches by id (product photos, video posters, brand logos, content blocks, the published and draft theme) and by object-key substring in saved text (product descriptions, category, collection and page content, the invoice logo, social links, the social image and staff photos).
- Text sources run in compound SELECTs of at most five terms (D1 limit). One count read covers at most 100 files. A file lists at most 50 places. List rows carry `usageCount` and `keptForOrders`.

## Routes

Mounted at `/api/v1/admin/media` by `apps/api/src/routes/admin/media.ts`. Permissions are in `packages/core/src/auth/rbac/route-permissions/content.ts`.

| Method and path | Purpose | Permission |
|-----------------|---------|------------|
| `GET /` | Cursor list (`view=ready` or `trash`) | `media.view` |
| `POST /uploads`, `POST /uploads/import-url` | Initiate an upload; import a public HTTPS file | `media.upload` |
| `GET /uploads/{id}` | Resume status | `media.view` |
| `PUT /uploads/{id}/parts/{n}` | Store one part | `media.upload` |
| `POST /uploads/{id}/complete` | Complete (idempotent) | `media.upload` |
| `DELETE /uploads/{id}`, `POST /uploads/reconcile` | Abort an upload; clean up expired sessions | `media.upload` |
| `PATCH /{id}` | Metadata, poster, folder | `media.upload` |
| `POST /{id}/trash` | Move to trash | `media.delete` |
| `POST /{id}/restore` | Restore | `media.upload` |
| `POST /{id}/variants` | Store renditions | `media.upload` |
| `GET /{id}/original`, `GET /{id}/usage` | Original bytes; places and past-order count | `media.view` |
| `DELETE /{id}/permanent` | Guarded hard delete | `media.delete` |
| `POST /move` | Move up to 90 files with per-file CAS | `media.manage_folders` |
| `GET, POST /folders` | List, create folders | `media.view`, `media.manage_folders` |
| `PUT, DELETE /folders/{id}` | Rename, delete a folder | `media.manage_folders` |

## DVC

Triggers on `media` advance `m:<id>` on every change except `version`, `updated_at` and `folder_id`, so a rendition save refreshes cached pages without a manual step. Readers declare `deps.media()` for an unready poster and `deps.mediaItems()` for content-block files. The dashboard code is `apps/admin-v2/src/components/admin/media-manager/`.
