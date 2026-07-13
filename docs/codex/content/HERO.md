# Homepage Hero Contract

Last reviewed: 2026-07-13

## Authority and write workflow

- `hero_sliders` owns exactly one current `desktop` and one current `mobile`
  document. A partial unique index enforces that invariant for non-trashed rows.
- Each document has a positive monotonic `revision`. Admin updates require
  `expectedRevision`, update the full ordered slide document atomically, and
  advance revision exactly once.
- The builder keeps saved and draft snapshots separately. Title, destination,
  active-state, add/remove, and reorder operations are local until the merchant
  chooses **Save changes**. Discard restores the last saved snapshot.
- A stale save returns `HERO_SLIDER_REVISION_CONFLICT`. The merchant draft is
  preserved and the UI requires an explicit **Load latest** choice; background
  reads never overwrite active work.
- New viewport documents start inactive. An active document requires at least
  one valid slide.

## Slide contract

- A hero contains at most 12 ordered slides with unique stable IDs.
- Every slide requires a credential-free HTTPS image and concise descriptive
  image text. This text is the image alternative text and is not a decorative
  marketing-title field.
- Destination is optional. Internal paths and credential-free HTTPS URLs use
  the shared navigation safe-link policy. Empty values and the legacy `#`
  placeholder canonicalize to an empty destination.
- The storefront renders an empty destination as a non-interactive `div`, never
  as an anchor to `#`. External destinations open separately with
  `noopener noreferrer`; unsafe persisted documents fail closed to no slides.
- Auto-rotation is disabled for customers who prefer reduced motion.

## Presentation boundary

The Hero editor and Theme settings are adjacent presentation tools but do not
share persistence. Theme owns the allowlisted storefront color tokens; Hero
owns ordered media, alternative text, optional destination, viewport, and
visibility. Hero controls deliberately retain image-overlay contrast rather
than deriving navigation affordances from merchant colors. A future versioned
Theme document must not absorb Hero content or its revision.

Desktop and mobile source dimensions are one shared presentation contract:
1300 × 500 and 640 × 300 respectively. The admin editor, image-optimizer
request, and intrinsic storefront image dimensions consume that same authority;
the editor no longer previews both viewports at an unrelated 16:5 ratio. Images
remain center-cropped with `object-cover` to fill the live viewport. Per-slide
focal-point control is not modeled yet and remains the next crop-specific
improvement; do not imply that capability through a decorative positioning UI.

## Migration and verification

- Migration `0023_bouncy_norman_osborn.sql` backfills revision `1`, retires any
  duplicate current viewport rows deterministically, adds the positive revision
  check, and adds the partial unique viewport index.
- Focused proof covers safe-link normalization, malformed public fail-closed
  behavior, D1 revision conflicts, active-empty rejection, duplicate viewport
  protection, migration backfill/deduplication, explicit admin save boundaries,
  homepage cache invalidation, and non-anchor storefront rendering.

No live deployment or demo-data replacement was performed in this slice.
