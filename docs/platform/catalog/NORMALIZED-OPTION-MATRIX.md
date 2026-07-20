# Normalized Product Option and SKU Architecture

Last reviewed: 2026-07-12

## Authority

- `products`: merchandising aggregate and aggregate revision.
- `product_media`: ordered associations to retained global image/video assets; exactly one row is featured when the gallery is non-empty.
- `product_option_definitions`: ordered merchant choice axes, display name, and
  optional standard discovery mapping.
- `product_option_values`: ordered values belonging to one definition.
- `product_variants`: sellable/inventory SKU, combination key, direct image,
  price, discount, barcode, weight, stock policy, and stock/version counters.
- `product_variant_option_values`: normalized SKU-to-definition/value assignment.
- Inventory movements: immutable stock counter edges. Product-level inventory
  does not exist.

## Database invariants

- A simple product has exactly one active protected default SKU; an optioned
  product has none. The two active shapes never coexist.
- Default SKU has `option_combination_key = NULL`; non-default SKU has a nonblank
  ordered combination key.
- Active option name and position are unique per product.
- Active value and position are unique per definition.
- Option definition positions are 0–4.
- Active non-default combination is unique per product.
- SKU and nonblank barcode identities are globally unique after trim/case fold.
- Variant direct image must belong to the same product; delete sets it null.
- Each SKU selects one value per active definition and no value from another
  product/definition.

Application validation allows any non-empty subset of the potential Cartesian
matrix. Every declared option value must still be used by at least one active
SKU, and each non-`none` discovery mapping may be used by only one axis. This
permits unavailable combinations such as White / 5KG without creating ghost
buyer choices.

## Mutation boundaries

`createProduct` accepts an optional create matrix. It prepares persisted image,
definition, value, and variant IDs, maps draft references, and commits the whole
aggregate plus initial stock movements in one D1 batch.

`PUT /api/v1/admin/products/{id}/options/matrix` is the sole topology/matrix
writer. It:

1. parses and canonicalizes the active matrix subset;
2. loads current definitions, values, variants, images, and lifecycle blockers;
3. validates global SKU/barcode identity and image ownership;
4. validates simple conversion or replacement stock allocation;
5. stages identity swaps and soft-retires option rows to avoid immediate unique
   index collisions during reorder;
6. guards product aggregate revision and every changed stock version;
7. upserts/soft-retires definitions, values, SKUs, and assignments;
8. writes inventory movement claims in the same batch;
9. soft-retires the protected default SKU after a successful simple-to-optioned
   stock allocation;
10. advances the product aggregate exactly once; and
11. reconciles low-stock alerts in bounded waves after commit.

All parameterized CAS/lifecycle guards use the database package's prepared
`buildBatchGuard()` select builder. Raw `db.run(sql...)` statements are not
batch-safe with Drizzle 0.45's D1 adapter because parameterized `SQLiteRaw`
objects do not expose a prepared `stmt` for `.bind()`.

Deleted APIs with no compatibility target: bulk variant generator, bulk create,
bulk delete, spreadsheet edit plan, variant sort-order, option-name fields, and
variant image-mapping routes.

## Read model

All admin and public product detail reads load ordered definitions/values and
ordered `selectedOptions`. Buyer option truth is `is_default = 0` plus a valid
nonblank combination key; no query reads legacy `size` or `color` columns.

Consumers:

- admin form, product view, order form, inventory, and scanner;
- storefront product selector, cart, checkout, account, receipt, and shortcode;
- product feed diagnostics/XML, UCP catalog, buyer pricing projection, and
  structured data.

Cart and order display uses ordered generic options / a bounded saved
`variantLabel`. Historical display never reconstructs meaning from fixed axes.

## Limits and performance

- Five axes and at most 150 potential Cartesian combinations; the active SKU
  subset may be smaller.
- Shared constants live in `@scalius/shared/product-options`.
- Assignment inserts are chunked to stay below D1's 100-binding limit.
- Repeated lookup sets use `json_each()` instead of large bound `IN` lists.
- Low-stock reconciliation runs in bounded waves to respect the six-connection
  Worker invocation limit.
- Admin matrix renders 30 rows per page and lazy-loads its component from create
  and edit routes.

## Admin workflow

- Option/value edits generate new candidate combinations, but deliberately
  omitted combinations stay omitted through unrelated edits and axis expansion.
- A merchant can omit one row or a selection, then restore one omitted row or
  all missing rows before save. In-session restore preserves the original SKU,
  image, stock, barcode, price, and discount draft.
- Discount type is explicit per SKU: none, percentage, or fixed amount.
- New SKUs without a merchant barcode receive an internal Code 128 identity on
  save. It is scanner-searchable but is never advertised as UPC/EAN/GTIN in
  feeds, UCP, or structured data. Clearing an existing barcode remains an
  intentional persisted null.

## Migration policy

Migrations 0007 and 0008 are a deliberate disposable-demo cutover. They remove
the old two-axis/image-mapping model, clear demo stock/alerts/movements, detach
historical demo order item variant references while retaining saved line labels,
rebuild SKU invariants, and install soft-retiring normalized option tables.

There is no backward reader/writer. After migration, seed demos only through the
normalized aggregate API or equivalent audited D1 batches that also create stock
movement truth.

## Failure semantics

- validation problem: 400 with a merchant-actionable message;
- missing/trashed product: 404;
- global identity/lifecycle/revision/stock conflict: 409;
- no partial result is accepted as success;
- a failed browser save retains the complete draft.
