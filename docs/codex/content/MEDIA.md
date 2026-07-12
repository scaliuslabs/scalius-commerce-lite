# Media Authority, Video, and Workflow Audit

Last reviewed: 2026-07-12

## Current truth

The current UI suggests a general media library, but the implementation is an
image-only uploader:

- client defaults are `image/*`, 10 MB, and 20 files;
- the API service separately caps 50 files at 10 MB;
- R2 storage accepts only image MIME types/extensions and buffers the complete
  object before `put`;
- Media cards and preview always render `<img>` through the image optimizer;
- product media rows contain URL/alt/primary/order only, without asset kind,
  MIME, dimensions/duration, poster, or processing state;
- product gallery, zoom, cards, cart, checkout, feeds, UCP, schema, and variant
  image selection all assume an image URL.

Therefore a 23.56 MB MP4 is not merely over an arbitrary limit: video is not
currently supported end to end. Raising the limit or MIME allowlist alone would
create corrupt previews and buyer surfaces.

## P0/P1 storage and lifecycle defects

1. Upload commits R2 first and then inserts D1. A database failure can orphan
   the object; partial uploads do not have a durable reconciliation record.
2. Delete removes D1 first and then R2. An R2 failure loses the authoritative
   row while retaining an unreachable object. It also has no dependency guard
   for products, variants, Pages, navigation, theme, hero, or settings JSON.
3. Individual media deletion is immediate hard delete despite `deleted_at`.
   Bulk delete is a sequential client loop with partial outcomes and no one
   command/idempotency contract.
4. IDs and metadata are weakly bounded. Move arrays can exceed D1 limits;
   filename, alt text, folder name, search, MIME prefix, and folder IDs need
   canonical length/shape validation. Folder targets and parents are not
   checked for existence; hierarchy is accepted but not implemented.
5. List ordering lacks an ID tie-breaker. Offset pages can move under equal
   timestamps/names/sizes. Folder listing silently truncates at 200.
6. MIME/extension come from the browser. SVG is served as public active content
   and requires an explicit sanitization/download policy; media kind should be
   verified from bounded file signatures rather than trusted labels alone.

## Video decision

- Support commerce video as a first-class `video` asset, initially MP4/H.264
  and WebM, with a documented maximum of 100 MB. A short commerce video in the
  50–100 MB range is normal.
- Do not pass 100 MB multipart bodies through the existing Worker buffer. Use a
  resumable R2 multipart session with bounded parts and durable D1 session
  state: initiated, uploading, completing, committed, aborted/expired. Complete
  D1 media metadata only after R2 completion; retries are idempotent.
- Keep an ordinary bounded image upload path (for example 20 MB) and share one
  media validation/limits authority between client, API, and storage.
- Store `kind`, verified MIME, object key, size, dimensions, duration when
  known, poster image reference, processing/readiness state, and version. The
  R2 object key is immutable; merchant rename changes display filename only.
- R2 is blob authority and D1 is catalog/lifecycle authority. Trash hides an
  asset but retains references. Permanent deletion requires trash state, zero
  live dependencies, an idempotent deletion claim, confirmed R2 deletion, then
  terminal D1 state/audit. A repair job reconciles expired multipart sessions
  and orphan candidates.

## Product and storefront media contract

- Product gallery media becomes an ordered image/video association. Adding a
  video must not change the protected product page layout; the existing main
  stage and thumbnail rail render the correct element inside the same geometry.
- A video thumbnail is its poster image with a play indicator, never the raw
  video URL rendered through the image optimizer. Merchant may select a poster
  from the image library; until automatic extraction/transcoding exists, a
  missing poster uses a neutral video placeholder inside the gallery.
- Catalog cards, cart, checkout, social/SEO images, JSON-LD image fields,
  Google/Meta feeds, and UCP require a real image/poster. They must choose the
  explicit primary image, then a video poster, then another valid product image;
  they must never advertise a video URL as `image_link` or `<img src>`.
- Exact SKU image selection remains image-only. Variant selection may change to
  a product image/poster; it must not unexpectedly autoplay a SKU video.
- Videos use controls, playsInline, preload metadata/none, captions-track
  support, keyboard semantics, reduced-motion/autoplay discipline, and do not
  download offscreen. No autoplay with sound.
- Page rich content and navigation/theme surfaces reference stable media IDs,
  not copied URL blobs, so dependency checks and replacements are possible.

## Admin workflow contract

- One media workspace supports Images and Videos honestly; remove Documents
  until document upload/preview/security is implemented.
- Upload UI shows per-file kind-specific limits, progress, pause/retry/cancel,
  partial-success detail, and resumability. It does not claim 20 files while the
  server accepts 50.
- Dense gallery/list toggle, URL-backed folder/type/search/sort, stable server
  pagination, clear used-in count, alternative text for images, caption/title
  for video, poster control, and an explicit processing/failed state.
- Selection dialogs accept a declared capability (`image`, `video`, or both).
  Product SKU image and SEO image pickers request images only; product gallery
  and rich-content embeds may request both.
- Folder model stays flat unless hierarchy is implemented fully. Remove unused
  `parentId` behavior rather than preserving a misleading half-model.

## Verification bar

- Image and 23–100 MB video upload, interruption/retry, duplicate completion,
  expired abort, D1 failure after R2 completion, R2 failure during delete, and
  dependency-blocked permanent delete.
- File-signature/MIME mismatch, SVG policy, zero/oversized objects, 50/51 batch
  limits, 90/91 ID commands, folder deletion/move races, and stable pagination.
- Media library card/preview and product gallery at desktop/mobile; video poster
  and keyboard behavior; no image optimizer applied to video.
- Product card/cart/checkout/order/feed/UCP/JSON-LD use a valid image/poster and
  never a video URL. Protected product-page composition remains unchanged.
