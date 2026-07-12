# CMS Pages Audit and Decisions

Last reviewed: 2026-07-12

## Verified current strengths

- Public reads enforce non-deleted, published, and scheduled-publication truth.
- Stored and rendered rich HTML is sanitized; public rendering distinguishes
  authoritative absence from layout-data unavailability.
- Resource canonical, noindex, sitemap exclusion, featured image, header,
  footer, and title controls reach the storefront route.
- Public page writes invalidate API groups and exact rendered HTML paths, and
  the sitemap uses the resource discovery policy.
- RBAC already separates view, create, edit, delete, and publish capabilities;
  the shared form save boundary fails closed for create/edit.

## P1 authority defects

1. Pages have no revision/CAS. Two editors can silently overwrite title,
   content, discovery, display, scheduling, or featured-image changes.
2. New pages default to published in the database validation and admin form.
   Creation must be Draft by default; publication is a distinct capability and
   must pass readiness checks.
3. The form's edit loader converts every fetch failure into a redirect to the
   list. Only a typed 404 may redirect; permission, timeout, and upstream
   failure must preserve the route and expose Retry.
4. Update/delete/bulk lifecycle writes are not state-conditioned or row-count
   checked. Permanent delete is callable for an active row, bulk ID arrays are
   unbounded, publish can touch trash, and restore can claim success for a
   missing/non-trashed row.
5. Slug uniqueness is global in the database but service preflights only active
   rows. Restore and create/update copy can therefore disagree with the actual
   unique constraint. Slugs must also reject reserved storefront routes such as
   checkout, search, account, products, categories, collections, API, and
   discovery assets; otherwise a saved page has a dead or shadowed public URL.
6. Publication scheduling is underspecified. Publishing without a date should
   stamp one authority-side; unpublishing should not accidentally preserve a
   misleading effective date; future publication must surface as Scheduled,
   not Published.
7. `publishedOnly` is a public query parameter but is ignored and cannot safely
   expose drafts. Remove it rather than preserving a false control.

## P1/P2 workflow defects

- Page content has no recoverable revision history. Add immutable revisions for
  meaningful saves after CAS is established; history is not a substitute for
  optimistic concurrency.
- List rows need semantic title links, Scheduled/Published/Draft truth, preview
  behavior for public versus draft state, and URL-backed status filters.
- Bulk publish/unpublish/restore/trash/permanent delete must use the shared
  impact-confirmation grammar and exact permission gates. Permanent deletion is
  trash-only and typed confirmation is appropriate.
- `sortOrder` claims navigation behavior but Pages do not own navigation. Remove
  it from the merchant form unless a current consumer proves that contract;
  navigation builders should reference pages explicitly and own their order.
- The editor should use the successful product form pattern: compact two-column
  desktop surface, content as the primary work area, a visible status/readiness
  card, Search and discovery in the right rail, sticky save/dirty/conflict
  state, and no nested card padding that creates empty space.
- Preview must distinguish Live page from Draft preview. Do not generate a
  public-looking link for a draft that buyers cannot resolve.

## Accepted implementation model

- Add positive monotonic `version`; every editor save carries
  `expectedVersion`, advances once, and returns the committed record/version.
- Create as Draft. A shared publish-readiness service validates title, usable
  slug, non-empty meaningful content, reserved-route exclusion, discovery
  fields, featured image shape, and scheduling before any publish transition.
- Lifecycle commands are explicit, bounded to 90 IDs, state-conditioned, and
  conflict-aware. Permanent delete is trash-only.
- Slug authority is canonical and global across active/trash. Restore conflicts
  name the conflicting route and recovery action.
- Add immutable page revision rows only after CAS: content-bearing saves record
  the prior committed snapshot, actor reference when available, timestamp, and
  a bounded restore command that itself uses current-version CAS.
- Public page responses expose only buyer-relevant fields; admin-only lifecycle
  and audit fields stay out of public list/detail contracts.

## Verification bar

- Concurrent editor save, publish/unpublish/schedule, trash/restore/permanent
  delete races, reserved routes, slug restore collisions, and 90/91-ID bounds.
- Draft-first create and publish-readiness UI with permission-disabled controls,
  dirty-state navigation protection, retryable loader errors, and mobile layout.
- Public 404 versus 503, canonical/noindex/sitemap truth, shortcode failure
  fallback, featured-media safety, cache invalidation for old/new slugs, and
  live sitemap/page rendering after deployment.
