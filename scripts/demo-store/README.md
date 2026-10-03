# Demo-store toolchain

`pnpm demo:store` (`scripts/demo-store.mjs`) plans, compares, applies and exports the Scalius Market demo catalog. It is for contributors and operators of the Scalius demo deployment. This file covers the pipeline, the CLI modes, diff mode and export mode. Each other stage has its own document.

`manifest.mjs` defines the catalog: 5 categories, 50 products (10 per category), 177 SKUs, 5 collections, 3 hero stories and 237 media assets (5 category images, 6 hero images, the rest product media). Prices are in BDT. Two products, Rider and Halo, are retained from the live store and keep their IDs, SKUs, stock and ledger history.

## Pipeline

| Stage | Command | Detail |
| --- | --- | --- |
| 1. Validate the manifest | `pnpm demo:store --plan` | this file |
| 2. Inspect the command intents | `pnpm demo:store --compile` | [compile-contract.md](compile-contract.md) |
| 3. Stage media files offline | `node scripts/demo-store/assets/cli.mjs` | [assets/README.md](assets/README.md) |
| 4. Upload staged media to the store | `node scripts/demo-store/media-upload/cli.mjs --upload` | [media-upload/README.md](media-upload/README.md) |
| 5. Compare the live store with the manifest | `pnpm demo:store --diff` | this file |
| 6. Apply the manifest to the live store | `pnpm demo:store --apply --media-readiness <file>` | [apply/README.md](apply/README.md) |
| Export a catalog as a seed bundle | `pnpm demo:store --export <dir> --source-db <file>` | this file |

`assets/cli.mjs --stage` writes the staged files and `readiness.json`. Stage 4 reads both and writes `apply-readiness.json`, which stage 6 requires. All of them live under `.wrangler/demo-store-assets/` (git-ignored).

## Modes

Choose exactly one mode per run. `--help` prints the usage text.

| Mode | Network | Writes | Input |
| --- | --- | --- | --- |
| `--plan`, `--compile` | none | none | the manifest |
| `--diff` | sign-in, bounded GETs, sign-out on the admin origin | local evidence files | a live admin origin |
| `--apply` | the same, plus guarded catalog writes | the live catalog, and private evidence and resume files | a live admin origin and a media readiness report |
| `--export` | none | the output directory only | one local SQLite file |

| Option | Modes | Meaning |
| --- | --- | --- |
| `--json` | all | Print machine-readable output. |
| `--admin-url <origin>` | `--diff`, `--apply` | The dashboard origin. Default `https://dashboard.scalius.com`. It must be HTTPS; HTTP is allowed only on loopback. |
| `--timeout-ms <ms>` | `--diff`, `--apply` | Per-request timeout. Default 20000. |
| `--evidence-dir <path>` | `--diff`, `--apply` | Default `.wrangler/demo-store-evidence` (diff). |

`--apply` also takes `--media-readiness` and `--resume-file` ([apply/README.md](apply/README.md)).

`--diff` and `--apply` sign in at `/api/auth/sign-in/email` on the admin origin and sign out at the end. They read the admin email and a hidden password from an interactive terminal only. They reject `--email`, `--password`, `--cookie`, `--token` and `--secret`, and they refuse an account that needs two-factor verification.

## Diff mode

`--diff` reads categories, products (and the detail of each manifest product), media, attributes, collections and the theme workspace with bounded GETs. It matches resources to the manifest by exact slug or name and reports each as `match`, `update`, `create` or `conflict`. It lists resources outside the manifest and never changes them. It saves the snapshot, `diff.json`, `run.json` and `resume.jsonl` in `run-<timestamp>-<id>/` under the evidence directory, with `0700` directories and `0600` files.

## Export mode

```sh
pnpm demo:store --export <dir> --source-db <sqlite file> [--media-source-dir <dir>] [--json]
```

Export mode turns a database that already holds the demo store into a seed bundle that another deployment can load. It has no admin origin, credential prompt or session, and no write path to a live store. It opens the one SQLite file through `node:sqlite` with `readOnly: true`. [docs/AUTOMATED-DEPLOYMENTS.md](../../docs/AUTOMATED-DEPLOYMENTS.md) describes the control-plane use.

- `--export <dir>` is the output directory. The exporter creates it, or replaces a directory that holds only its own entries. It refuses any other directory.
- `--source-db <path>` is required.
- `--media-source-dir <dir>` is optional. The exporter reads each asset from `<dir>/<object key>`, checks its size against the `media` row, hashes it and copies it to `<bundle>/media/<object key>`.

### Bundle layout

```text
<dir>/bundle.json            contract, schema revision, row counts, demo-store comparison, artifact digests
<dir>/seed.sql               canonical, deterministic SQL for the catalog
<dir>/media-manifest.json    one entry per media row, keyed by object key
<dir>/media/<object key>     only with --media-source-dir
```

`bundle.json` records the contract name (`scalius-demo-store-seed/v1`), the schema revision (`{ version, name, sourceSha256 }`), the row count per table, how the catalog compares to the manifest counts (reported, never enforced) and the sha256 of the other files. It has no timestamps or local paths, so two exports of one database are byte-identical.

`media-manifest.json` lists what a loader must put in its object store: the media identity, `sha256`, `bytesIncluded` (set only when the exporter read the bytes) and `references` (folder, poster relations, `product_media` attachments, variants that use the image). Foreign-key edges inside the bundle give the references, never free-form presentation JSON.

### What the seed carries

The seed carries the 16 catalog tables of `EXPORTED_TABLES` (`export/tables.mjs`), in dependency order, and no other table: no orders, customers, users, settings, discounts, inventory ledgers, checkout state or `*_fts*` shadow tables.

- The homepage is part of the storefront theme, a setting, so a seed never carries it.
- `product_content_blocks` omits the blocks that mirror `product_rich_content` tabs. The mirror trigger from migration 0090 recreates them when a tab loads.

`seed.sql` has a header (contract, schema revision, row counts) and one `BEGIN;` / `COMMIT;` transaction that starts with `PRAGMA defer_foreign_keys = ON`. It holds one `INSERT` per row in primary-key order (categories by depth first). It ends with the statements of migration `0091_catalogue_projection_fill.sql`, because a seeded store lists no products without the buyer-state and facet projections.

Load the seed into a freshly migrated, empty catalog at the same schema revision, with `PRAGMA foreign_keys = ON`. The transaction is all-or-nothing, so a load over rows that already exist rolls back.

### Fail-closed preconditions

An export produces a complete bundle or nothing. It never repairs a catalog. Each error names the rows in the way.

1. **Schema revision match.** The highest `scalius_schema_migrations` row of the source must equal the newest migration file: version, name and `source_sha256`.
2. **No commerce entanglement.** An exported variant with non-zero `reserved_stock`, or an `order_items` row that references an exported product or variant, fails the export.
3. **No dangling references.** Every non-null foreign key (read from `PRAGMA foreign_key_list`) on an exported row must point to an exported row. `tax_classes` is not part of the catalog, so a product or variant with a `tax_class_id` is refused until you clear it.
4. **No soft-deleted rows.** A table with `deleted_at` exports only rows where it is null. `media` exports only `status = 'ready'`. A row that this rule strands fails rule 3.
5. **Real media object keys.** Each exported `media` row needs a unique, non-empty `object_key`.

With `--media-source-dir`, the exporter checks every named object for presence and size, and hashes it, before it writes any byte. It writes `bundle.json` last, so an interrupted export leaves no manifest.

Test: `pnpm exec vitest run scripts/demo-store-export.test.mjs`.
