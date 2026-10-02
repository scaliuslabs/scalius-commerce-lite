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
  the stored token hash remains authority. Pruned versions lose preview access.
- `upgradeThemeDocument` clones and applies one step per historical version,
  then validates the current strict schema. Reads upgrade in memory; writes
  require v7. Historical golden fixtures and migration notes are beside the
  shared document code. A future v8 adds one upgrade step.
  Independent historical heading/body font stacks stay intact until an explicit
  pairing choice; the dashboard describes that state in English and Bangla.
- Agent page edits, draft reads/saves, history, restore/discard and previews use
  stable operations with theme RBAC and revision requirements. The curated
  `theme.draft-landing-page.v1` workflow ends at review; publish is explicit.

Public landing/CMS data uses the existing section query planner with `deps.theme`
and the planners' media, catalog, category, collection, promotion and app keys.
Storefront pages start all public reads together in one batch. Draft/version
preview reads are private and uncached.

Measured in-process D1 render trips/waves: home 10/2, product 19/3,
category 6/3, search 6/2, collection 7/3, landing 10/2, CMS override 11/2.
Authoritative validation adds 1/1; repeat hits cost 1/1. Landing pages retain
the homepage budget of 13/2. No schema migration, Worker binding or dependency
was added.
