# Demo-store command compiler

`compile.mjs` turns the validated manifest into an ordered list of admin API command intents. It is pure: it reads nothing, writes nothing and makes no network call. `pnpm demo:store --compile` prints a summary (commands per phase, retained boundaries) and never runs a command. This file is for contributors who change the manifest, the compiler or the binder.

`compileDemoStoreAdminCommands(manifest, { current })` takes an optional `current` snapshot. Without it, every resource compiles as new. A command has an `id`, `logicalKey`, `phase`, `method`, `path` and `body`, plus `dependsOn`, `preconditions`, `produces` and `pathBindings` where needed.

## References and identities

- `{ "$ref": "logical-key", "field": "id" }` is an unresolved reference. The binder (`apply-bind.mjs`) resolves it from a fresh read or a prerequisite command's result before it sends the body. A reference object is never a valid API value.
- IDs of new attributes, categories, products, collections, options, values, variants and section drafts are deterministic hashes of logical manifest keys. New product-media associations get `pmed_demo_<hash>` IDs, so the exact SKU image references and the media array agree in one create request. No random value or clock enters compilation.
- New optioned SKUs send `barcode: null` and `barcodeType: null`, so the product create endpoint generates the internal Code 128 barcode. A simple-SKU update sends no barcode fields, so the generated barcode stays.

## Retained products

Rider and Halo (`retainedProductId` in the manifest) compile to a guarded base update plus an option-matrix update. The commands keep the product, SKU, option, value, stock, reservation and ledger identities.

- The base command lists the media associations that live SKUs reference and the manifest drops. It acknowledges only those removals (`acknowledgedSkuImageRemovalIds`).
- The matrix command points the same SKU IDs at the new generated images and adopts the current stock, tracking, weight and barcode values.
- Identities stay reference tokens until the binder resolves them from a fresh product read. A missing topology, a missing replacement authority or an unresolved reference fails closed.

An existing non-retained product with options adopts its current identities (SKU, stock, tracking, weight, barcode, option, value, variant) by exact option combination. A missing combination can be created. An ambiguous combination fails closed. A simple product's stock is not reseeded because the product exists. The compiler emits the simple-SKU update for an existing product only when the caller lists its slug in `current.resumeSimpleSlugs`; only `runRevisionSafeApply` does that.

Every update carries a revision from the snapshot or a reference to the prerequisite command's result. A consumer stops on HTTP 409 and recompiles. It never replaces these claims or retries blindly.

## Command order

| Phase | Commands |
| --- | --- |
| `vocabulary` | The `Brand` attribute, create-only. An exact existing definition is adopted. A different name or filterable flag makes compilation throw, because the attribute update API has no revision claim. |
| `categories` | Create or update (`PUT` with `expectedRevision`) each category. |
| `products` | A new product: one create command (its option matrix is in the body), plus a simple-SKU update for a simple product. An existing or retained product: a base update, then a matrix update when it has options. A new product starts inactive. |
| `activation` | Activate a new product after its SKU, media and content are complete. |
| `publication` | Publish a category after its first product exists. |
| `collections` | Manual collections list ordered product IDs. Dynamic collections list category references. A collection has no homepage flag. |
| `presentation` | One `theme:draft` command (`POST /api/v1/admin/settings/theme/draft`). |

The `theme:draft` body holds `$demoHomepage` (heroes and `homepageCollections`). The binder composes it into the published theme read in the snapshot (`theme-homepage.mjs`) and saves the draft at the revisions read in the workspace (`current-theme`). [apply/README.md](apply/README.md) describes the mapping.

## Binder and executors

The binder resolves references from a fresh authenticated snapshot, from verified staged assets, or from the safe authority (`id` and revisions) of earlier commands. It never rebuilds a payload, except for `$demoHomepage`.

`run-apply.mjs` exports `runDemoStoreApply`, the full lifecycle behind `pnpm demo:store --apply`, and `runRevisionSafeApply`, a staged-only executor that never activates or publishes. Only tests call the second.
