# Navigation, Header, and Footer Audit

Last reviewed: 2026-07-19

## 2026-07-19 normalized authority cutover

Navigation is now a dedicated `/admin/navigation` workspace instead of a
header/footer settings array. Named menus have revision-guarded drafts,
immutable publications, rollback history, and independent Header/Footer
locations. Menu, panel, search, and item-dialog state are URL-addressable.

The storefront resolves the current published placements and typed resources
in one bounded projection. Invalid navigation is isolated: one corrupt or stale
placement is skipped without taking down header/footer presentation, checkout,
account, or the storefront homepage. Header and Footer settings accept only
presentation fields; embedded `navigation`/`menus` data and unknown keys are
stripped at the service boundary, and the obsolete compatibility write routes
have been removed.

The replacement outline never hides unrelated rows during drag. A row exposes
three deterministic pointer regions—25% before, 50% inside, 25% after—with
distinct line versus selected-row feedback. The dragged row itself moves at
40% opacity, collapsed targets expand after a 500 ms inside dwell, and exact
non-drag actions remain available for earlier/later/nest/outdent operations.

## 2026-07-19 concurrent-editor protection (implemented)

Header and footer presentation documents now have independent positive,
monotonic revisions in D1. Every settings save supplies the revision it was
edited from and uses one atomic compare-and-swap; a stale tab receives typed
`SITE_PRESENTATION_REVISION_CONFLICT` evidence and cannot replace the newer
document. Migration `0033_sour_proudstar.sql` initializes existing demo rows at
revision one and was applied against the real local D1 migration state before
deployment.

The admin keeps the merchant's draft when a conflict occurs. `Use latest`
adopts the newer saved document; `Merge mine` keeps locally changed scalar
leaves or ordered navigation/social arrays and adopts untouched fields from the
newer revision. A revision conflict disables another save until the merchant
chooses. The save snapshot is also fixed at request start, so edits made while
a request is in flight remain visibly dirty instead of being marked saved.

The older root `/admin/navigation` POST/PUT/DELETE compatibility endpoints have
been removed. No alternate API route can overwrite embedded header/footer menu
data.
The automatic fallback was audited at the same time: it is already bounded to
90 published categories plus 58 published pages, keeping Home and the
Categories group within the existing 150-node public contract.

Focused proof covers first-writer races, independent header/footer increments,
stale-write rejection without data loss, transport error decoding, leaf/array
draft rebasing, real admin conflict recovery, compatibility-route revision
requirements, and the existing tree interaction suite.

## Typed resource target cutover (implemented and deployed)

The interim header/footer JSON no longer treats copied URLs as resource
authority. Items persist one typed resource/internal/external/label target;
resource mode follows the live title and route while custom mode preserves the
merchant label. Products and collections are first-class picker sources, and
filtered category links store a stable category ID plus safe query parameters.

Admin preview and all public readers share one bounded resolver. It reads IDs
sequentially in D1-safe chunks of at most 90, omits unavailable leaves, keeps a
useful unavailable parent as a label group, and ignores `noIndex`/sitemap
exclusion when deciding buyer readiness. Page resources use the routed
`/<slug>` path; valid current canonical paths drive product, category, and
collection links.

The demo `header_config` and `footer_config` rows were regenerated into the
typed shape before deployment. Reads intentionally fail closed on old rows;
there is no permanent compatibility branch or second URL authority.

## 2026-07-17 destination-picker correction

The shared Add menu items dialog now opens the first Category/Page result set
immediately instead of briefly presenting a false empty state during the
initial debounce. A failed source request has a Retry action and cannot be
mistaken for a genuinely empty store. Product, Category, Page, and Collection
multi-selection all drive the same exact footer action (`Add N items`), while a
single Custom link, Label only, or Filtered category target keeps `Add item`.
The former `Dynamic` label is now `Filtered category`, which names the actual
buyer destination without exposing an implementation term. Source types no
longer use decorative rainbow text; hierarchy and selection state carry the
interface.

## 2026-07-14 interaction correction and large-menu behavior

### Deployed proof

Admin version `a5391efd-877e-4ee5-973c-d85505475750` serves commits
`e84d6ff5f`, `07bde164f`, and `d1474a1ed` at 100%. Live Chrome verification
proved:

- `/admin/settings?section=header&panel=navigation` and
  `?section=footer&panel=navigation` restore the correct nested workspace after
  refresh; switching Branding/Navigation updates the URL and Back/Forward
  restores the corresponding panel;
- a real pointer drag moved Footwear before Home & Living, kept all three menu
  rows in the rendered structure, and enabled the save boundary; Discard
  restored the original order, cleared the transient drop status, and did not
  write production settings;
- the same Footer > Navigation URL and selected panel survived a 390x844 mobile
  viewport; and
- the console had no errors. The sequential admin typecheck, 23 navigation
  interaction tests, 11 settings/route boundary tests, focused ESLint, deploy
  build, and `pnpm release:check` all passed.

The admin route-state and future global-search dependency are recorded in
[ADMIN-ROUTE-STATE.md](../ADMIN-ROUTE-STATE.md). The command-palette research
and prototype gate is recorded in
[GLOBAL-ADMIN-SEARCH.md](../GLOBAL-ADMIN-SEARCH.md).

The first 2026-07-14 workspace put a permanent menu map beside a selected-item
inspector. That made every edit a map-to-pane trip, compounded the header/footer
section rails, and was materially slower than the prior inline editor. It was
not retained merely because it was already implemented.

### Current-platform benchmark

- [WordPress Site Editor navigation](https://wordpress.org/documentation/article/site-editor-navigation/)
  separates menu browsing/basic reorder from Focus Mode for detailed editing.
  Its Navigation Block List View supports direct selection and drag nesting,
  while the [current Command Palette](https://wordpress.org/documentation/article/site-editor-command-palette/)
  provides fast access to complex editor structure and actions.
  [WordPress.com's April 2026 reorder guide](https://wordpress.com/support/menus/reorder-menu-items/)
  also preserves explicit move controls as an accessible alternative to drag.
- [Shopify's current menu editor guide](https://help.shopify.com/en/manual/online-store/menus-and-links/editing-menus)
  uses a simple ordered menu-item list, an explicit Edit action with Apply
  changes, direct drag ordering/nesting, contextual resource search, and a save
  boundary. Its [drop-down menu guide](https://help.shopify.com/en/manual/online-store/menus-and-links/drop-down-menus)
  documents two sub-levels and a much larger authority: up to 10,000 items per
  menu and 1,000 menus. That scale requires named menus and focused rendering,
  not a permanently mounted form or inspector for every node.
- [Squarespace's March 2026 navigation guide](https://support.squarespace.com/hc/en-us/articles/206543897-Moving-pages-around-your-navigation)
  keeps navigation in one compact Pages panel and uses direct manipulation for
  reorder, placement, and dropdown nesting. Page settings open only when needed.

The shared formula is a compact structure first, one local edit surface only
when requested, and no permanent half-width inspector. Scalius now follows that
formula without making drag the only way to arrange a menu:

- The hierarchy is one full-width, narrow-screen-safe list. Opening a row puts
  its label, destination, validation, preview, placement, and actions directly
  under that row; closing it returns to the compact list. Only one form is
  mounted at a time. A Focus action opens the same editor in a bounded
  full-viewport workspace when the surrounding Header/Footer section rails are
  too narrow; it is not a second editing implementation.
- Search checks labels and destinations and shows matching rows with their
  ancestors marked as parent context. Collapse/expand works outside search.
  Small menus initially expand for speed; large menus initially collapse so the
  first paint remains an orientation view rather than hundreds of rows.
- All mutations still address stable node IDs. Drag is the visually primary
  placement control. The deterministic Parent/Position and
  Earlier/Later/Make child/Up a level fallbacks remain keyboard/touch-safe
  behind one native `Placement options` disclosure, avoiding permanent control
  clutter while still preventing 98 repeated clicks across a long sibling
  list. Add child and Remove stay immediately visible.
- Every visible row now also has a 40 px drag handle. Dragging uses one
  sortable-tree projection instead of a hidden horizontal threshold: the
  pointer chooses a visible before/after insertion edge, horizontal movement
  continuously projects the destination level, and an indented insertion line
  previews the exact result. Cross-parent moves are therefore direct rather
  than rejected. The complete branch moves atomically, collapsed targets
  expand when needed, cycles remain impossible, and projected depth is clamped
  to the three-level public contract. The active inline editor follows its
  stable item ID after the move.
- Pointer and keyboard sensors share the same sortable context and dnd-kit live
  announcements/instructions. Arrow movement follows the same projected edge
  and level model. Drag never replaces the native placement fallbacks; it keeps
  them collapsed until needed. Search disables every handle with a concise
  explanation because arranging a filtered projection could move the wrong
  branch.
- Sortable rows deliberately do not use `content-visibility` or visual
  translation transforms. Both caused browser-specific disappearing/fading
  rows while dragging. All non-active rows now remain fully rendered, the
  source position becomes a clear dashed placeholder, and the moving branch is
  represented by the drag overlay plus insertion line.
- Resting UI is quiet: the card keeps only a short title/subtitle, arrangement
  guidance lives behind an accessible info tooltip, and the status strip mounts
  only for search lock, active drag feedback, or the brief post-drop result.
- The render projection is flattened in one traversal. At most 80 currently
  visible rows mount at once; merchants explicitly reveal the next batch.
  Search runs against the complete hierarchy, so a match beyond the first batch
  is still immediately discoverable. Focused proof uses a 240-item input and
  asserts an 80-row DOM boundary.
- The same inline list is used at desktop and mobile widths; no second mobile
  tree, nested table, or viewport-driven split pane can drift from it. Native
  buttons and inputs preserve keyboard and touch access.
- Footer columns retain one active column editor with native earlier/later
  controls. The menu within that column now uses the same corrected inline list.

The persisted/public validator still caps this interim JSON placement at 150
nodes and three levels. The UI is deliberately robust when reading a larger
legacy/future input, but it does not pretend a 240-node test can be saved through
today's 150-node API contract. Supporting genuinely larger stores without one
huge storefront menu requires the accepted reusable named-menu/placement model,
typed resource references, and a compact resolved public projection—not simply
raising a constant. The accepted authority, migration, cache, and rollback
design is recorded in [NAVIGATION-AUTHORITY.md](NAVIGATION-AUTHORITY.md).

This remains a UI/workflow slice over the interim JSON authority. Version/CAS,
normalized reverse dependencies, publish lifecycle,
undo/confirmation for subtree deletion, and a real desktop/mobile storefront
preview remain the architecture work below.

## 2026-07-13 bounded builder hardening

The current JSON authority remains in place for this release slice, but its
unsafe and confusing edges are now bounded while the accepted versioned-menu
model remains the architectural destination:

- Header and footer editors use a dense section rail, explicit dirty/saved
  status, discard, a sticky save action, and a browser-leave warning. Query
  revalidation cannot overwrite an active merchant draft.
- Client-side legacy migration no longer invents random menu or social IDs.
  Demo data must be repaired once instead of perpetuating nondeterministic
  compatibility branches in every browser session.
- Public menu configuration is limited to 150 nodes and three visible levels;
  IDs must be stable and unique, labels are bounded/non-blank, and footer
  layouts are limited to four focused columns. The admin builder mirrors these
  limits instead of allowing structures the desktop/mobile storefront cannot
  present well.
- Social destinations are limited to eight per placement and accept only
  credential-free HTTPS URLs. The editor exposes invalid destinations inline.
- Footer menu previews now resolve against the real storefront origin rather
  than opening a fake `#` URL.
- At mobile admin widths, the same inline list/editor avoids squeezing a desktop
  table into 390 px. Drag handles meet a 40 px touch target and native
  arrangement buttons mean touch and keyboard merchants are never required to
  drag.
- Copyright input is defined as the owner/business name. The storefront owns
  the current year and rights suffix exactly once, and no longer writes unused
  footer presentation data into `localStorage` on every page.

Focused proof: navigation validation covers unsafe links, HTTPS social rules,
depth/count/identity bounds, and duplicate footer columns; admin boundary tests
cover the three-level UI; storefront boundaries cover label-only nodes and the
single copyright/storage contract.

## Hero correctness slice completed

Hero management now uses an explicit dirty/save/discard workflow, a monotonic
revision/CAS write, preserved drafts on conflicts, bounded normalized slides,
the shared safe-link policy, and genuinely non-interactive unlinked storefront
slides. The editor was compacted only after those boundaries were established.
See [HERO.md](HERO.md). Existing hero demo assets may now be replaced through
the proven editor in a separate live demo-data run.

## Current strengths

- Header and footer builders already separate branding, announcement/contact,
  social, and navigation concerns and support nested drag/reorder interactions.
- Storefront data is D1-backed through the site-settings singleton and relevant
  saves invalidate layout/settings caches.
- Admin pickers can reference Pages and Categories and can preview a filtered
  category link against buyer-resolvable product truth.
- Page picker links use the actual public `/{slug}` route. Navigation targets
  share one authority that normalizes safe relative paths, root paths,
  fragments/queries, legacy `/pages/{slug}` values, and credential-free HTTPS
  URLs while rejecting unsafe schemes, protocol-relative URLs, traversal,
  whitespace/control characters, and backslashes.
- Stored header/footer JSON is validated on read and write. Malformed persisted
  settings fail explicitly instead of becoming an empty-success response, and
  label-only menu nodes render without fake `#` anchors.
- Header and footer recovery is isolated per section. Invalid persisted data
  locks only the affected builder and never exposes assumed defaults that could
  overwrite the saved document. Safely normalized legacy data remains editable
  but requires one explicit **Save typed format** action before it is treated as
  current. Other General Settings panels remain usable in both cases.
- The interim JSON model enforces bounded labels, stable unique node IDs,
  three menu levels, 150 total nodes, four footer columns, and eight
  credential-free HTTPS social destinations per placement.

## P1 architecture defects

1. Header and footer remain opaque JSON blobs even though their interim
   validator now enforces depth, count, URL, label, identity, social, and
   structural bounds. The shape still cannot express reusable menus,
   placements, lifecycle, or per-resource dependency evidence.
2. Typed resource targets now follow current route and lifecycle state, but the
   JSON bridge has no normalized reverse-dependency index. Impact queries and
   per-menu invalidation still require the accepted named-menu model.
3. Several implementations overlap: generic NavigationBuilder, header
   NavigationSection, footer menu editor, separate header/footer route shapes,
   and compatibility API routes. The mutation routes now share one CAS
   authority, but one canonical named-menu model/validator/resolver is still
   required.
4. External-link presentation still needs an explicit merchant new-tab choice;
   safe target validation and scheme blocking are now enforced.

## Merchant workflow direction

Use a compact WordPress-style two-pane menu builder without copying its visual
weight:

- left: searchable, server-paginated Pages, Categories, Collections, Products,
  and Custom link sources with add-selected actions;
- right: one dense hierarchical menu tree with direct label editing, drag,
  keyboard move/indent/outdent, enabled state, resource status, and broken-link
  diagnostics;
- a persistent preview/readiness rail for desktop/mobile header and footer
  placement, rather than separate editors that duplicate navigation logic;
- route-backed subsections and visible dirty/save/conflict state. Switching
  branding, announcement, contact, social, or menus must not lose drafts;
- reusable named menus referenced by Header/Footer placements. Branding and
  contact remain placement settings, not part of menu nodes.

## Accepted model

- Replace copied blobs with versioned navigation menus, ordered typed nodes, and
  explicit placements (`header-primary`, `footer-*`). Keep presentation settings
  versioned separately from menu content so independent saves do not conflict.
- Node target is one of resource reference, safe internal path, safe absolute
  HTTPS URL, or non-clickable label. Resolver emits current public URL and
  readiness; hidden/deleted/unpublished targets are blocked on publish and
  diagnosed after later lifecycle changes.
- Draft-first menu edits use expected version. Publish validates unique stable
  IDs, bounded node count/depth, labels, targets, cycles, placement constraints,
  and buyer visibility. Public reads receive a compact resolved projection.
- Remove runtime/client legacy migration after a one-time demo migration; no
  backward branch survives.
- Header/footer builders share the canonical menu component and media reference
  picker. They keep the current storefront look unless a separate theme design
  change is approved.

## Verification bar

- Concurrent edits, resource slug/visibility/delete changes, invalid URLs,
  missing targets, cycles, max depth/count, duplicate IDs, and restore.
- Keyboard-only build/reorder, mobile editing, dirty navigation guard, failed
  save draft preservation, live preview, and permission-disabled actions.
- Exact layout/navigation cache invalidation, bounded public resolution,
  accessible desktop/mobile menus, and old/new link freshness after deploy.
