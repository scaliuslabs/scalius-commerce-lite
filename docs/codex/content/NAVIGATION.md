# Navigation, Header, and Footer Audit

Last reviewed: 2026-07-12

## Current strengths

- Header and footer builders already separate branding, announcement/contact,
  social, and navigation concerns and support nested drag/reorder interactions.
- Storefront data is D1-backed through the site-settings singleton and relevant
  saves invalidate layout/settings caches.
- Admin pickers can reference Pages and Categories and can preview a filtered
  category link against buyer-resolvable product truth.

## P1 architecture defects

1. Header and footer are opaque JSON blobs with permissive record validation.
   The API does not enforce the UI's depth, item count, URL, label, ID, social,
   media, or structural rules.
2. No revision/CAS exists. Header, footer, General Settings, or two open editors
   can overwrite the same singleton without conflict. Each builder saves a
   complete blob rather than a scoped command.
3. Navigation items copy `href` strings instead of storing typed resource
   references. Page/category slug or visibility changes can leave dead menu
   links; dependency invalidation and deletion impact cannot be proven.
4. Client-side “migration” invents random IDs while loading older shapes. It can
   create nondeterministic dirty state and perpetuates formats the API should
   have removed through one schema migration.
5. Default navigation expands every visible category/page in an unbounded read
   and uses a `#` Categories parent. Large catalogs will create unusable markup,
   and placeholder links are poor keyboard/browser behavior.
6. Several implementations overlap: generic NavigationBuilder, header
   NavigationSection, footer menu editor, separate header/footer route shapes,
   and inline default builders. One canonical menu model/validator/resolver is
   required.
7. Custom URLs need explicit internal-route versus absolute HTTPS semantics.
   Reject script/data/protocol-relative URLs, credentials, unsafe characters,
   and silent off-store links; external links need explicit new-tab behavior.

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
