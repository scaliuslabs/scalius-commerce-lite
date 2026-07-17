# Homepage Hero Contract

Last reviewed: 2026-07-17

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
- Every normalized slide owns one source-relative focal point with horizontal
  and vertical coordinates from `0` to `100`. Existing documents without this
  field normalize to the historical center position (`50`, `50`); an explicit
  malformed or out-of-range value fails validation instead of silently moving
  the merchant's chosen subject.
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
the editor no longer previews both viewports at an unrelated 16:5 ratio.

Hero images intentionally use `cover`, but the crop is no longer assumed to be
centered. The row preview exposes one compact **Focus** action on the image. Its
progressive popover uses the complete, non-cropped source as the coordinate
surface: merchants can click the subject, adjust horizontal/vertical range
controls for keyboard precision, or reset to center. Draft previews apply the
choice before the explicit document save.

The same percentage authority projects to CSS `object-position` for local
previews and Cloudflare's relative `gravity=XxY` coordinates for the delivered
cover transform. This avoids pre-cropping source pixels and keeps one stable
merchant choice across responsive rendering. Desktop and mobile hero documents
remain separate, so each viewport can select a different source image and focal
point without adding a second breakpoint-specific position field to a slide.

## Migration and verification

- Migration `0023_bouncy_norman_osborn.sql` backfills revision `1`, retires any
  duplicate current viewport rows deterministically, adds the positive revision
  check, and adds the partial unique viewport index.
- Focused proof covers safe-link and focal-point normalization, CSS/Cloudflare
  projection, malformed public fail-closed
  behavior, D1 revision conflicts, active-empty rejection, duplicate viewport
  protection, migration backfill/deduplication, explicit admin save boundaries,
  homepage cache invalidation, and non-anchor storefront rendering.
