# Media Authority, Video, and Workflow Audit

Last reviewed: 2026-07-13

## Current truth

Media is now a first-class image/video domain rather than an image uploader with
a larger allowlist:

- the shared client/API/storage policy accepts JPEG, PNG, GIF, WebP, and AVIF up
  to 20 MiB, plus MP4 and WebM up to 100 MiB, with at most 50 files per batch;
- every asset uses a durable D1 upload session and 5 MiB R2 multipart parts, so
  a complete video is never buffered in one Worker invocation;
- bounded file signatures, MIME/extension coherence, exact part lengths,
  idempotent completion, expiry, abort, repair, trash, and guarded permanent
  deletion are implemented;
- the admin library distinguishes images and videos, renders video playback,
  supports optional image posters and captions, and preserves intrinsic
  dimensions/duration when the browser can read them;
- product media is an ordered image/video association. The protected storefront
  gallery renders video in the existing stage with controls and poster
  thumbnails, while image-only buyer/discovery surfaces resolve a real image or
  poster and never pass a video URL through the image optimizer;
- exact SKU media remains an optional image reference. `NULL` falls back to the
  product's primary image representation, so partial SKU assignment is valid.

The old 10 MB rejection was a superseded image-only path. A 23.56 MB MP4 is
valid under the current policy. The remaining launch limitations are explicit:
3D models are not supported, videos are direct MP4/WebM delivery rather than an
adaptive transcoding pipeline, timed VTT caption tracks are not yet modeled,
and browser upload resume requires the original tab/File to remain available.
The upload queue therefore warns before the document closes and says to keep the
tab open; server multipart state alone cannot reconstruct a browser `File`.

## Superseded P0/P1 audit findings

The following findings describe the image-only system that migration 0017 and
the implemented milestone below replaced. Keep them as architectural rationale,
not as current operational defects.

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
- Videos use controls, playsInline, preload metadata/none, keyboard semantics,
  reduced-motion/autoplay discipline, and do not download offscreen. No autoplay
  with sound. Timed captions require a future first-class VTT-track model; the
  current `caption` field is descriptive metadata, not a timed text track.
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

## Implemented domain milestone (2026-07-12)

Migration 0017 replaces the demo image-only library with first-class
image/video authority, flat versioned folders, immutable object keys, coherent
kind/MIME and lifecycle checks, and durable multipart session/part tables. The
core/API path now claims D1 before creating R2 multipart state, buffers only
one exact 5 MiB-or-smaller part into a known-length R2 body, verifies actual
length and part 1 before R2, reconciles R2-complete/D1-incomplete retries,
derives URLs at response time, provides stable scoped cursors and CAS mutations,
and makes trash/permanent deletion repairable. The complete video is never
buffered in a Worker invocation.

### Media workflow follow-up (2026-07-13)

- The local R2 passthrough now accepts the complete immutable object key
  (`media/<id>.<ext>`) rather than one URL segment, validates it with the same
  storage-key authority, copies stored HTTP metadata, and forwards byte-range
  requests as `206` responses. Local MP4/WebM playback can therefore exercise
  browser seeking instead of hiding a route mismatch behind the production CDN.
- While the original browser `File` is available, the upload queue reads image
  dimensions or video dimensions/duration in parallel with multipart upload.
  After R2 completion and D1 media commit it saves only finite positive hints
  through the normal Media CAS command. Extraction or metadata-save failure
  never fabricates facts and never turns a successfully stored blob into a
  failed upload; the queue keeps a visible follow-up warning instead.
- A failed initial or refreshed library read is no longer rendered as an empty
  library. The workspace preserves any prior results, explains that refresh
  failed, and provides an in-place retry state for both full-page and picker
  use.

### Media library interaction follow-up (2026-07-13)

- Asset and folder reads use the same-origin admin API proxy with explicit
  `no-store`/`no-cache` semantics. The library is an operational work surface:
  browser or server-function GET reuse must not preserve an earlier empty
  result after uploads, demo population, restore, or navigation. Request IDs in
  the client hook still ensure a slower older response cannot replace the
  newest filter result.
- `Select` now enters an empty selection mode. Selecting every loaded result is
  a separate `Select all shown` command, so beginning a bulk workflow never
  silently targets the whole visible library. Standalone library selection can
  be cancelled; multi-file pickers stay in selection mode after clearing so
  their card semantics remain truthful.
- Selection uses one shared contract across the library and every picker:
  click/keyboard activation toggles one asset, Shift-activation adds the
  inclusive visible range, `Select all shown` never targets an unloaded or
  filtered-out asset, and changing scope clears hidden selections. A dedicated
  compact command bar keeps the live count, clear/cancel, move, lifecycle, and
  picker-confirm actions visible without mixing destructive work into filters.
  A current value in a single-file picker is highlighted only; it never turns
  that picker into multi-toggle mode or prevents the next click from choosing
  and closing with a replacement asset. Partial bulk lifecycle failures retain
  only the failed assets in the selection so the merchant can retry them
  without repeating already successful mutations. A completed upload is
  immediately resolvable by multi-picker confirmation while the library refresh
  is still pending, so a visible `Add 1` action can never submit zero assets.
- The gallery uses two, three, four, then five columns as viewport room grows
  and caps at five on wide screens. Loading skeletons use the same grid, avoiding
  layout shifts between the loading and ready states.
- Library thumbnails request a bounded 480 x 360 `contain` transform and render
  with `object-contain`. The media workspace is an inspection surface, so it
  must show the complete asset instead of pre-cropping it to a tile. Card and
  folder actions remain visible on touch devices rather than depending on hover.
- This interaction change does not alter upload limits or video lifecycle
  architecture; those remain governed by the first-class media authority above.

### Selection command follow-up (2026-07-13)

- The standalone library now treats `Clear` and `Cancel` as different commands.
  `Clear` removes the current checked assets while keeping selection mode open;
  `Cancel` leaves selection mode and returns keyboard focus to the `Select`
  trigger. Entering selection mode always starts at zero, even if an earlier
  operation left stale local IDs.
- Escape performs the same non-destructive cancellation in the standalone
  workspace. It is disabled for picker dialogs, previews, alert dialogs, and
  open menus so the closest transient surface keeps standard Escape behavior.
  Multi-file pickers remain in their truthful persistent selection mode and use
  the dialog's normal Close/Escape action instead.

### Media workspace polish follow-up (2026-07-13)

- The five-column desktop cap remains the density contract. Cards now expose
  the supported file type, byte size, and available duration or dimensions in
  one compact metadata line; video posters and media previews continue to use
  contain geometry so inspection never silently crops the asset.
- Mobile uses one horizontally scrollable folder rail instead of a tall folder
  panel. The selected folder is programmatically current, folder actions remain
  available without hover, and compact-screen controls receive larger targets
  while desktop controls retain the denser workbench sizing.
- Bulk commands use outcome language: `Move`, `Move to trash`, `Restore`, and
  `Delete permanently`. Per-card lifecycle menus disappear in selection mode so
  a bulk workflow has one action authority. `Select all shown` still applies
  only to the currently loaded result scope and entering `Select` still starts
  with zero selected assets.
- Preview metadata is now a guarded draft. Changing the file name, image alt
  text, video caption, or video poster exposes `Unsaved details`, enables Reset
  and Save only when meaningful, and requires explicit confirmation before
  closing or navigating away. Refreshes of the same asset revision do not erase
  a merchant's in-progress draft. Video captions are labelled honestly as
  descriptive text rather than timed caption tracks.
- Loading and ready grids share scrollable five-column geometry and expose list
  semantics. Supported AVIF, MP4, and WebM labels plus bounded video duration
  formatting are presentation-only; the first-class image/video authority,
  multipart limits, and protected storefront product-page composition are
  unchanged.

## Platform evidence

- [Shopify's current file requirements](https://help.shopify.com/en/manual/shopify-admin/productivity-tools/file-uploads)
  allow 20 MB images and 1 GB MOV/MP4/WebM product videos up to 10 minutes,
  and describe a processing pipeline that selects streaming/MP4 output. Scalius's
  initial 100 MB MP4/WebM limit is therefore a safe direct-delivery launch tier,
  not a claim of competitive parity or a permanent architecture ceiling. Raising
  it further requires adaptive transcoding/streaming and storage policy, not a
  larger constant on the buffered upload route.
- [Shopify product-media guidance](https://help.shopify.com/en/manual/products/product-media/add-media)
  treats the first product media item as the featured item used on collection,
  cart, checkout, and home surfaces. Scalius keeps the merchant's ordered primary
  media choice but must resolve an image/poster representation on image-only
  surfaces instead of sending a raw video URL to `<img>` or feed consumers.
- [Cloudflare R2 upload guidance](https://developers.cloudflare.com/r2/objects/upload-objects/)
  identifies multipart upload as the resumable/parallel path for video and
  requires uniform 5 MiB–5 GiB parts except the final part.
- [Cloudflare's Workers multipart guide](https://developers.cloudflare.com/r2/api/workers/workers-multipart-usage/)
  confirms `createMultipartUpload`, `uploadPart`, `complete`, and `abort` can
  support objects beyond one Worker request-body limit.
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
  cap an isolate at 128 MB and explicitly recommend streaming instead of
  buffering large bodies. Free/Pro request bodies also cap at 100 MB, so a
  nominal 100 MB video cannot safely use today's `file.arrayBuffer()` path.
