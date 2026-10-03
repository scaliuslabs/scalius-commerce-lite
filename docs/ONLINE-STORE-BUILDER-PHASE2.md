# Online store builder phase 2

Theme v7 keeps page composition in the existing theme document. `template`
remains a label. The same draft revision guards home, landing and fixed product,
collection and search blocks; publishing is the only way draft changes go live.

- Up to 20 landing pages at `/pages/<slug>` use the homepage section registry.
  Writes cap the complete UTF-8 theme document at 512 KiB, bounding D1 rows and
  the retained history's memory on Workers Free. Older reads still upgrade.
  A matching published CMS page at `/<slug>` can replace its body with those
  sections using `overrideCms`; CMS visibility, title, canonical and noIndex
  remain authoritative.
- Product and listing templates retain fixed blocks, in merchant order, with
  explicit visibility. They reuse the existing page reads, SKU image selection
  and structured-data rules. Collection/category and search share listing blocks;
  grid density remains the existing theme density control.
- The last 20 published versions are retained; pruning is in the guarded publish
  batch. Immutable history rows carry the upgraded theme plus publication
  metadata inside the existing JSON column: author name/id, time, bounded change
  summary and optional note. Older bare document rows still read.
- Restore and discard only replace the draft and advance its revision. Staff
  conflicts require reload or explicit overwrite against the newly read revision.
  Version previews encode an authenticated selector in the random session token;
  draft tokens reserve `D` and immutable versions reserve `V`, keeping the
  existing 52-character protocol unambiguous. The stored token hash remains
  authority. Pruned versions lose preview access.
- `upgradeThemeDocument` clones and applies one step per historical version,
  then validates the current strict schema. Reads upgrade in memory; writes
  require v7. Historical golden fixtures and migration notes are beside the
  shared document code. A future v8 adds one upgrade step.
  Independent historical heading/body font stacks stay intact until an explicit
  pairing choice; the dashboard describes that state in English and Bangla.
- Agent page edits, draft reads/saves, history, restore/discard and previews use
  stable operations with theme RBAC and revision requirements. The curated
  `theme.draft-landing-page.v1` workflow ends at review; publish is explicit.
  Browser responses retain complete documents; agent commands use compact
  revision receipts. Agent history is paginated five versions at a time. Full
  theme/page reads use authenticated JSON artifacts. The landing workflow's
  read-only page check proves exact approved content and draft/live revisions.

Public landing/CMS data uses the existing section query planner with `deps.theme`
and the planners' media, catalog, category, collection, promotion and app keys.
Storefront pages start all public reads together in one batch. Draft/version
preview reads are private and uncached.

Measured in-process D1 render trips/waves: home 10/2, product 19/3,
category 6/3, search 6/2, collection 7/3, landing 10/2, CMS override 11/2.
Authoritative validation adds 1/1; repeat hits cost 1/1. Landing pages retain
the homepage budget of 13/2. No schema migration, Worker binding or dependency
was added.

Real MCP/D1 checks with a large Bangla campaign measured a maximum compact
result of 1,100 bytes (4 KiB ceiling), a five-version metadata page of 33,520
bytes (64 KiB ceiling), and a page artifact of 426,732 bytes (1 MiB ceiling).
Artifact reads support merchant MCP/CLI connections; generic plugin principals
use the compact commands and cannot consume the full-document artifact.

## Verification, 2026-10-03

Lead source changes through `ce1b0613f8e2742f4d3a66473565fa7c9553dda0`
were integrated before the final verification, including the Free-plan and
cursor hardening. Generated contracts were rebuilt: 612 runtime routes and
1,406 agent records. Dashboard route generation produced no further changes.
The sandbox denied Git's shared worktree merge metadata writes. The merge-tree
content was therefore applied and committed linearly in `61a0623c3`,
`b7ba27430` and `e2c0c8557`; these commits do not record merge ancestry.

Recorded phase-2 sweeps passed 181 editor checks, 765 storefront checks,
259 shared/core/API domain checks, 412 operation/route/budget checks, 29 DVC
checks, 29 CLI checks, three real MCP checks and seven lead input checks
(1,685 checks; repeated runs are excluded). Final post-integration reruns also
passed the 396-check service/workflow group, 214-check frontier/render/MCP
group, 76-check generated-contract/CLI group, eight template render checks,
three route-family parity checks, and all 26 storefront budget checks. The
last editor component run passed 36 checks, including historical CMS and
missing-page preview paths. Performance boundary checks passed 47 checks;
navigation/settings checks passed 173 checks. The domain graph passed.

The required five-seed DVC property/race gate passed all 29 checks with zero
findings. Typechecks passed for shared, core, API, API client, admin, storefront
and CLI. Storefront checking used Astro's in-process `--noSync` mode: 728 files,
zero errors, zero warnings and 19 hints. Admin lint has zero errors and one
existing unused-disable warning in `StoreSettings.tsx:277`. All verification
ran without a dev server. Browser checks belong to the lead after merging.

### Dashboard bundle measurements

`scripts/admin-perf-check.mjs` built both this branch and an environment-file-free
snapshot of the lead at `ce1b0613f`. Budgets were unchanged. Values below are
Brotli KiB; route measurements include their initial entry and layout imports.

| Surface | Lead baseline | Builder | Budget |
| --- | ---: | ---: | ---: |
| Initial entry | 159.05 | 144.75 | 138 |
| Theme editor | 352.40 | 352.88 | 360 |
| Stylesheet | 16.18 | 16.18 | 17 |

The editor remains lazy, with no editor code in the initial module graph and no
lazy-only library findings. Initial JavaScript decreased by 14.30 KiB. The
editor increased by 0.48 KiB while staying within its budget. Deferring closed
import dialogs, report/nav metadata and loader-only helpers also removed the
lead baseline's phone-metadata violations and brought product-list and
order-edit/new routes within their existing budgets.

The whole-dashboard gate still exits nonzero with ten findings, all on surfaces
already over budget in the clean lead baseline. This is a remaining dashboard
performance gap, not a passing gate:

| Surface | Lead baseline | Builder | Budget |
| --- | ---: | ---: | ---: |
| Initial entry | 159.1 | 144.8 | 138 |
| Customers | 356.9 | 300.0 | 245 |
| Home | 227.1 | 227.7 | 206 |
| Inventory | 281.0 | 271.3 | 255 |
| Order detail | 362.4 | 352.9 | 288 |
| Order list | 315.0 | 307.7 | 290 |
| Product edit | 381.6 | 374.5 | 367 |
| Product new | 379.9 | 372.8 | 365 |
| Store settings | 329.2 | 319.3 | 291 |
| Login | 189.4 | 178.0 | 168 |

### Lead browser checks

1. Open `/admin/online-store/theme/editor` in English, then Bangla. Add a
   section from the illustrated picker, duplicate it, hide/show it and delete
   it. Focus its drag handle, press Space, ArrowUp/ArrowDown, then Space.
   Undo/redo changes; switch desktop, tablet and 390px phone previews; attempt
   to navigate away with unsaved edits.
2. Create landing handle `eid-offers`, add copy and an existing Files image,
   save the draft and preview `/pages/eid-offers`. Confirm the public page is
   unchanged. With a published CMS page using that handle, enable its body
   override and confirm the preview uses `/eid-offers` and preserves CMS SEO.
3. Publish with a note. Check author/time and readable history changes; preview
   an older version, restore it and confirm only the draft changes. Preview a
   version predating the landing page and confirm it shows that version's home.
   Edit again and confirm the preview returns to the draft. Confirm discard.
4. Save from two staff tabs using the same revision. The second must show the
   conflict banner; exercise reload and explicit overwrite.
5. Enter a real product URL and blur it to preview. Reorder/hide its fixed
   blocks and check exact-SKU image precedence, purchase options, JSON-LD and
   noIndex. Repeat with a category/collection URL for banner, filters and grid
   density, then check search including an empty search.
6. In the public storefront Network panel, confirm exactly one
   `/api/v1/storefront/batch` request per landing, CMS override, product,
   collection/category and search page render. Private previews have their
   separate authenticated transport.
7. Run merchant MCP workflow `theme.draft-landing-page.v1`. Confirm its exact
   page proof matches, the saved draft revision matches and live is unchanged.
