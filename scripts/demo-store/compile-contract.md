# Demo-store command compiler

`compile.mjs` is a pure boundary between the validated rich-demo manifest and
the later authenticated apply phase. It performs no reads, writes, asset work,
or network calls. Its output is a serializable ordered list of admin API
command intents.

`pnpm demo:store --compile` exposes that deterministic intent as a network-free,
write-disabled inspection gate. It never enables execution.

## References and identities

- `{ "$ref": "logical-key", "field": "id" }` is an unresolved authority
  reference. The apply phase must resolve it from a fresh read or a successful
  prerequisite response before sending the body. Reference objects are never
  valid API payload values by themselves.
- New product-media associations use deterministic `pmed_demo_*` IDs so exact
  SKU image references and the media array agree in the same create request.
- New option, value, variant, section, collection, and slide draft identities
  are deterministic hashes of logical manifest identities. No random value or
  wall clock participates in compilation.
- New optioned SKUs request `barcode: null` and `barcodeType: null`, allowing
  the product create authority to generate internal Code 128 identities. New
  simple-SKU updates omit barcode fields so the server-generated default SKU
  barcode is retained.

## Retained resources

Rider and Halo are guarded base plus option-matrix updates. Their command
intents preserve product, SKU, option/value, stock, reservation, and inventory
ledger authority. The base command computes the exact removed media
associations referenced by live SKUs and acknowledges only those removals; the
matrix then rebinds the same SKU IDs to the intended generated images while
adopting current operational facts. This allows unprovable demo assets to be
retired without resetting inventory or weakening the exact-SKU-image model.
Current activation, attributes, SKU/option/value identities, and section IDs
remain reference tokens until the apply binder resolves them from a fresh
complete product read. Any missing topology, replacement authority, or
unresolved preservation reference fails closed.

Existing non-retained option matrices adopt current SKU, stock, tracking,
weight, barcode, option, value, and variant identities by exact option
combination. A missing combination may be created from manifest intent; an
ambiguous current combination fails closed. Existing simple-SKU stock is never
reseeded merely because the product exists. It is compiled only when the resume
journal proves the base create completed and its SKU initialization did not.

Every update carries either a numeric revision from the supplied current-state
snapshot or a reference to the exact prerequisite command result. A later
consumer must stop on 409 and recompile; it must not replace these claims or
blind-retry.

## Command order

Commands are grouped into create-only vocabulary reconciliation, category
reconciliation, product base/matrix/simple
SKU work, activation, category publication, collections, and desktop/mobile
hero documents. Manual collection membership is explicit and ordered. Dynamic
collections contain explicit category references. New categories publish only
after a first product dependency; new products start inactive and activate only
after their SKU/media/content payload is complete.

The reusable filterable `Brand` attribute is a create-only automated vocabulary
command. An exact existing definition is adopted. Because the Attribute update
API has no monotonic revision claim, a drifting name/filterable definition is a
pre-write conflict rather than an unsafe update.

`apply-bind.mjs` is resolution-only: it binds compiler references from a fresh
authenticated snapshot, verified staged assets, or safe prerequisite command
authority (`id` and monotonic revisions). It must not rebuild or reinterpret a
request payload. `run-apply.mjs` currently executes only category, product,
inactive collection, and inactive presentation commands. Activation and
publication remain excluded until the browser-verification milestone; the
public CLI still exposes no write mode.

The safe publication architecture is defined in `apply/README.md` and
`apply/phase-model.mjs`. It adds quarantine and explicit activation/publication
phases, repairs inactive-product resume, blocks unversioned settings, hashes the
complete intended payload for authorization, and restores safe authority from
the resume journal. This architecture is intentionally not reachable through a
public `--apply` flag yet.
