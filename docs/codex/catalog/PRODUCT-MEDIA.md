# Ordered Product Media Blueprint

Last reviewed: 2026-07-13

Status: implemented and locally verified through the schema/core/API/admin,
protected storefront gallery, and immutable order snapshot. The first-class
Media authority landed in `d6c5961e`; ordered product authority in `c39ceaac`;
order snapshotting in `8dc2b1a3`; Media poster projection in `f07f3ec5`; and the
admin/storefront integrations in `529dd128` and `760cbf7c`. Migration 0020 is
the final no-compatibility removal of the copied-URL table. Deployment, demo
reseed, and live browser/feed/UCP proof remain outstanding.

## Outcome

The URL-bearing legacy product-image subsystem is replaced by ordered product
associations to the global `media` authority. A product can contain images and
videos in one ordered gallery, exactly one association is featured, and every
surface that only accepts an image uses one shared deterministic image
representation. Exact SKU media remains an optional image-only association;
`NULL` continues to mean “use the product representation.”

This is a deliberate no-backward-compatibility cutover:

- do not retain `product_images`, copied media URLs, legacy image markers, axis
  mappings, positional SKU inference, or dual `images`/`media` response shapes;
- do not make video URLs pass as image URLs to preserve old callers;
- do not infer a SKU image from a sibling SKU, option value, or video poster;
- demo catalog/order data may be reset and reseeded after the migration rather
  than preserving invalid legacy associations.

## Pre-cutover boundaries and implemented resolution

The left column records the legacy boundary that motivated the cutover; the
right column is the implemented local authority.

| Boundary | Legacy authority or behavior | Implemented authority |
|---|---|---|
| Blob library | `media` owns immutable R2 object keys, verified image/video kind, poster, lifecycle, and CAS version | It remains the only asset authority |
| Product gallery | copied URL/alt/primary/order rows | `product_media -> media` is the only gallery authority |
| Product write | client submits media-library-shaped URL records; core regenerates image rows | Stable association IDs plus global media IDs are submitted |
| SKU image | SKU points at the copied product-image row | SKU points at an exact same-product image association |
| Storefront detail | `ProductGallery.astro` optimizes and zooms every row as an image | Image or video renders inside the same protected stage/rail geometry |
| Cards/list/search/collections | copied primary URL | Shared image-representation resolver supplies a real image/poster |
| Cart/quick buy | current displayed image URL is copied into client cart state | Exact SKU image resolves first, then the product representation |
| Checkout/order views | receipt/admin order queries dynamically read the product's current primary image | Resolved image asset is snapshotted on the order item |
| Feed/UCP | product primary image plus optional exact SKU image | Only real images/posters resolve; video URLs never occupy image fields |
| OG/JSON-LD | product page assumes the first usable image URL | Shared discovery-image resolver and absolute URL policy apply |
| Media delete | permanent delete guards only video-poster use | Product associations and retained order snapshots also block deletion |

Primary code boundaries include:

- `packages/database/src/schema/products.ts` and `media.ts`;
- `packages/core/src/modules/products/products.admin.ts`,
  `products.validation.ts`, `products.types.ts`, `products.variants.ts`,
  `products.option-matrix.ts`, `products.storefront.ts`,
  `products.public-eligibility.ts`, and `products.feed-diagnostics.ts`;
- `packages/core/src/modules/media/media.service.ts`;
- `apps/api/src/routes/admin/products.ts`, `admin/media.ts`, `products.ts`,
  `orders.ts`, and `admin/orders.ts` plus `schemas/entities.ts`;
- the product form/media section/SKU matrix in `apps/admin-v2`;
- `apps/storefront/src/components/product/ProductGallery.astro`, its controller
  and zoom event contract, product detail, cards, quick buy, cart, checkout,
  account/order views, XML feeds, and UCP routes.

## Authority model

### Global asset

`media` remains the only asset record. Product code persists `media.id`, never
`media.url`; public URLs are derived from immutable `objectKey` using the
current media base. Media kind, MIME, dimensions, duration, poster, lifecycle,
and metadata remain Media-domain facts.

### Product association

Add `product_media`:

| Column | Contract |
|---|---|
| `id` | Stable `pmed_...` primary key. The editor may create it before the product exists so create-time SKUs can reference it. |
| `product_id` | Required FK to `products`, cascade on actual product delete. |
| `media_id` | Required FK to `media`, restrict physical row deletion. The association never changes to another asset. |
| `alt_text` | Optional product-context override, trimmed and at most 500 characters. Effective image alt is override, then Media alt, then product name. |
| `is_primary` | Featured gallery item. At most one per product. |
| `sort_order` | Dense zero-based order, unique per product. |
| `created_at`, `updated_at` | Audit/order timestamps. |

Required constraints/indexes:

- unique `(product_id, media_id)`; the same asset cannot appear twice in one
  gallery;
- unique `(product_id, sort_order)`;
- partial unique `(product_id) WHERE is_primary = 1`;
- checks for ID shape, bounded alt text, non-negative order, and boolean primary;
- indexes on `(product_id, sort_order, id)`, `(media_id, product_id)`, and the
  featured lookup.

The command service enforces the missing “at least one” side: an empty gallery
has no primary; a non-empty gallery has exactly one. A product may be saved as
draft without media, but publication readiness and feed eligibility remain
truthful about its image representation.

### Exact SKU image

Keep the public/domain field name `imageId` and database column
`product_variants.image_id`, but rebuild its FK to `product_media.id` with
`ON DELETE SET NULL`.

The following invariant must be enforced in both service validation and D1
triggers:

1. the association belongs to the variant's product;
2. its global Media asset has `kind = 'image'`;
3. a new assignment uses a ready Media asset;
4. an existing assignment can survive Media trash so trash is reversible and
   does not silently rewrite the product.

Remote D1-compatible triggers put the invalid-reference predicate in `WHEN`
and keep the body to one `SELECT RAISE(...)` statement. Do not embed
`SELECT CASE WHEN` in a trigger body.

`NULL` is valid and means exact SKU image is absent. Its buyer representation
is the product image resolver below. Video associations and their posters are
not SKU-selectable. If a merchant wants a poster as an exact SKU image, that
poster image must also be attached to the product as its own image association.

## One representation resolver

Create a shared, pure projection type and resolver used by core query shaping,
API responses, admin diagnostics, and storefront serialization. Do not
reimplement this order in feeds or page templates.

### Featured gallery item

1. the association with `isPrimary = true`;
2. no runtime fallback should normally be needed because writes enforce the
   invariant; corrupt reads may temporarily choose lowest `(sortOrder, id)` and
   emit an operational diagnostic rather than crash the buyer page.

The featured gallery item may be an image or a video.

### Product image representation

Image-only surfaces resolve the first usable candidate in this exact order:

1. featured image asset;
2. ready/retained image poster of the featured video;
3. first ordered image asset;
4. first ordered video's ready/retained image poster;
5. `null`.

“Retained” here means `trashed` but still referenced. `deleting` and `deleted`
are never usable. New associations can select only `ready` assets. A trash item
stays visible at existing references and is labelled “in trash, still used” in
admin; this prevents a library cleanup action from silently breaking a live
product. Permanent delete remains blocked until references are removed.

The resolver returns asset identity as well as a derived URL:

```ts
type ProductMediaProjection = {
  id: string;                 // product_media.id
  mediaId: string;            // media.id
  kind: "image" | "video";
  url: string;                // derived from media.objectKey
  posterMediaId: string | null;
  posterUrl: string | null;   // derived image URL only
  altText: string;
  caption: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  isPrimary: boolean;
  sortOrder: number;
  status: "ready" | "trashed";
};

type ProductImageRepresentation = {
  productMediaId: string;
  mediaId: string;            // actual image/poster asset
  url: string;
  altText: string;
  source: "featured-image" | "featured-video-poster" |
          "ordered-image" | "ordered-video-poster";
} | null;
```

No placeholder is returned by the authority resolver. Presentation components
may render their existing neutral placeholder; feeds, UCP, OG, and JSON-LD
must fail closed or omit the field when the resolver returns `null`.

### SKU representation

1. valid exact `product_variants.image_id` image association;
2. product image representation above;
3. `null`.

This keeps exact SKU > product image precedence and makes partial SKU image
assignment explicit. It never infers by option label/value and never starts a
video when the buyer chooses a SKU.

## Product command contract

Replace product write `images` with ordered `media` in one SDK-breaking cut:

```ts
media: Array<{
  id: string;                 // stable product association ID
  mediaId: string;            // global ready Media asset
  altText: string | null;
  isPrimary: boolean;
}> // request order becomes dense sortOrder
```

Rules:

- maximum 250 associations per product; reject 251 rather than truncating;
- unique association IDs and media IDs;
- exactly one primary for a non-empty list;
- association IDs use a strict bounded safe-character shape;
- existing association ID/media ID pairs are immutable and must already belong
  to this product; new association IDs must not exist anywhere;
- newly attached assets must be `ready` image/video records;
- all validation happens before the product aggregate batch;
- create-time option matrix variants reference the submitted association ID;
- update and option-matrix commands accept only persisted same-product image
  association IDs;
- the current `aggregateRevision` guards composition changes and advances once.

Reordering with immediate SQLite unique indexes uses a two-step atomic batch:

1. clear all primary flags and move existing orders above a safe offset greater
   than the 250-item maximum;
2. remove omitted associations, upsert retained/new rows at dense final order,
   set the one primary, update dependent SKU references if explicitly confirmed,
   and advance the product revision.

Chunk multi-row inserts so every statement remains below D1's 100 bound
parameters. Do not issue parallel D1 enrichment waves.

If removed associations are referenced by active SKUs, the default API outcome
is a typed conflict containing bounded affected-SKU samples and a count. The
editor then offers one explicit confirmation: “Remove media; these SKUs will
use the featured image.” Resubmission includes the affected association IDs as
an acknowledgement; the same atomic batch sets those SKU `image_id` values to
`NULL`. Never silently cascade an editor removal into SKU presentation.

## Admin workflow

The product Media section uses the completed Media manager through an explicit
`capability="image-or-video"` picker. The SKU matrix uses
`capability="image"` and only receives product image associations.

### Gallery composition

- Keep the existing dense collapsible card, but replace the image-only gallery
  model with ordered media tiles.
- A tile shows the actual image or a video poster/neutral placeholder with a
  persistent play glyph, duration when known, and an accessible Image/Video
  label.
- Direct actions are reorder, set featured, edit contextual alt text, replace
  poster (video), and remove from product. Removing from a product never trashes
  the global asset.
- “Featured” is explicit, not implied only by drag position. A featured video
  explains: its poster is used on image-only surfaces; without a poster the
  first usable product image is used.
- Video without a poster remains allowed in the gallery and shows a clear
  “Add poster” action. It does not make feeds ready by itself.
- A reused asset is deduplicated by global `mediaId` with a clear notice.
- Media in trash remains visible with a warning and Restore/Remove actions, but
  cannot be newly selected.
- Dirty, save, revision-conflict, partial failure, and retry behavior uses the
  product aggregate's existing explicit conventions.

### SKU matrix

- Each row's image picker lists attached image associations only, with
  “Featured fallback” as the first explicit `NULL` choice.
- A video and a video poster that is not separately attached never appear as
  choices.
- Bulk selection may set/clear one exact image across selected SKUs; it writes
  exact row references, not an option-level mapping.
- If only some SKUs have an exact image, the remaining rows visibly say
  “Featured fallback.” That is the complete partial-assignment model; no extra
  inheritance mode is introduced.

## Protected storefront gallery

The product page composition, dimensions, thumbnail rail position, summary,
typography, and mobile layout remain protected. Video is rendered inside the
existing main square and thumbnail slots rather than introducing a new page
section or carousel model.

### Rendering

- An image item keeps the existing optimized thumbnail/main/srcset/zoom path.
- A video thumbnail renders its poster through the image optimizer plus a play
  indicator. Without a poster it renders a neutral video tile, never the video
  URL in `<img>`.
- The selected video renders `<video controls playsinline>` inside the same
  aspect-square stage. It does not autoplay and it never autoplays with sound.
- The initially featured video may use `preload="metadata"`; unselected videos
  keep their URL in data until selected and use `preload="none"` so a 100 MB
  gallery does not eagerly download.
- Selecting another item pauses the current video and clears transient playback
  state. Image zoom and the mobile zoom modal are disabled while a video is
  selected and restore when an image is selected.
- SKU selection switches to the exact SKU image or product image
  representation. It never unexpectedly starts a featured video.
- Variant, thumbnail, zoom, and analytics code share a typed
  `product-media-change` event containing kind, association/media IDs, URL,
  poster, and zoom URL. Remove the old image-only event rather than supporting
  two event protocols.
- Initialization is idempotent across Astro navigation. Use one lifecycle and
  abort/replace old listeners instead of registering both DOM-ready and page-load
  handlers repeatedly.

### Accessibility

- Thumbnail buttons have truthful “View image …” / “Play video …” names,
  `aria-current`, roving keyboard focus, arrow/Home/End navigation, visible
  focus, and at least 44px touch targets.
- The video has an accessible name from contextual alt/caption/product name;
  native controls stay keyboard reachable. Do not remove download/playback
  controls through inaccessible custom chrome.
- Play glyphs are not the only kind cue; visible/screen-reader text identifies
  Video.
- Reduced-motion disables animated thumbnail zoom/smooth transitions. No
  autoplay is introduced under either preference.
- `media.caption` is descriptive copy, not a timed caption track. Do not emit a
  fake empty `<track>`. Silent/non-narrated product demonstrations are supported
  by this launch slice; videos with meaningful speech need a first-class,
  validated WebVTT ancillary-track authority before Scalius can claim timed-
  caption completeness. That follow-up should remain tied to the video asset,
  not stored as an arbitrary product URL.

## Downstream projection matrix

| Surface | Exact rule |
|---|---|
| Product detail gallery | All ordered associations; featured association first in initial state, even when its order is not zero |
| Product list/card/related/search/collection/home | Product image representation; local placeholder only when `null` |
| Product picker/admin table | Same representation and image optimizer; video poster is labelled as poster in admin diagnostics |
| Quick buy/cart | Exact SKU image, then product image representation. Snapshot resolved media identity in cart state; revalidation never trusts image for price/stock |
| Checkout | Render the validated cart line's resolved image; image absence must not block checkout |
| Order item | Persist actual resolved image `media.id` at order commit; render independently of later product edits |
| Feed product row | Product image representation, absolute HTTP(S), or omit row with `missing_image` diagnostic |
| Feed SKU row | Exact SKU image, then product image representation; never video URL |
| UCP search/lookup | Same feed-eligible representation; never advertise a video as `image` |
| Open Graph/Twitter | Product image representation transformed only after absolute storefront URL validation |
| Product/ProductGroup JSON-LD | `image` contains deduplicated absolute image associations and video posters, with resolved featured representation first; no video URL in `image` |
| Product sitemap | Media does not change inclusion except existing product eligibility/cache freshness rules |
| Analytics payload | Resolved image URL is presentation-only; use product/SKU/media IDs for identity |

Do not emit `VideoObject` in the first integration slice. The current authority
does not yet guarantee every fact needed for truthful rich video markup and the
storefront discovery switches do not define a video-schema policy. Add it only
after duration, thumbnail, content URL, upload date, name/description, and
caption policy are all saved and buyer-visible.

## Order snapshot boundary

Current order and receipt reads dynamically query the product's present primary
image, so historical presentation changes when a merchant edits the product.
Add nullable `order_items.product_image_media_id -> media.id` and populate it in
the same checkout/admin-order batch from the SKU/product resolver. Order reads
join that exact image asset and derive its current public URL; they do not query
current product composition.

This reference is historical. Permanent Media deletion is blocked while a
retained order item references the image. Product media removal remains allowed
because the order owns its snapshot reference. If the order domain chooses a
formal retention/purge policy later, it may release these references only as
part of that audited policy.

The order-items rebuild and checkout/admin-order changes should be a separate
reviewed migration/commit immediately after core product media, because order
tables participate in inventory, returns, invoices, and receipt security. Do
not casually rebuild them inside the initial product-table migration.

## Lifecycle and dependency rules

- Product association is a reference, not ownership. Removing it never deletes
  or trashes Media.
- Media trash hides an asset from new selection but existing product and order
  references keep resolving it. Admin copy must say this plainly.
- Permanent deletion checks, before the durable `deleting` claim:
  - non-deleted `media.poster_media_id` references;
  - every `product_media.media_id` association, including trashed products;
  - retained `order_items.product_image_media_id` snapshots;
  - later Page/theme/navigation references as those domains migrate to Media IDs.
- A conflict returns aggregate counts and bounded safe samples of where the
  asset is used, never a generic “failed to delete.”
- The dependency check and `trashed -> deleting` CAS claim must be race-safe.
  A new product association is allowed only for `ready` media, so no new
  product dependency can appear after the asset has been claimed deleting.
- Poster changes, alt/caption changes, trash/restore, and product association
  changes invalidate every affected buyer projection.

## Cache and performance contract

- Product-detail media is one ordered join across `product_media`, `media`, and
  poster Media; no per-item/poster N+1 queries.
- Catalog lists enrich product IDs in sequential chunks of 90 or fewer and use
  the shared SQL/projection helper for one representation per product.
- Feed/UCP keyset pagination remains product-based; media joins must not
  multiply or split product rows. Resolve/enrich selected product IDs after the
  bounded page query.
- Image resizing is used only for image/poster URLs. MP4/WebM bypass the image
  optimizer and retain range-request/CDN behavior.
- Gallery HTML does not contain eager `<source src>` values for every video.
  Only selected video metadata is requested.
- Media mutations that affect presentation resolve dependent product IDs by the
  indexed `(media_id, product_id)` association and use the existing durable
  storefront-cache queue/fallback in bounded waves. Invalidate product detail,
  public list/search, dependent collection/category pages, feed, sitemap
  availability projections, `feed_products_`, and `sitemap_products_` exactly
  as a product media write would.
- Product association writes invalidate synchronously for their one known
  product after the D1 aggregate commit. Cache/KV remains projection, never
  media/product authority.

## Migration and demo seed

### Product composition and final cutover

After the committed Media migration 0017 and category migration 0016:

1. create `product_media` with the constraints/indexes above;
2. rebuild `product_variants` so `image_id` targets `product_media.id`;
3. set all legacy variant image references to `NULL` rather than guessing;
4. after every reader is cut over, drop the copied-URL table and its indexes;
5. create same-product/image-kind triggers using remote-D1-safe `WHEN` guards;
6. regenerate Drizzle metadata using `pnpm db:generate`—never hand-edit generated
   snapshots/journal.

Do not copy old `product_images.url` values into `media`; their origin, kind,
object authority, signature, and lifecycle are unverified. The catalog is demo
data, so an explicit demo seed will attach ready Media assets cleanly.

`0018_magenta_scream.sql` implements steps 1–3 and 5. The generated
`0020_chemical_captain_britain.sql` performs step 4 after the core/API/admin and
storefront readers have moved to the shared projection. Both generated
snapshots and journal entries are Drizzle-owned.

### Order presentation snapshot

Migration `0019_loose_living_mummy.sql` safely extends `order_items` to add
the nullable image Media reference. Because data is demo-only, old rows may
remain `NULL`; do not dynamically backfill from the then-current product image
and pretend it is an historical snapshot.

### Seed

Provide one idempotent, explicitly demo-only seed command that:

- uploads/reuses at least two images and one MP4/WebM through the real Media
  upload/session API;
- assigns a poster image to the video;
- creates an image-primary product and a video-primary product;
- creates arbitrary option axes and SKUs with full, partial, and no exact image
  assignment;
- includes sold-out and available SKUs, discounts, an order/cart candidate,
  and a video without poster to exercise fallback diagnostics;
- records returned IDs rather than embedding guessed URLs.

Never seed fake absolute URLs or bypass Media lifecycle checks in production
migrations.

## Test matrix

### Schema/domain

- 0, 1, 250, and rejected 251 product associations;
- duplicate media/association/order/primary rejection;
- image and video featured states; featured video with/without poster;
- attach ready versus rejected trash/deleting/deleted asset;
- exact SKU image accepted, video rejected, cross-product association rejected;
- partial SKU assignment and `NULL` fallback;
- reorder/primary switch under immediate unique indexes;
- concurrent aggregate revision conflict advances exactly once;
- remove referenced image conflict, confirmed clear-to-fallback, and no-op retry;
- D1 trigger tests applied through local Wrangler and a remote-compatible
  migration smoke (no `SELECT CASE WHEN` body).

### Resolver/discovery

- every candidate in the exact fallback order, including trashed retained
  references and deleted/deleting exclusion;
- exact SKU override versus fallback;
- no placeholder returned from authority;
- feed/UCP/XML/OG/JSON-LD never place MP4/WebM in an image field;
- non-absolute/unsafe derived image fails closed;
- stable feed/UCP continuation with multi-media products;
- feed diagnostic reasons match emitted XML policy.

### Admin

- picker capability excludes videos from SKU selection;
- reorder, featured selection, contextual alt, poster, remove, duplicate,
  trash-retained, and revision-conflict workflows;
- keyboard operation, focus restoration, compact desktop/mobile overflow;
- exact affected-SKU confirmation when removing a referenced image;
- failed upload remains in Media upload UI and does not create a product
  association.

### Storefront/buyer

- protected layout screenshot comparison at desktop and mobile for image-only,
  mixed, and video-primary products;
- image zoom, video play/pause/switch, poster/placeholder thumbnail, no eager
  offscreen video transfer, reduced motion, and keyboard rail;
- SKU image switch, unmapped fallback, and no variant-triggered autoplay;
- quick buy/cart/checkout with exact/fallback/no image;
- order snapshot remains stable after product media reorder/removal;
- image/poster mutation invalidates list/detail/feed/UCP/HTML cache families;
- Product JSON-LD and OG match buyer-visible image and selected SKU cache
  isolation remains intact.

## Implementation evidence and remaining release steps

- `c39ceaac`, `108e0291`, and `c086e98b` establish the normalized schema,
  resolvers, strict public/admin projections, cache boundaries, and alt-text
  authority.
- `8dc2b1a3` makes order-item image presentation an immutable retained Media
  snapshot; `f07f3ec5` makes off-page video posters reloadable without N+1
  reads.
- `529dd128` and `760cbf7c` integrate the compact admin editor and the protected
  storefront gallery without restoring image-only compatibility shapes.
- Admin Media PATCH/trash/restore now resolve direct product associations and
  videos using a changed image as their poster through indexed, keyset pages;
  each bounded page uses the targeted product invalidator so list/search,
  dependent collections, feed/sitemap, product HTML, and exact storefront
  generation families cannot retain stale presentation.
- Migration 0020 and its generated snapshot remove the last schema declaration
  and physical copied-URL table after 0018/0019 have established the replacement
  foreign keys and order snapshot.

Before release, run `pnpm generate:sdk` once all API changes settle, complete the
repository-wide gates (`check:env`, tests, builds, ops/release smokes), then apply
migrations and deploy API before admin/storefront clients. Reset the demo catalog
through authoritative Media/product commands and live-smoke the 23.56 MB video
upload, product edit, SKU selection, cart, checkout, order receipt, feeds, UCP,
JSON-LD, cache freshness, and desktop/mobile gallery.

Do not expose the mixed-media product UI before API, storefront, feed/UCP, and
order fallbacks are deployed coherently. Until that deployment, the correct
user-facing statement is that image/video product support is implemented and
verified locally but not yet proven end to end in production.
