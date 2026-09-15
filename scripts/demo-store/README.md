# Demo-store CLI

`pnpm demo:store` is the one entry point for every demo-store operation. Each
mode is exclusive, and each one states up front what it is allowed to touch:

| Mode | Network | Writes | Input |
| --- | --- | --- | --- |
| `--plan` | none | none | the manifest |
| `--compile` | none | none | the manifest |
| `--diff` | bounded authenticated GETs | none | a live admin origin |
| `--apply` | authenticated writes | the live catalog | a live admin origin |
| `--export` | none | the output directory only | one local SQLite file |

`compile-contract.md` documents the compiler that `--compile` and `--apply`
share. The rest of this file documents export mode.

## Headless demo-store export

```
pnpm demo:store --export <dir> --source-db <sqlite file> [--media-source-dir <dir>] [--json]
```

Export mode turns a database the demo store has already been applied to into a
portable seed bundle another deployment can load. It is the mirror image of
`--apply`: there is no admin origin, no credential prompt, no session, and no
write path to a live store. Its only input is a SQLite file — a local
D1/miniflare `.sqlite` file, or any SQLite file carrying this schema — opened
with `readOnly: true`, so SQLite itself rejects any statement that would modify
it. Nothing in the mode opens a socket or reads credential material.

- `--export <dir>` is the output directory. It is created if missing. A
  directory that already holds only this exporter's own entries is replaced, so
  re-running an export into the same directory is the normal case; a directory
  holding anything else is refused rather than clobbered.
- `--source-db <path>` is required. Without it, `--export` fails immediately.
- `--media-source-dir <dir>` is optional. When given, each exported asset's
  bytes are read from `<dir>/<object key>`, checked against the byte size its
  `media` row records, hashed, and copied into `<bundle>/media/<object key>`.
- `--json` prints the machine-readable summary instead of the human one.

### Bundle layout

```
<dir>/bundle.json            manifest: contract version, schema revision, row counts, artifact digests
<dir>/seed.sql               canonical, deterministic SQL for the catalog
<dir>/media-manifest.json    one entry per media row, keyed by object key
<dir>/media/<object key>     only when --media-source-dir is given
```

`bundle.json` records the schema revision the bundle was taken at as
`{ version, name, sourceSha256 }`, the per-table row counts the seed restores,
how the catalog compares to the published demo-store contract, and the sha256 of
both `seed.sql` and `media-manifest.json` so a transfer can be verified before it
is applied. It carries no timestamps and no local paths: two exports of the same
database produce byte-identical files.

`media-manifest.json` is the machine-readable half of the asset handover. Each
entry carries the identity a loader needs (id, object key, filename, kind, mime
type, byte size, width, height, duration) plus every logical reference inside the
bundle that points at the asset: its folder, its poster relationships, its
`product_media` attachments, and the variants whose image resolves to one of
those attachments. Those references are derived from the foreign-key edges the
bundle actually carries. Assets referenced only from free-form presentation JSON
are not inferred, because guessing at a reference is worse than not claiming one.
`sha256` is populated only when the bytes were actually read.

### What the seed carries

Exactly fifteen catalog tables, in this dependency order:

`media_folders`, `media`, `categories`, `collections`, `product_attributes`,
`products`, `product_media`, `product_option_definitions`,
`product_option_values`, `product_variants`, `product_variant_option_values`,
`product_attribute_values`, `product_rich_content`, `hero_sections`,
`hero_sliders`.

Nothing else is ever opened for export — no orders, customers, users, sessions,
accounts, settings, discounts, promotions, inventory ledgers, checkout state, or
`*_fts*` shadow tables. That is a structural property of the allow-list, not a
filter someone has to remember to keep current.

`seed.sql` opens with a header naming the contract version, the schema revision
and the per-table row counts, then a single `BEGIN;` / `COMMIT;` transaction with
`PRAGMA defer_foreign_keys = ON` at its top so intra-bundle ordering cannot trip
a foreign key mid-load. Rows are emitted one `INSERT` per row, in primary-key
order, with values encoded canonically, so two exports of the same database are
byte-identical.

Load it into a **freshly migrated, empty** catalog at the same schema revision
with `PRAGMA foreign_keys = ON`. The single transaction makes the load
all-or-nothing: loading it over a catalog that already holds these rows aborts
and rolls back rather than merging.

The FTS shadow tables are deliberately absent. `products_fts`,
`product_variants_fts` and `categories_fts` are maintained by AFTER INSERT
triggers that already exist in the migrated schema, so they repopulate
themselves as the seed loads.

### Fail-closed preconditions

An export either produces a complete bundle or produces nothing and names the
rows in the way. There is no partial bundle and no repaired catalog.

1. **Schema revision match.** The source's highest `scalius_schema_migrations`
   row must equal the newest canonical migration exactly — version, name and the
   `source_sha256` that migration writes about itself. A source at a different
   revision, or with no release ledger at all, is refused.
2. **Catalog-only allow-list.** Only the fifteen tables above are read.
3. **No commerce entanglement.** Refused when any exported variant carries
   non-zero `reserved_stock`, or when any `inventory_reservation_lanes`,
   `checkout_inventory_lane_movements` or `order_items` row references an
   exported product or variant. The error names the offending ids.
4. **No dangling references.** Every non-null foreign key on an exported row
   must resolve to a row that is itself exported. Edges come from
   `PRAGMA foreign_key_list`, never a hard-coded list, so a reference added by a
   future migration is checked the day it lands. In particular `tax_classes` is
   not part of the portable catalog, so a product or variant with a non-null
   `tax_class_id` is refused with instructions to clear the assignment first.
5. **Soft-deleted rows are excluded.** Every exported table with a `deleted_at`
   column exports only rows where it is null, and `media` additionally exports
   only `status = 'ready'`. A row stranded by such an exclusion is a dangling
   reference and fails under rule 4.
6. **Media object keys are real.** Every exported `media` row must carry a
   non-empty `object_key`, and duplicate object keys fail the export.

With `--media-source-dir`, every named object is checked for presence and size
and hashed **before** a single byte is written, so a missing object fails the
whole export rather than producing a bundle that claims a media directory it only
half filled. `bundle.json` is always written last, so an interrupted export
leaves a directory without a manifest, never a manifest that overstates what is
beside it.

### Tests

`scripts/demo-store-export.test.mjs` builds a real migrated SQLite database from
`packages/database/migrations/`, seeds a small catalog into it, and covers
argument parsing, the happy path, byte-identical re-export, a full round-trip
load into a freshly migrated database (including proving the FTS triggers rebuilt
their indexes), each fail-closed precondition, media copying, and the proof that
export mode never calls `fetch` and never writes to its source.

```
pnpm exec vitest run scripts/demo-store-export.test.mjs
```
