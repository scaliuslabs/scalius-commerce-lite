# Demo-store toolchain

`pnpm demo:store` (`scripts/demo-store.mjs`) plans, compares, applies, and exports the Scalius Market demo catalog. It is for contributors and operators of the Scalius demo deployment. This file covers the pipeline, the CLI modes, diff mode, and export mode. Each other stage has its own document.

`manifest.mjs` defines the catalog: 5 categories, 50 products (10 per category), 177 SKUs, 5 collections, 3 hero stories, and 237 media assets (5 category images and 6 hero images; the rest are product media). Prices are in BDT. Two products, Rider and Halo, are retained from the live store and keep their IDs, SKUs, stock, and ledger history.

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

`assets/cli.mjs --stage` writes the staged files and `readiness.json`. Stage 4 reads both and writes `apply-readiness.json`, which stage 6 requires. Both files live under `.wrangler/demo-store-assets/` (git-ignored).

## Modes

Choose exactly one mode per run. `--help` prints the usage text.

| Mode | Network | Writes | Input |
| --- | --- | --- | --- |
| `--plan` | none | none | the manifest |
| `--compile` | none | none | the manifest |
| `--diff` | sign-in, bounded GETs, sign-out on the admin origin | local evidence files | a live admin origin |
| `--apply` | the same, plus guarded catalog writes | the live catalog, and private evidence and resume files | a live admin origin and a media readiness report |
| `--export` | none | the output directory only | one local SQLite file |

| Option | Modes | Meaning |
| --- | --- | --- |
| `--json` | all | Print machine-readable output. |
| `--admin-url <origin>` | `--diff`, `--apply` | The dashboard origin. Default `https://dashboard.scalius.com`. It must be HTTPS; HTTP is allowed only on loopback. |
| `--timeout-ms <ms>` | `--diff`, `--apply` | Per-request timeout. Default 20000. |
| `--evidence-dir <path>` | `--diff`, `--apply` | Evidence directory. Defaults: `.wrangler/demo-store-evidence` (diff), `.wrangler/demo-store-apply/evidence` (apply). Apply requires a path under `.wrangler`. |
| `--media-readiness <file>` | `--apply` | Required. The upload-bridge report. |
| `--resume-file <path>` | `--apply` | Resume journal. Default `.wrangler/demo-store-apply/resume-<fingerprint>.jsonl`. |
| `--export`, `--source-db`, `--media-source-dir` | `--export` | See Export mode. |

`--diff` and `--apply` sign in at `/api/auth/sign-in/email` on the admin origin and sign out at the end. They read the admin email and a hidden password from an interactive terminal only. They reject `--email`, `--password`, `--cookie`, `--token`, and `--secret`, and they refuse an account that needs two-factor verification.

## Diff mode

`--diff` reads categories, products (and the detail of each manifest product), media, attributes, collections, and the theme workspace with bounded GETs. It matches resources to the manifest by exact slug or name and reports each as `match`, `update`, `create`, or `conflict`. It also lists resources outside the manifest and never changes them. It saves the snapshot, `diff.json`, `run.json`, and `resume.jsonl` in `run-<timestamp>-<id>/` under the evidence directory, with `0700` directories and `0600` files.

## Export mode

```sh
pnpm demo:store --export <dir> --source-db <sqlite file> [--media-source-dir <dir>] [--json]
```

Export mode turns a database that already holds the demo store into a seed bundle that another deployment can load. It has no admin origin, credential prompt, or session, and no write path to a live store. The only input is a SQLite file, opened through Node's `node:sqlite` with `readOnly: true`, so SQLite rejects any statement that would change it. The mode opens no socket. [docs/AUTOMATED-DEPLOYMENTS.md](../../docs/AUTOMATED-DEPLOYMENTS.md) describes the control-plane use.

- `--export <dir>` is the output directory. The exporter creates it if missing and replaces a directory that holds only its own entries. It refuses a directory that holds anything else.
- `--source-db <path>` is required.
- `--media-source-dir <dir>` is optional. The exporter reads each asset from `<dir>/<object key>`, checks it against the size on its `media` row, hashes it, and copies it to `<bundle>/media/<object key>`.

### Bundle layout

```text
<dir>/bundle.json            manifest: contract, schema revision, row counts, demo-store comparison, artifact digests
<dir>/seed.sql               canonical, deterministic SQL for the catalog
<dir>/media-manifest.json    one entry per media row, keyed by object key
<dir>/media/<object key>     only with --media-source-dir
```

`bundle.json` records the contract name (`scalius-demo-store-seed/v1`), the schema revision as `{ version, name, sourceSha256 }`, the row count per table, how the catalog compares to the manifest counts (reported, never enforced), and the sha256 of `seed.sql` and `media-manifest.json`. It has no timestamps and no local paths, so two exports of the same database are byte-identical.

`media-manifest.json` lists the assets a loader must put in its object store. Each entry has the media identity (`id`, `objectKey`, `filename`, `kind`, `mimeType`, `byteSize`, `width`, `height`, `durationMs`), `sha256` and `bytesIncluded` (set only when the exporter read the bytes), and `references`: the folder, the poster relations, the `product_media` attachments, and the variants whose image is one of them. The exporter derives references from foreign-key edges inside the bundle, never from free-form presentation JSON.

### What the seed carries

The seed carries 16 catalog tables, in dependency order: `media_folders`, `media`, `categories`, `collections`, `brands`, `product_attributes`, `products`, `product_media`, `product_option_definitions`, `product_option_values`, `product_variants`, `product_variant_option_values`, `product_attribute_values`, `product_rich_content`, `product_content_blocks`, `product_bundles`.

- The exporter reads no other table: no orders, customers, users, sessions, accounts, settings, discounts, promotions, inventory ledgers, checkout state, or `*_fts*` shadow tables. The allow-list is `export/tables.mjs`.
- The homepage (hero slides, homepage collections) is part of the storefront theme, a setting, so a seed never carries it.
- `product_content_blocks` omits the blocks that mirror `product_rich_content` tabs. The mirror trigger from migration 0090 recreates them when a tab loads.

`seed.sql` has a header (contract, schema revision, row counts) and one `BEGIN;` / `COMMIT;` transaction that starts with `PRAGMA defer_foreign_keys = ON`. It holds one `INSERT` per row in primary-key order (categories by depth first), with one canonical spelling per value. It ends with the statements of migration `0091_catalogue_projection_fill.sql`, because a seeded store lists no products without the buyer-state and facet projections.

Load the seed into a freshly migrated, empty catalog at the same schema revision, with `PRAGMA foreign_keys = ON`. The single transaction is all-or-nothing: a load over a catalog that already holds these rows rolls back. The AFTER INSERT triggers rebuild `products_fts`, `product_variants_fts`, and `categories_fts` as the seed loads.

### Fail-closed preconditions

An export produces a complete bundle or nothing. It never repairs a catalog. Each error names the rows in the way.

1. **Schema revision match.** The highest `scalius_schema_migrations` row of the source must equal the newest migration file: version, name, and the `source_sha256` that the migration writes about itself. Another revision, or no ledger, is refused.
2. **Allow-list only.** The exporter reads the 16 tables above.
3. **No commerce entanglement.** An exported variant with non-zero `reserved_stock`, or an `order_items` row that references an exported product or variant, fails the export.
4. **No dangling references.** Every non-null foreign key on an exported row must point to an exported row. The edges come from `PRAGMA foreign_key_list`, so a reference that a later migration adds is checked at once. `tax_classes` is not part of the catalog, so a product or variant with a `tax_class_id` is refused until you clear it.
5. **No soft-deleted rows.** A table with `deleted_at` exports only rows where it is null. `media` exports only `status = 'ready'`. A row that this rule strands fails rule 4.
6. **Real media object keys.** Each exported `media` row needs a unique, non-empty `object_key`.

With `--media-source-dir`, the exporter checks every named object for presence and size, and hashes it, before it writes any byte. `bundle.json` is written last, so an interrupted export leaves no manifest.

### Tests

```sh
pnpm exec vitest run scripts/demo-store-export.test.mjs
```

The test builds a migrated SQLite database. It covers argument parsing, the bundle, byte-identical re-export, a round-trip load with the FTS rebuild, each precondition, and media copying. Other tests: `scripts/demo-store.test.mjs`, `scripts/demo-store-diff.test.mjs`, `scripts/demo-store-apply.test.mjs`, and the `*.test.mjs` files beside the sources.
