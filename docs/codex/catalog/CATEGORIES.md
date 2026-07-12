# Category authority and workflow audit

Last reviewed: 2026-07-12

This is the durable category-specific audit for the admin, API/core/database,
storefront listing, discovery, cache, and destructive lifecycle. Source, tests,
fresh runtime evidence, and deployed behavior remain authoritative.

## Current category role

Scalius categories currently do two jobs: they are the single product
classification (`products.category_id`) and they own a public
`/categories/<slug>` buyer listing. Collections remain the separate manual or
dynamic merchandising model. Do not add collection conditions to categories or
silently merge these domains.

The flat category model has no publication, internal/private, hierarchy, rank,
or redirect authority. Every non-trashed category is public and eligible for
navigation/sitemap reads. This is the largest remaining model gap:

- Shopify collections separate membership from channel publication and are
  unpublished by default; its list surfaces publication and rule truth.
- Medusa categories separate active storefront status from internal visibility
  and support parent/child ranking.

Adding only an `isActive` field would be incomplete. A category visibility
change must atomically align public category lookup, generic product category
filters, navigation, collections, sitemap/discovery, feeds/UCP, cache
invalidation, and admin readiness. Treat that as a dedicated schema release,
not a cosmetic status badge.

## Resolved in the 2026-07-12 hardening slice

- Permanent deletion is trash-only. A preflight gives a clear conflict and the
  final D1 delete is state-conditioned and row-count checked so a concurrent
  restore cannot hard-delete or rewrite collection membership.
- Product assignment is rechecked in the same D1 batch. Permanent cleanup
  covers active and trashed collection configs, rejects malformed membership,
  and blocks deletion when it would leave an active dynamic collection with no
  category source.
- Category update, trash, restore, and permanent deletion advance affected
  product aggregate revisions. Active edits cannot mutate trash.
- Slug authority is global across active and trashed rows. Preflight copy names
  the restore path, while database uniqueness races become typed conflicts.
- Single and bulk destructive actions share one impact confirmation. Trash
  selection follows restore/permanent-delete permissions, bulk restore is
  available, and trashed rows cannot navigate into edit.
- Admin list product counts include every non-trashed assigned product, matching
  deletion guards. The page uses an indexed correlated count rather than
  grouping the complete product table for every page.
- Admin list query enums, search length, pagination, IDs, and destructive arrays
  validate before D1. Delete and restore sets are capped at 90.
- Server and client form validation now agree on trimming, URL-handle shape,
  canonical equality, discovery copy bounds, image metadata, and empty-to-null
  copy. Save language follows the shared “Save changes” grammar.
- Filtered category URLs no longer emit base-category `CollectionPage` JSON-LD.
  Empty categories and empty filtered results give different recovery actions,
  and the sort script binds once across Astro navigation.

## Live cache finding

Authenticated Chrome inspection found the deployed Shoes category displaying a
0–0 price range while its five cards showed prices from 1,200 to 5,000. The
public API returned the authoritative `{ min: 1200, max: 5000 }` range and the
storefront HTML response was a cache bypass. The stale value therefore came
from the category product data cache. The category-only cache namespace is now
`category_products_v2_`; unrelated product fetches and the protected product
page are unchanged.

## Remaining prioritized gaps

1. **P1 — category visibility model:** design active versus internal/private
   semantics across every consumer named above, including draft-by-default
   creation and publish readiness.
2. **P1 — concurrent editing:** categories lack their own revision/CAS. Add it
   before multi-user editing is called conflict-safe.
3. **P2 — scale:** public category navigation/sitemap reads are unpaginated and
   admin form options load every active category. Introduce a cursor/search
   projection without breaking sitemap completeness.
4. **P2 — hierarchy:** evaluate parent/rank only after visibility semantics are
   explicit; do not overload slug or collection order.
5. **P2 — shared form capability:** `FormContainer` has no category-specific
   `canSave` boundary, so direct unauthorized create/edit routes rely on API
   denial. Add a generic permission-aware save contract in its own shared UI
   slice.

## Verification contract

- Focused tests cover validation normalization/bounds, request limits, D1 set
  bounds, trash-only permanent deletion, assignment races, collection-source
  protection, row-count projection, bulk confirmation/restore, trash edit
  routing, storefront cache namespace, and category listing accessibility.
- Run core/API/admin/storefront affected typechecks and lints, regenerate the SDK
  after category OpenAPI changes, and run API/admin/storefront production builds.
- After deploy, verify active list/create/edit/trash at desktop and 390×844,
  category empty/filter/sort states, API price range versus hydrated controls,
  sitemap inclusion policy, and old/new slug cache invalidation.
