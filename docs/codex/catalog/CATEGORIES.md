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

Category visibility is one explicit enum: `draft | published | internal`.
Creation is always draft. Only published categories own buyer-facing category
authority: public lookup/list/tree, category filters, saved/default navigation,
category sitemap/discovery, feed/UCP category metadata, and dynamic collection
membership. Draft and internal categories remain available to admin workflows.

A buyer-resolvable product does not become private merely because its assigned
category is draft/internal. General product reads and explicit/manual collection
membership still return the product, but public category ID and metadata are
set to null. This prevents an unpublished category from leaking while preserving
the independent product publication decision.

Publishing requires at least one active assigned product with a buyer-resolvable
SKU. Image, description, and meta description are readiness warnings rather
than blockers. An active dynamic collection may reference only published
categories; the error distinguishes missing categories from categories that
must be published.

## Resolved in the 2026-07-12 hardening slice

- Migration `0016` adds the checked publication enum and monotonic `revision`.
  Existing demo categories migrate to published; all new rows default to draft.
- Every edit, status call, trash, restore, and hard-delete claim carries the
  expected revision. Successful non-delete mutations advance it exactly once;
  hard delete removes the claimed row. Bulk claims are capped at 90. Soft trash
  uses one `UPDATE … RETURNING` whose global predicates require every claimed
  revision/state, product-assignment guard, and active-collection guard to pass,
  so D1 cannot apply a partial selection or fail through parameterized guard
  statements. Trash and restore force draft.
- The admin list exposes status and readiness. The edit sidebar explains each
  state, shows blockers/warnings, and exposes the storefront link only when
  published. Collection pickers accept only published categories for new
  dynamic membership and explain stale unpublished selections.
- Public products assigned to draft/internal categories stay buyer-resolvable
  in general and manual reads with `categoryId`/metadata omitted. Category
  filters and category-backed dynamic membership reject them.
- Saved nested navigation is recursively filtered against published slugs;
  category public APIs, attribute scopes, search, feeds, UCP, collections, and
  storefront layout all share the same publication predicate.
- Moving a category to draft/internal or trash is transactionally blocked while
  an active dynamic collection references it. The merchant must remove the
  reference or deactivate the collection first, so collection validity cannot
  be broken from the category editor.

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
- The production 12-of-14 bulk-trash failure was traced to the remaining
  multi-statement D1 guard path: all 12 live revision claims matched and had
  zero product or active-collection references, yet the guard batch returned an
  opaque 500 before any row changed. The single atomic soft-trash statement now
  returns every affected ID; a zero/partial result is diagnosed into typed
  revision/state, collection, assigned-product, or retry conflicts while
  leaving the complete selection active.

## Live cache finding

Authenticated Chrome inspection found the deployed Shoes category displaying a
0–0 price range while its five cards showed prices from 1,200 to 5,000. The
public API returned the authoritative `{ min: 1200, max: 5000 }` range and the
storefront HTML response was a cache bypass. The stale value therefore came
from the category product data cache. The category-only cache namespace is now
`category_products_v2_`; unrelated product fetches and the protected product
page are unchanged.

## Remaining prioritized gaps

1. **P2 — scale:** public category navigation/sitemap reads are unpaginated and
   admin form options load every active category. Introduce a cursor/search
   projection without breaking sitemap completeness.
2. **P2 — hierarchy:** evaluate parent/rank without overloading slug or
   collection order. Parent visibility must never make a child implicitly
   public.
3. **P2 — shared form capability:** `FormContainer` has no category-specific
   `canSave` boundary, so direct unauthorized create/edit routes rely on API
   denial. Add a generic permission-aware save contract in its own shared UI
   slice.

## Verification contract

- Focused tests cover publication readiness, revision conflicts, request and
  D1 claim bounds, exact revision payloads, trash-only permanent deletion,
  assignment races, collection-source protection, recursive navigation
  filtering, and a real SQLite public-product boundary proving unpublished
  category metadata is omitted without hiding explicit products.
- Run core/API/admin/storefront affected typechecks and lints, regenerate the SDK
  after category OpenAPI changes, and run API/admin/storefront production builds.
- After deploy, verify active list/create/edit/trash at desktop and 390×844,
  category empty/filter/sort states, API price range versus hydrated controls,
  sitemap inclusion policy, and old/new slug cache invalidation.
