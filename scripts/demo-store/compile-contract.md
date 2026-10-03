# Demo-store command compiler

`compile.mjs` turns the validated manifest into an ordered list of admin API command intents. It is pure: it reads nothing, writes nothing, and makes no network call. `pnpm demo:store --compile` compiles the manifest and prints a summary (commands per phase, retained boundaries). It never runs a command. This file is for contributors who change the manifest, the compiler, or the binder.

`compileDemoStoreAdminCommands(manifest, { current })` takes an optional `current` snapshot (`categories`, `productDetails`, `collections`, `attributes`, `resumeSimpleSlugs`). Without it, every resource compiles as new. A command has an `id`, a `logicalKey`, a `phase`, a `method`, a `path`, a `body`, and where needed `dependsOn`, `preconditions`, `produces`, and `pathBindings`.

## References and identities

- `{ "$ref": "logical-key", "field": "id" }` is an unresolved reference. The binder (`apply-bind.mjs`) resolves it from a fresh read or from a prerequisite command's result before the body is sent. A reference object is never a valid API value.
- New product-media associations get deterministic `pmed_demo_<hash>` IDs, so the exact SKU image references and the media array agree in one create request.
- New attribute, category, product, collection, option, value, variant, and section draft IDs are deterministic hashes of logical manifest keys. No random value or clock enters compilation.
- New optioned SKUs send `barcode: null` and `barcodeType: null`, so the product create endpoint generates the internal Code 128 barcode. A simple-SKU update sends no barcode fields, so the generated default barcode stays.

## Retained products

Rider and Halo (`retainedProductId` in the manifest) compile to a guarded base update plus an option-matrix update. The commands keep the product, SKU, option, value, stock, reservation, and ledger identities. The base command lists the media associations that live SKUs reference and that the manifest drops. It acknowledges only those removals (`acknowledgedSkuImageRemovalIds`). The matrix command then points the same SKU IDs at the new generated images and adopts the current stock, tracking, weight, and barcode values. This retires assets without clear rights and keeps inventory and the exact-SKU-image model.

Activation, attributes, SKU, option, and value identities, and section IDs stay reference tokens until the binder resolves them from a fresh product read. A missing topology, a missing replacement authority, or an unresolved reference fails closed.

An existing non-retained product with options adopts its current SKU, stock, tracking, weight, barcode, option, value, and variant identities by exact option combination. A missing combination can be created. An ambiguous combination fails closed. A simple product's stock is not reseeded because the product exists. The compiler emits the simple-SKU update for an existing product only when the caller lists its slug in `current.resumeSimpleSlugs`; only `runRevisionSafeApply` (see [apply/README.md](apply/README.md)) does that.

Every update carries a revision from the snapshot or a reference to the exact prerequisite command's result. A consumer stops on HTTP 409 and recompiles. It never replaces these claims or retries blindly.

## Command order

| Phase | Commands |
| --- | --- |
| `vocabulary` | The `Brand` attribute, create-only. An exact existing definition is adopted. A different name or filterable flag makes compilation throw, because the attribute update API has no revision claim. |
| `categories` | Create or update (`PUT` with `expectedRevision`) of each category. |
| `products` | A new product: one create command (its option matrix is in the body) and, for a simple product, a simple-SKU update. An existing or retained product: a base update, then a matrix update when it has options. A new product starts inactive. |
| `activation` | Activate a new product after its SKU, media, and content are complete. |
| `publication` | Publish a category after its first product exists. |
| `collections` | Manual collections list ordered product IDs. Dynamic collections list category references. A collection has no homepage flag. |
| `presentation` | One `theme:draft` command (`POST /api/v1/admin/settings/theme/draft`). |

The `theme:draft` body holds `$demoHomepage`: the heroes become the slides of the first hero section, and `homepageCollections` become the collection IDs of the first collections section. The binder composes them into the published theme read in the snapshot (`theme-homepage.mjs`) and saves the draft at the revisions read in the workspace (`current-theme`).

## Binder and executors

The binder resolves references from a fresh authenticated snapshot, from verified staged assets, or from the safe authority (`id` and revisions) of earlier commands. It never rebuilds a payload. Its one composition is `$demoHomepage`.

`run-apply.mjs` exports `runDemoStoreApply`, the full lifecycle behind `pnpm demo:store --apply` ([apply/README.md](apply/README.md)). It also exports `runRevisionSafeApply`, a staged-only executor that never activates or publishes. Only tests call it.
