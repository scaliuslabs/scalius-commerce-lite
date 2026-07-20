# CMS Pages Audit and Decisions

Last reviewed: 2026-07-20

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
- New pages default to Draft, and create/edit services reject publication or
  scheduling changes unless the API supplies verified `pages.publish`
  authority. Repeating an unchanged status does not block content edits.

## Closed lifecycle authority defects (2026-07-13)

- Pages now have a positive monotonic `revision`; every edit, trash, restore,
  publish, and unpublish command carries the expected revision and advances it
  exactly once. Multi-page commands are bounded to 90 unique claims and use an
  atomic D1 batch guard across revision plus active/trash state.
- Permanent deletion is trash-only. Trash and restore force Draft and clear
  `publishedAt`; publishing stamps the timestamp authority-side when absent.
- Page slug authority is global across active and trash, and both API and admin
  form validation reject reserved storefront roots.
- The edit loader redirects only on an authoritative API 404. Permission,
  timeout, and upstream failures remain on the route error boundary with Retry.
- Migration `0021` is additive so existing rows and page FTS triggers survive.

## Closed lifecycle and workflow defects (2026-07-19)

- Public list reads are unconditionally buyer-resolvable. The ignored
  `publishedOnly` query parameter was removed from the API contract, generated
  client, storefront client, and page sitemap call site; callers cannot request
  draft or future-scheduled content through the public surface.
- The admin list now has URL-backed Draft, Scheduled, and Live filters, semantic
  title links, truthful lifecycle badges, and an external storefront link only
  for pages buyers can currently resolve. Scheduled rows show their exact
  publication time.
- The editor exposes Draft, Publish now, and Schedule as one compact visibility
  control. It no longer invents a public preview for draft or scheduled pages,
  and discovery readiness treats future-scheduled pages as not yet public.
- Merchant-owned `sortOrder` was removed from forms, write contracts, list
  sorting, and API input. The legacy database column remains an internal
  compatibility value fixed at zero; Navigation owns menu order.
- List and bulk actions are permission-gated. Publish now deliberately replaces
  a future schedule, moving to draft clears the schedule, trash is recoverable,
  and both single and bulk permanent deletion require the shared confirmation
  boundary and remain trash-only.
- The list has a dedicated compact card renderer below the desktop table
  breakpoint. Theme surfaces use semantic tokens; production dark-mode checks
  resolved the page background and foreground to the dashboard's dark tokens.
- D1 Unix-second timestamps are normalized through `unixToDate`. This prevents
  future schedules from being mistaken for 1970-era live dates and lets an
  editor without publish authority preserve an unchanged committed timestamp.
- Production proof on 2026-07-19 created a future-scheduled page, observed a
  buyer 404, used bulk Publish now, observed the live page and canonical URL,
  moved it to trash, observed the buyer 404 again, and permanently removed the
  disposable page through the bulk confirmation flow. Draft and Live list
  filters also survived canonical URL reloads.

## Closed responsive editor defects (2026-07-20)

- The deployed editor already follows the compact product-form pattern: a
  two-column desktop workspace keeps content primary and publication,
  discovery, and page controls in the right rail; mobile collapses to one
  readable column without horizontal overflow. The older audit note claiming
  this conversion was still outstanding was stale and has been removed.
- The shared fixed form action bar used by Pages and other entity editors had
  only 32 px Discard and Save targets on mobile. Both shared and product form
  bars now provide 44 px mobile targets inside a 56 px bar while preserving
  the existing 32 px desktop density. Dirty/conflict text remains exposed to
  assistive technology on narrow screens and stays visibly rendered from the
  desktop breakpoint, so it cannot crowd the two critical mobile actions.
- Admin version `167ce913-9218-42f9-ac98-c56548adb31b` was verified at exact
  390 x 844 and 1440 px widths. The live About editor preserved its URL,
  enabled Save only for a real local change, returned to a clean state when
  the original title was restored, and did not save test data. The public
  `/about` page rendered its title, featured media, full content, header, and
  footer at 390 px with document and body widths exactly 390 px.

## Remaining P2 workflow defects

- Page content has no recoverable revision history. Add immutable revisions for
  meaningful saves after CAS is established; history is not a substitute for
  optimistic concurrency.

## Accepted implementation model

- Positive monotonic `revision`; every editor save carries
  `expectedRevision`, advances once, and returns the committed revision.
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
  dirty-state navigation protection, retryable loader errors, and real-device
  mobile layout proof. Exact 390 x 844 Chrome emulation passed on 2026-07-20;
  the remaining 320/360/430 px matrix stays part of the broader admin release
  audit.
- Public 404 versus 503, canonical/noindex/sitemap truth, shortcode failure
  fallback, featured-media safety, cache invalidation for old/new slugs, and
  live sitemap/page rendering after deployment.
