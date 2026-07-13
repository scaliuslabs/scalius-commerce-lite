# Navigation Authority and Large-Store Migration

Last reviewed: 2026-07-14

Status: normalized named menus/placements remain an accepted future design.
The demo-era typed-target bridge below is implemented in code but is not
deployed; existing demo header/footer JSON must be regenerated before deploy.

This document is the durable architecture decision for reusable navigation. It
is intentionally separate from the current builder UI: changing row density or
drag behavior cannot solve the present authority, concurrency, lifecycle, and
cache-freshness defects.

## Decision

Replace navigation arrays embedded in `site_settings.header_config` and
`site_settings.footer_config` with:

1. reusable named menus;
2. normalized draft items with typed targets;
3. immutable published revisions;
4. explicit, independently revisioned placements;
5. resource-lifecycle diagnostics and a reverse dependency index;
6. a small uncached placement manifest plus revision-keyed, paged public menu
   projections.

Header/footer branding, announcement, contact, social, and legal copy remain
presentation settings. They do not own menu content. Do not raise the current
150-item JSON limit as an interim "scale" fix.

The target authority supports up to 1,000 menus, 10,000 items per menu, and
three total levels (top level plus two nested levels). A placement may declare a
lower rendering limit, but it must never silently truncate a published menu.
Search, editing, and public projection are paged; no admin or storefront request
loads every menu in the store.

### Accepted demo-era bridge

If stable resource links must ship before the normalized authority in this
document, the only accepted bridge is a single typed target inside each current
JSON item. It is a cutover, not a compatibility layer:

- `resource` target: `resourceType`, stable `resourceId`, and an optional safe
  query projection;
- `internal_path`, `external_url`, or `label` target: one validated value;
- `labelMode: resource | custom`, with optional `customLabel` and diagnostic-only
  `lastKnownLabel`.

Do not keep copied `href` as a second mutable authority. Regenerate the demo
menus, resolve resource targets centrally in batches of at most 90 IDs, and use
the same resolver for admin preview, header, footer, and layout reads. Resource
mode follows the current title and route; custom mode preserves merchant copy.
An unavailable leaf is omitted publicly, while an unavailable parent with ready
children becomes a label group. `noIndex` and sitemap exclusion do not make a
target unavailable.

The bridge must add first-class product and collection pickers, resource-change
cache invalidation, and tests for rename, slug/canonical change, custom label,
draft/internal, trash/delete/restore, parent fallback, and slug reuse. Until page
canonical aliases are routed, a page resource resolves only to its live
`/<slug>` route. This bridge may be wiped with the rest of the demo data when
the normalized menu tables replace it; it must never become permanent dual
authority.

### Bridge implementation and regeneration gate

The interim JSON item now persists exactly one `target` union plus
`labelMode`, optional `customLabel`, and diagnostic-only `lastKnownLabel`.
Admin resolution adds a transient `resolution` projection that is removed on
save. Persisted `title`/`href` rows are deliberately rejected; no runtime
legacy converter or copied fallback authority exists.

One core resolver serves admin preview, public navigation, header, footer, and
consolidated layout reads. It deduplicates resource IDs, reads each resource
kind in awaited chunks of at most 90, and resolves current title, route, and
lifecycle readiness. Public projection omits unavailable leaves and turns an
unavailable parent with ready descendants into a label group. `noIndex` and
sitemap/feed exclusion never participate in menu readiness. Pages intentionally
resolve to `/<slug>` until page canonical aliases are routed.

Product and collection pickers are first-class alongside page and category.
Filtered category links persist the stable category ID plus a validated query
projection. Product and collection writes invalidate layout/navigation as well
as their catalog caches.

Before deployment, regenerate `site_settings.header_config` and
`site_settings.footer_config` so every navigation/link item uses the typed
shape. A copied `{ id, title, href }` row must be replaced, not upgraded at
runtime. This is a demo-data requirement, not a schema migration; this
implementation performs no production write or deployment.

## Verified benchmark, not visual imitation

- Shopify's current Help Center documents reusable menus, a maximum of 10,000
  items per menu, 1,000 menus per store, and top-level plus two nested levels.
  It also notes that deleting a linked product, collection, or page can remove
  the menu item. Scalius should match the scale but improve the destructive
  behavior by preserving the item and surfacing a repairable diagnostic.
  <https://help.shopify.com/en/manual/online-store/menus-and-links/drop-down-menus>
- Shopify's current Admin GraphQL model separates a named `Menu` (ID, handle,
  title, default status) from typed `MenuItem` records (type, resource ID, URL,
  nested items). Menu creation supports products, collections, pages, catalogs,
  and custom URLs. This is evidence for named reusable authority and typed
  targets, not a reason to copy its API wholesale.
  <https://shopify.dev/docs/api/admin-graphql/latest/objects/menu>
  <https://shopify.dev/docs/api/admin-graphql/latest/objects/menuitem>
  <https://shopify.dev/docs/api/admin-graphql/latest/mutations/menucreate>
- Current WordPress navigation is also a reusable named resource that can be
  selected by a Navigation block. Its editor supports resource search, custom
  links, nested structure, direct reorder, explicit move controls, and open in
  new tab. WordPress exposes draft/publish states, autosaves, and paginated
  navigation revisions through its REST API.
  <https://wordpress.org/documentation/article/navigation-block/>
  <https://developer.wordpress.org/rest-api/reference/wp_navigations/>
  <https://developer.wordpress.org/rest-api/reference/wp_navigation-revisions/>
- Classic WordPress also keeps a menu separate from the theme location that
  renders it. That separation is still the useful formula for Scalius placements.
  <https://developer.wordpress.org/reference/functions/wp_nav_menu/>
- Cloudflare D1 limits a string, BLOB, or table row to 2,000,000 bytes and a
  bound statement to 100 parameters. A single 10,000-item JSON document is
  therefore the wrong authority and public cache shape even if SQLite accepts
  it in a small demo.
  <https://developers.cloudflare.com/d1/platform/limits/>

## Current code-backed defects

The following are current facts, not speculative future concerns.

1. `packages/database/src/schema/system.ts` stores header and footer as opaque,
   required JSON strings on the `site_settings` singleton. Navigation content,
   branding, contact, social, and footer presentation share the same overwrite
   boundary.
2. `packages/core/src/modules/navigation/navigation.service.ts` and
   `packages/core/src/modules/settings/site-settings.service.ts` expose separate
   save paths for the same two columns. The corresponding API surfaces are
   `/admin/navigation` and `/admin/settings/header|footer`. Neither write
   requires a revision. Two tabs or two surfaces can silently overwrite each
   other.
3. `site_settings.updated_at` is second-granularity metadata, not a CAS token.
   It cannot distinguish concurrent editors and is not required by any
   navigation mutation.
4. `navigation.validation.ts` limits the combined embedded structure to 150
   nodes and three levels. It has no menu identity, handle, draft/published
   state, placement, typed resource target, or revision history.
5. Items copy `href` strings. `filterNavigationByPublishedCategories()` can
   recognize only exact category slug paths. Page, collection, and product
   visibility/deletion/slug/canonical changes have no dependency authority. The
   same filtering is also applied to the admin configuration read, so an
   unpublished category link can disappear from the repair surface even though
   it remains stored in the JSON.
6. Public readers disagree:
   - `/navigation` uses the navigation service and one-hour request caching;
   - `/header` and `/footer` parse raw JSON independently;
   - consolidated storefront layout parses and shapes the JSON again;
   - only some paths filter unpublished categories.
   The public `/navigation/{id}` OpenAPI item shape (`label`, `url`,
   `sortOrder`) also does not match the service's current nested
   `title`/`href` return shape.
7. Admin source loading and fallback generation read all published categories
   and pages without pagination. Collections and products are not first-class
   sources. The layout service can synthesize one unbounded Categories subtree.
8. The layout service still calls `nanoid()` while normalizing a footer menu
   without an ID. Public identity can therefore change between otherwise
   identical reads.
9. Category and page admin mutations currently include layout invalidation,
   but collection and product mutations do not. That is consistent only with
   today's copied links and becomes wrong as soon as those resources are typed
   targets.
10. The cache layer invalidates broad `api:navigation:`/layout prefixes after a
    settings save. It has no per-menu published revision or resource dependency
    generation, so a purge is the only freshness mechanism.

## Authority model

Names below are conceptual Drizzle/SQL names. The migration may adjust names,
but it must preserve these boundaries and invariants.

### `navigation_menus`

| Column | Contract |
| --- | --- |
| `id` | Stable `menu_*` primary key. |
| `name` | Merchant-facing name, 1-100 characters. |
| `handle` | Stable normalized handle; unique across non-deleted menus by `lower(trim(handle))`. |
| `revision` | Positive CAS revision for every draft mutation, publish, restore, or rollback. |
| `published_revision` | Nullable revision identifying the current immutable publication. |
| `dependency_revision` | Positive generation bumped when a published typed target changes buyer URL/readiness. |
| `created_at`, `updated_at`, `deleted_at` | Lifecycle metadata. |

Rules:

- Menu name and handle are content, not placement identity.
- Every mutating command requires `expectedRevision` and advances `revision`
  exactly once in the same D1 transaction as its item/menu change.
- Publishing also advances `revision`, writes an immutable snapshot at the new
  revision, and points `published_revision` to it atomically.
- A menu assigned to any enabled placement cannot be trashed or hard-deleted.
- Hard delete is permitted only for an unplaced, already-trashed menu with no
  required audit retention. Publications may be retained as audit rows or
  removed with the menu according to the release retention policy.

Indexes: normalized active handle unique index, `(deleted_at, updated_at, id)`,
and `(published_revision, dependency_revision)`.

### `navigation_menu_items` (mutable draft)

| Column | Contract |
| --- | --- |
| `id`, `menu_id` | Stable item identity and owning menu. |
| `parent_id` | Nullable same-menu parent. Maximum depth is three. |
| `position` | Sparse signed 64-bit sibling position; order by `position, id`. |
| `label`, `label_mode` | Merchant label and `custom | resource` behavior. Resource mode follows the current resource title; custom remains stable on rename. |
| `target_type` | `label | system | page | category | collection | product | internal_path | external_url`. |
| `target_id` | Required only for typed resource targets. Kept after resource deletion for repair diagnostics. |
| `target_value` | Required only for a system route or custom path/URL. |
| `open_in_new_tab` | Explicit presentation choice; never inferred from target text. |
| `is_enabled` | Draft inclusion control without deleting the item. |
| timestamps | Audit and deterministic change display. |

Use a composite same-menu parent foreign key where D1/Drizzle support is proven;
otherwise enforce same-menu parent and cycle checks in the transactional service
and retain a database `id != parent_id` check. Parent deletion deletes the draft
subtree only after explicit subtree confirmation.

`position` values start with gaps (for example 1024). A move writes one row when
a midpoint exists and compacts only that sibling set when a gap is exhausted.
Never renumber an entire 10,000-item menu for a one-row move.

The polymorphic `target_id` intentionally does not use a fake cross-table
foreign key. `ON DELETE CASCADE` would destroy merchant intent, while `SET NULL`
would erase which resource needs repair. Publication validation and lifecycle
diagnostics are the integrity boundary.

Indexes: `(menu_id, parent_id, position, id)`, `(menu_id, target_type,
target_id)`, and `(target_type, target_id, menu_id)`. Add a
`navigation_menu_items_fts` index over label plus safe target-search text, with
the same insert/update/delete trigger pattern already used by repository FTS
tables. Search returns matches plus their at-most-two ancestors.

### Immutable publications

`navigation_menu_publications` stores `(menu_id, revision, published_at,
published_by, item_count, checksum)`. `navigation_menu_publication_items` copies
the normalized draft rows under `(menu_id, revision, item_id)` and has indexes
for both parent paging and reverse resource lookup.

Do not serialize the whole publication into one JSON row: D1's 2 MB row limit
and the 10,000-item target make that unsafe. Publishing may use one bounded
`INSERT ... SELECT` per table inside the same transaction/batch, followed by the
menu CAS update. Measure the 10,000-row publish against D1's 30-second query
limit before release; if it does not meet the budget, copy deterministic chunks
behind a short-lived publish job while the previous publication remains live.
Never expose a partially copied publication.

A rollback is a new linear revision: copy the selected immutable publication
into the draft, advance CAS once, validate, write a new publication, and point
`published_revision` to the new revision. Do not move a pointer backward and
make history ambiguous.

### `navigation_placements`

| Column | Contract |
| --- | --- |
| `id` | Stable placement ID. |
| `surface`, `slot` | Code/theme-declared location such as `header.primary`, `header.utility`, `footer.column`, `footer.legal`, `account.primary`, or a registered `theme.<theme-id>.<slot>`. |
| `position` | Order for repeatable slots such as footer columns. |
| `menu_id` | Reusable menu reference. |
| `label_override` | Optional surface heading; it does not rename the menu. |
| `is_enabled` | Public placement state. |
| `revision` | Independent positive CAS revision. |
| timestamps | Audit metadata. |

Unique active `(surface, slot, position)` prevents two menus claiming the same
location. A placement can reference only a non-deleted menu with a valid
publication. Placement definitions live in a small code/theme registry that
declares depth, supported interaction, and recommended root-item/render budgets;
merchants cannot invent a slot the storefront never renders.

The same menu may be placed more than once. Header/footer presentation saves do
not rewrite menu rows, and menu edits do not overwrite logos, contact, social,
or legal copy.

## Resource resolution and diagnostics

Typed resources resolve through their existing public-route/canonical helpers,
not hand-built slugs:

| Target | Ready when |
| --- | --- |
| Page | not trashed and published; URL honors its valid canonical path. |
| Category | not trashed and `published`; draft/internal are not buyer links. |
| Collection | not trashed and active; URL honors its ID-shaped route/canonical policy. |
| Product | not trashed and active; URL honors its valid canonical path. |
| System | key exists in the route registry and is enabled for the storefront. |
| Internal path | shared navigation path parser accepts it; unknown route remains an explicit unverified warning. |
| External URL | credential-free absolute HTTPS URL. |
| Label | no URL; valid only as an accessible group/control label. |

`noIndex` and sitemap/feed exclusions do not make a buyer page unavailable and
must not create a broken-link diagnostic.

Admin reads derive, rather than persist as authority, one of:

- `ready`;
- `menu_unpublished`;
- `resource_draft_or_internal`;
- `resource_trashed`;
- `resource_missing`;
- `system_route_disabled`;
- `invalid_custom_target`;
- `unverified_internal_path`;
- `surface_depth_or_budget_warning`.

Publishing blocks missing/non-public typed targets, invalid URLs, cycles,
duplicate IDs, depth/count violations, and unsupported placements. A target that
becomes unavailable after publication is not deleted from the menu. Public
resolution omits an unavailable leaf; if it owns otherwise ready descendants,
it becomes a non-link group label so the descendants are not stranded. The
admin shows the affected menu, placements, item path, reason, and repair action.
Restoring the same resource ID repairs it automatically.

Resource title, slug/canonical path, public status, trash/restore, and hard
delete mutations must bump `navigation_menus.dependency_revision` for every
currently published snapshot that references the affected `(target_type,
target_id)`. Prefer small D1 `AFTER UPDATE OF ...` and `AFTER DELETE` triggers
whose bodies contain one indexed `UPDATE ... WHERE id IN (SELECT ...)` statement.
This makes dependency generation part of the same durable resource transaction
and prevents a new write path from forgetting it. Follow the repository D1 rule:
guards belong in trigger `WHEN` clauses and bodies stay to one statement.

Draft diagnostics need no generation bump because they resolve against current
resource state on read.

## Admin API and scale contract

Replace whole-document writes with resource and command endpoints. Exact paths
may change during OpenAPI review, but the behaviors must not.

```text
GET    /admin/navigation/menus?q=&status=&placement=&cursor=&limit=
POST   /admin/navigation/menus
GET    /admin/navigation/menus/:menuId
PATCH  /admin/navigation/menus/:menuId                 expectedRevision
DELETE /admin/navigation/menus/:menuId                 expectedRevision

GET    /admin/navigation/menus/:menuId/items?parentId=&cursor=&limit=
GET    /admin/navigation/menus/:menuId/search?q=&cursor=&limit=
POST   /admin/navigation/menus/:menuId/items           expectedRevision
PATCH  /admin/navigation/menus/:menuId/items/:itemId   expectedRevision
POST   /admin/navigation/menus/:menuId/items/:itemId/move expectedRevision
DELETE /admin/navigation/menus/:menuId/items/:itemId   expectedRevision
POST   /admin/navigation/menus/:menuId/publish         expectedRevision
POST   /admin/navigation/menus/:menuId/rollback        expectedRevision + sourceRevision

GET    /admin/navigation/resources?type=&q=&cursor=&limit=
GET    /admin/navigation/placements
PUT    /admin/navigation/placements/:placementId      expectedRevision
```

- Menu lists and resource pickers use keyset cursors, not offset pagination.
- Item browsing is parent-paged (default 50, maximum 100). Search uses FTS and
  returns ancestor context plus `childCount`; it never returns the full tree.
- Reorder/move addresses stable IDs and a destination parent/before/after ID.
  The service calculates positions; clients never submit arbitrary full trees.
- Bulk add/import is chunked and idempotent under an explicit import operation
  ID. It is not an oversized `PUT` with 10,000 nodes.
- Every 409 includes current menu/placement revision and a human-safe conflict
  message. The browser preserves the merchant draft.
- RBAC separates view, edit draft, publish/rollback, placement, and permanent
  delete. A user who may edit a label is not automatically allowed to publish
  it globally.
- Remove the duplicate header/footer navigation write routes after cutover.
  OpenAPI must expose one canonical contract and generated SDK surface.

## Public/storefront projection and cache freshness

The current consolidated layout array cannot remain the only navigation
transport at large-store scale.

### Placement manifest

`GET /api/v1/navigation/placements` returns only enabled placements joined to
their menu's `publishedRevision`, `dependencyRevision`, root count, and surface
metadata. It is a small authoritative D1 read with `Cache-Control: no-store`.
It never resolves all menu items.

### Paged menu projection

```text
GET /api/v1/navigation/menus/:menuId
  ?publishedRevision=<n>
  &dependencyRevision=<n>
  &parentId=<root-or-item>
  &cursor=<position,id>
  &limit=<1..100>
```

The resolver reads the matching immutable publication page, joins/looks up only
that page's typed targets, applies current buyer visibility and canonical URL
rules, and returns resolved items plus child counts. Resource lookups must honor
the repository's 100-bound-parameter and six-connection rules: one target type
at a time, ID chunks of 90 or fewer, in sequential/bounded waves.

The response cache key contains menu ID, published revision, dependency
revision, parent, cursor, and limit, for example:

```text
api:navigation:v2:<menu>:<published>:<dependency>:<parent>:<cursor>:<limit>
storefront_navigation_<menu>_<published>_<dependency>_<parent>_<cursor>
```

Those pages may be cached long-term because a publication or resource lifecycle
change creates a new key. The uncached manifest is the pointer to current keys;
do not list/delete old generation keys on the hot write path. Let TTL/retention
remove them.

The storefront server-renders the placement's root page and progressively loads
large child pages when a buyer opens them. Small menus may be fully assembled
server-side within a tested render budget. A theme must show an explicit
readiness warning, not silently truncate, when its renderer cannot expose all
items. Keep an accessible non-JavaScript menu-directory fallback for a placement
that uses lazy expansion.

During migration, HTML/layout cache invalidation still includes a dedicated
`navigation` group and the existing `layout` group. Menu publish/rollback,
placement changes, and resource dependency bumps must:

1. bump API cache fences for legacy and v2 navigation namespaces;
2. schedule storefront `storefront_navigation_`, `global_navigation_`, and
   layout prefix purges/version bump;
3. warm the header/footer routes actually enabled by placements.

The no-store manifest and revision-keyed pages are the correctness backstop if
a broad purge is delayed: hydrated navigation fetches the current manifest and
cannot keep requesting an obsolete generation. Do not cache a resolved URL
under only `menuId` or only `publishedRevision`; resource changes require
`dependencyRevision` too.

## Incremental migration and rollback

No migration should be generated until schema, trigger, 10,000-row publish, and
cache tests are approved.

### Phase 0: additive schema

- Add the five authority tables, indexes/FTS, dependency triggers, and feature
  gates `navigation_v2_admin` and `navigation_v2_public`, both off.
- Leave legacy JSON and routes unchanged.
- Add read-only validators and a migration report; do not dual-write.

Rollback: drop/ignore empty v2 tables. Public behavior is unchanged.

### Phase 1: deterministic demo backfill and shadow reads

- Convert `headerConfig.navigation` into `Main menu` / `main-menu`.
- Convert each `footerConfig.menus[]` column into one named footer menu and one
  ordered footer placement.
- Preserve valid stable IDs. Replace missing/duplicate IDs with deterministic
  IDs derived from placement plus ancestry plus position, never browser-random
  IDs.
- Resolve exact current page/category/collection/product routes into typed
  targets. Keep other accepted paths/HTTPS URLs as custom targets. Report and
  omit unsafe values instead of coercing them.
- Create one immutable publication for every placed menu. Shadow-compare the v2
  resolver with the legacy output without serving v2 to buyers.
- Keep legacy JSON byte-for-byte as the rollback snapshot.

Rollback: clear v2 demo tables and continue serving JSON.

### Phase 2: canonical admin, legacy public

- Enable the v2 menu/placement admin and freeze legacy menu write endpoints with
  an explicit conflict response. Header/footer presentation remains editable
  but strips navigation fields from its mutation contract.
- Do not dual-write v2 changes into opaque JSON. If rollback is required, run an
  explicit exporter from current published v2 menus to legacy demo JSON, or
  accept loss of post-cutover demo navigation changes.

Rollback: disable v2 admin and restore/export legacy JSON before allowing legacy
writes again.

### Phase 3: public cutover

- Enable the placement manifest and revision-keyed projection.
- Switch storefront header/footer/account/theme placement consumers.
- Keep legacy `/navigation`, `/header`, `/footer`, and layout fields for one
  short soak window only; compare output and cache generations in production
  smokes.

Rollback: turn off `navigation_v2_public`; legacy JSON is still present. No
schema rollback is required.

### Phase 4: remove the split authority

- Remove legacy menu arrays from header/footer API schemas, public layout, and
  duplicated services/routes.
- Strip `navigation` and `menus` keys from the two presentation JSON documents.
- Remove public-read random ID generation, fallback auto-expansion, and legacy
  navigation caches.
- Keep no indefinite compatibility branch. After the stable release, removing
  the old columns entirely is a separate presentation-settings migration.

Rollback after this phase uses a tested v2-to-legacy export or D1 Time Travel;
do not attempt ad-hoc reverse SQL in production.

## Demo data that may be wiped

The owner has confirmed deployed catalog and configuration data are demos. It is
safe to wipe and deterministically regenerate:

- all current `headerConfig.navigation` arrays;
- all `footerConfig.menus` arrays and unstable/missing menu/item IDs;
- auto-generated category/page fallback menus;
- all v2 menu, item, publication, and placement rows during pre-release schema
  iteration;
- legacy navigation KV/Cache API entries.

Do not wipe unrelated presentation/business data merely because navigation is
changing: logo, favicon, announcement/contact/social data, footer legal copy,
theme, media, pages, categories, collections, and products should be retained
or regenerated by their owning demo plan. The migration report must list every
omitted unsafe or unresolved link so demo repair is intentional.

## Verification gate

Before enabling v2 public reads, prove all of the following with focused tests
and a deployed smoke:

- 1,000-menu list remains cursor-paged; a 10,000-item menu can be searched,
  edited, moved, published, resolved, and rolled back within documented D1/CPU
  budgets without a row over 2 MB or a statement over 100 bindings.
- Two editors using the same expected revision: exactly one succeeds and one
  receives a 409 while preserving its draft.
- Concurrent publish/edit, placement/menu delete, duplicate handles/positions,
  cross-menu parents, cycles, three-level overflow, subtree delete, restore,
  and import retry.
- Page/category/collection/product rename, canonical change, public/internal/
  draft change, trash, restore, and hard delete atomically bump the referenced
  published menu dependency generation.
- Unavailable leaves disappear; unavailable parents with ready descendants
  become label groups; diagnostics identify the exact item and placement.
- Menu publish, placement mutation, and dependency changes produce new public
  cache keys. A deliberately failed/delayed broad purge still converges through
  the no-store manifest and never serves the obsolete link after hydration.
- Header, footer, account, and registered theme placements render all supported
  items on desktop, mobile, keyboard, touch, screen reader, slow network, and
  JavaScript-disabled fallback paths.
- Admin/resource pickers never issue unbounded reads; search returns ancestor
  context; no full 10,000-node form/tree mounts.
- Legacy/v2 shadow comparison is clean for the regenerated demo before the old
  authority is removed.

## Explicit non-decisions

- Do not add localization/market overrides to the first schema. The publication
  model can add a translation table later without changing item identity.
- Do not make navigation a generic page-builder/block document. Menus are a
  small commerce resource with stricter target and cache semantics.
- Do not use Durable Objects for editing. D1 CAS plus immutable publications are
  sufficient.
- Do not auto-delete items when a linked resource is deleted.
- Do not resolve all 1,000 menus in the consolidated storefront layout.
- Do not keep two mutable authorities through permanent dual-write.
