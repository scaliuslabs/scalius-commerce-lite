# Demo-store command compiler

`compile.mjs` is a pure boundary between the validated rich-demo manifest and
the later authenticated apply phase. It performs no reads, writes, asset work,
or network calls. Its output is a serializable ordered list of admin API
command intents.

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

Rider and Halo are always guarded base-only updates. Their command intents carry
explicit preservation markers for SKU/option/media identities, inventory
ledger, and reservations, and the compiler emits no option-matrix or SKU
command for either product. Current activation, attributes, media-association
IDs, and section IDs remain reference tokens until the apply binder resolves
them from a fresh complete product read. Applying a retained command with an
unresolved preservation reference is a compiler-consumer defect and must fail
closed.

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

Commands are grouped into category reconciliation, product base/matrix/simple
SKU work, activation, category publication, collections, and desktop/mobile
hero documents. Manual collection membership is explicit and ordered. Dynamic
collections contain explicit category references. New categories publish only
after a first product dependency; new products start inactive and activate only
after their SKU/media/content payload is complete.

`apply-bind.mjs` is resolution-only: it binds compiler references from a fresh
authenticated snapshot, verified staged assets, or safe prerequisite command
authority (`id` and monotonic revisions). It must not rebuild or reinterpret a
request payload. `run-apply.mjs` currently executes only category, product,
inactive collection, and inactive presentation commands. Activation and
publication remain excluded until the browser-verification milestone; the
public CLI still exposes no write mode.
