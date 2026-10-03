# Online store builder phase 2

The theme document (v7) holds the whole storefront: tokens, brand, the
header/footer/product/listing blocks, the homepage's sections and up to 20
landing pages (`pages.landing`, `/pages/<slug>`, homepage sections). There are
no per-page templates: every product page renders `blocks.product` (gallery,
buy box, the ordered `below` modules, app blocks, sticky bars) and every
collection, category, brand and search page renders `blocks.listing`. CMS pages
keep their own content; the theme frames them.

## Drafts, publishing and versions

- One shared draft per store, guarded by its revision. Save, page edits,
  restore, discard and publish are each one guarded D1 batch
  (`packages/core/src/modules/settings/site-settings.service.ts`). Restore and
  discard replace the draft only; publishing is the one way anything goes live.
- Publishing writes live, a version row and the rebased draft, and prunes to
  the newest 20 versions in the same batch. A version row holds
  `{ meta: { changes, moreChanges, note }, theme }`: at most 20 typed changes
  (`compareThemeDocuments`) and a 500-character note; author and time come
  from the row. Documents are capped at 512 KiB.
- Preview sessions store only a SHA-256 of the token. Draft tokens are `D` +
  random; version tokens are `V` + base-36 revision + random. Pruned versions
  lose preview.

## Upgrades

`upgradeThemeDocument` applies one pure step per version (v1 to v7) on a clone,
from frozen literals, then fills current defaults and validates strictly. Reads
upgrade in memory; writes require v7. Golden fixtures v1 to v7 live in
`packages/shared/src/storefront-theme/fixtures`; `upgrade.md` says how to add v8.

## Editor (`/admin/online-store/theme/editor`)

Shopify's layout: a top bar (back, theme state and who published last, the page
picker, device toggle, undo/redo, More actions with Versions, Preview in a new
tab and Discard draft, Save, Publish), the page's tree on the left, the live
preview in the middle, and the selected part's settings on the right (in place
of the tree below 1280px). Edits autosave after 800 ms; a conflict keeps the
edits and offers reload or an explicit overwrite.

- Page picker: Home page, Products, Collections, Categories, Search results,
  Pages (CMS) and every landing page, plus New landing page. Resource pages
  preview the store's first item and can switch to another.
- Tree: Header (announcement bar, header), the page, Footer. Home and landing
  pages list their sections (add from the illustrated picker, drag or Space +
  arrows to reorder, duplicate, hide, remove with undo) and their page settings.
  Product pages list Product information, each module (shown first in page
  order, then hidden ones; eye toggles and reordering) and App blocks. Listing
  pages list Toolbar, Filters and Product grid (search adds its own layout and a
  filter drawer). CMS pages link to their content editor.
- Clicking the preview selects the section or part under the pointer: sections,
  header, announcement bar, footer, product information, modules, app blocks,
  the listing grid and filters carry preview marks.
- Theme settings tab: colours (contrast-checked), typography, logos and product
  cards. The Themes page shows the current theme with Customize, Preview and
  Publish, and the template library (a template restyles the draft and keeps
  the merchant's content).

## API and agents

Routes in `apps/api/src/routes/admin/settings/site.ts`: `editor_get` (the
editor's bundle, not an agent operation), `workspace_get` (revisions, last
publication, landing pages), `document_get` (a whole draft, live or version
document, delivered to agents as an authenticated JSON artifact),
`versions_list` (five per page), and the commands `draft_save`,
`page_draft_update`, `version_restore`, `draft_discard` and `publish`, which
answer revision receipts only. The curated `theme.draft-landing-page.v1`
workflow drafts a landing page and verifies it through `workspace_get`; it never
publishes.

## Storefront budgets

Each page renders from one `/api/v1/storefront/batch` call. In-process D1
trips/waves: home 10/2, landing 10/2 (budget 13/2), product 19/3, category 6/3,
collection 7/3, search 6/2; validation 1/1, a repeat hit 1/1. Landing reads use
`deps.theme` plus the section planner's precise dependencies (including
`deps.collections` for named collections). Previews are private and uncached.
No schema migration, binding or dependency was added.
