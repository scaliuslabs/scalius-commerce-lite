# Media Domain

The Media domain owns image/video catalog metadata in D1 and immutable blobs in
R2. D1 stores `objectKey`; public URLs are derived from the current R2 base and
are never durable authority.

## Authority

- `media`: ready/trash/deleting/deleted lifecycle, verified kind/MIME, object
  key, dimensions/duration, optional image poster, folder, and CAS version.
- `media_folders`: flat, case-insensitively unique active folders with CAS.
- `media_upload_sessions` and `media_upload_parts`: durable multipart intent,
  uploaded part evidence, expiry, R2-completion recovery, and idempotency.
- `@scalius/shared/media-policy`: the only MIME, signature, filename, file-size,
  part-size, and part-count policy.

Supported launch formats are JPEG, PNG, GIF, WebP, AVIF (20 MiB) and MP4/WebM
(100 MiB). Every upload uses 5 MiB R2 multipart parts except the final part.
The API materializes exactly one bounded part at a time as a known-length
`ArrayBuffer` before R2, never the complete media object. This makes actual
length and part-1 signature checks finish before the storage side effect.

## Lifecycle rules

- Initiation commits an `initializing` D1 claim before creating the R2 upload.
- Parts stream to R2; a video is never assembled in Worker memory.
- Completion first claims `completing`. A retry heads the deterministic object
  and can commit D1 after an earlier R2-success/D1-failure boundary.
- A committed completion retry is read-only and verifies the media row still
  matches the upload session.
- Metadata, moves, folders, trash, and restore use optimistic revisions.
- Successful metadata/poster, trash, restore, and rendition mutations bump the
  store cache generation after they commit, so every page that shows the image
  refreshes without a dependency scan. Renditions are derived storage and do
  not advance the media revision.
- Every upload completion (direct or URL import) that still lacks renditions
  enqueues one `media.render_variants` job on `JOBS_QUEUE`, delayed 120 s. The
  consumer (`renderMissingMediaVariants`) renders only if `variant_width` is
  still NULL, so the dashboard's browser pipeline normally wins and the job
  skips; it bumps the cache generation only when it rendered. Render failures
  are acked and left to the cron. Without `IMAGES` (local dev) nothing is
  enqueued and a delivered job is a no-op.
- The API cron (`backfillMissingMediaVariants`, when the `IMAGES` binding
  exists) runs last and renders missing renditions two images at a time, least
  recently touched first, until none are left, 240 were attempted, or the run
  is 10 minutes old; one cache-generation bump per run that rendered any. It
  skips media touched in the last 10 minutes (an upload's own pipeline and
  job). A failure only touches `updated_at`, so a broken image leaves the run
  and next time goes behind every other candidate. Each commerce sweep before
  it is isolated, so a sweep that keeps failing no longer starves the backfill;
  the run still fails with the first error after the backfill ran. With the
  jobs queue, `enqueueMediaVariantsBacklog` first sends up to 1,000
  candidates to it (`sendBatch` of 100, no delay) and the run renders nothing
  inline: consumers render them in parallel, so a large backlog (after
  migration 0094, every image) clears in minutes, not one 240-image run per
  15 minutes. Inline rendering is the fallback without a queue.
- Self-healing on read (`apps/api/src/utils/media-rendition-hints.ts`): when a
  public read renders (a cache miss) and its body still publishes a still
  original (`media/<id>.<jpg|png|webp|avif>`), up to 24 ids per read (a
  listing page's cards) get the `media.render_variants` job with no delay,
  deduplicated by a 15-minute KV marker `media:rendition-hint:<id>`, with one
  masked log line per read. Cards show their placeholder (never an original)
  and the product page the original until the job renders and bumps the
  generation.
- The rendition ladder (`MEDIA_VARIANT_WIDTHS`, @scalius/shared) is read from
  the published URL alone, so changing it needs a migration that sends every
  rendered image back to its original (0094 added 240 and 400); the read
  hints and the backlog fan-out then re-render them under the same keys.
- Usage (`media.usage.ts`) is the one list of places that can show a file:
  product photos, video covers, and media URLs saved in product descriptions
  and extra sections, categories, collections, pages/blog posts, homepage
  banners, theme logo/icon, navigation (social links, footer text), invoice
  logo, social sharing image and staff photos. Files list pages carry
  `usageCount` and `keptForOrders`; `GET /{id}/usage` names the places.
  Text surfaces are read in compound SELECTs of at most five terms (D1 limit).
- Trash keeps a used file showing everywhere (projections accept `trashed`).
- Permanent delete requires trash and no usage and no retained order-item
  image snapshot; it answers 409 `MEDIA_DEPENDENCY_CONFLICT` with the usage,
  atomically claims `deleting` behind the same `NOT EXISTS` guards, confirms
  R2 deletion, then commits terminal D1 state. Retrying a `deleting` row
  repairs the final transition.
- Expired multipart cleanup claims `aborting` before the R2 side effect and is
  bounded to 50 sessions per reconciliation call.

## Admin API

Mounted at `/api/v1/admin/media`:

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Stable cursor list; explicit `ready` or `trash` view |
| POST | `/uploads` | Initiate an image/video upload |
| GET | `/uploads/{id}` | Resume/status projection (never exposes upload ID) |
| PUT | `/uploads/{id}/parts/{n}` | Stream one exact-size octet-stream part |
| POST | `/uploads/{id}/complete` | Idempotent complete/reconcile |
| DELETE | `/uploads/{id}` | Abort an incomplete upload |
| POST | `/uploads/reconcile` | Bounded expired-session cleanup |
| PATCH | `/{id}` | CAS metadata/poster/folder update |
| POST | `/{id}/trash` | CAS move to trash |
| POST | `/{id}/restore` | CAS restore |
| GET | `/{id}/usage` | Places that show the file and past-order count |
| DELETE | `/{id}/permanent` | Guarded, repairable hard delete |
| POST | `/move` | Up to 90 per-item CAS moves using one `json_each` claim set |
| GET/POST | `/folders` | Cursor list/create flat folders |
| PUT/DELETE | `/folders/{id}` | CAS rename/delete |

Product associations reference Media IDs rather than copied URLs. A video can
be ready without a poster, but image-only buyer/discovery surfaces resolve a
real image/poster through the shared product-media resolver and never pass a
video URL to `<img>`.
