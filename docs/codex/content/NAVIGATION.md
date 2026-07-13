# Navigation, Header, and Footer Audit

Last reviewed: 2026-07-14

## 2026-07-14 scalable menu workspace

Header navigation and every footer column now use the same compact menu-map
workspace:

- A searchable, collapsible hierarchy is the orientation surface. Search checks
  labels and destinations while retaining matching ancestors, and explicit
  expand/collapse-all controls make wide trees navigable.
- Only the selected item exposes label and destination inputs. Its inspector
  shows the ancestor trail, level, sibling position, destination validation,
  safe preview, child count, add/remove, and native Earlier/Later/Make child/Up
  a level controls. Hundreds of simultaneous inputs no longer make the page
  visually or computationally heavy.
- All mutations address stable node IDs, not filtered row positions. Selecting,
  searching, reordering, indenting, or outdenting cannot accidentally update a
  different item because the visible result set changed.
- The tree remains bounded by the existing 150-node/three-level public contract.
  Collapsed branches and CSS content visibility bound normal rendering without
  adding a second virtualized-tree dependency for a maximum of 150 compact
  summary rows.
- Narrow screens use the same semantic tree and inspector rather than a second
  implementation. Selecting a mobile tree node moves focus context to the
  inspector; all arrangement actions are native buttons operable by keyboard
  and touch.
- Footer columns now use one horizontal/vertical column rail and one active
  editor. At most four columns exist, and native earlier/later controls replace
  drag-only column ordering. Accordion state and its unrelated local-storage
  persistence were removed.

Focused tests cover stable-ID mutations, ancestor-preserving search, depth and
count summaries, sibling moves, indent/outdent depth guards, responsive/shared
workspace boundaries, safe link preview, and footer single-editor behavior.

This is a UI/workflow hardening slice over the interim JSON authority. It does
not claim the accepted versioned reusable-menu model, typed resource references,
CAS conflicts, broken-resource diagnostics, publish lifecycle, or real
desktop/mobile storefront preview; those remain the architecture work below.

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
- At mobile admin widths, the shared menu map and selected-item inspector avoid
  squeezing a desktop table into 390 px. Native arrangement buttons mean touch
  and keyboard merchants are never required to drag.
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
- The interim JSON model enforces bounded labels, stable unique node IDs,
  three menu levels, 150 total nodes, four footer columns, and eight
  credential-free HTTPS social destinations per placement.

## P1 architecture defects

1. Header and footer remain opaque JSON blobs even though their interim
   validator now enforces depth, count, URL, label, identity, social, and
   structural bounds. The shape still cannot express reusable menus,
   placements, lifecycle, or per-resource dependency evidence.
2. No revision/CAS exists. Header, footer, General Settings, or two open editors
   can overwrite the same singleton without conflict. Each builder saves a
   complete blob rather than a scoped command.
3. Navigation items copy `href` strings instead of storing typed resource
   references. Page/category slug or visibility changes can leave dead menu
   links; dependency invalidation and deletion impact cannot be proven.
4. Default navigation expands every visible category/page in an unbounded read.
   Large catalogs can still create unusable markup even though the Categories
   parent is now a truthful non-clickable label.
5. Several implementations overlap: generic NavigationBuilder, header
   NavigationSection, footer menu editor, separate header/footer route shapes,
   and inline default builders. One canonical menu model/validator/resolver is
   required.
6. External-link presentation still needs an explicit merchant new-tab choice;
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
