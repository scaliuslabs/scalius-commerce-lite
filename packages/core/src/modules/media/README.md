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
Part 1 must match the declared MIME signature before any R2 part write.

## Lifecycle rules

- Initiation commits an `initializing` D1 claim before creating the R2 upload.
- Parts stream to R2; a video is never assembled in Worker memory.
- Completion first claims `completing`. A retry heads the deterministic object
  and can commit D1 after an earlier R2-success/D1-failure boundary.
- A committed completion retry is read-only and verifies the media row still
  matches the upload session.
- Metadata, moves, folders, trash, and restore use optimistic revisions.
- Permanent delete requires trash and zero live poster/product associations or
  retained order-item image snapshots,
  returns bounded dependency counts/samples, atomically claims `deleting`
  behind `NOT EXISTS` guards, confirms R2 deletion, then commits terminal D1
  state. Retrying a `deleting` row repairs the final transition.
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
| DELETE | `/{id}/permanent` | Guarded, repairable hard delete |
| POST | `/move` | Up to 90 per-item CAS moves using one `json_each` claim set |
| GET/POST | `/folders` | Cursor list/create flat folders |
| PUT/DELETE | `/folders/{id}` | CAS rename/delete |

Product associations reference Media IDs rather than copied URLs. A video can
be ready without a poster, but image-only buyer/discovery surfaces resolve a
real image/poster through the shared product-media resolver and never pass a
video URL to `<img>`.
