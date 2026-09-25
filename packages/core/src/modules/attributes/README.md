# Attributes

Typed product attributes (migration 0090): definitions, spec groups, the value vocabulary, type conversion, category attribute sets and the typed product-value writer. Storefront filter and facet reads live in `catalog/facets.ts`. The code is the source of truth. This page only maps it.

## Files

| File | Purpose |
|------|---------|
| `attributes.validation.ts` | Zod schemas (browser-safe), reserved slugs (`brand`, `category`, `search`, `q`, `page`, `limit`, `sort`, `ids`) |
| `attribute-value-codec.ts` | Pure encoding of a typed value (text, enum display, number with an optional unit, yes/no including Bangla) (browser-safe) |
| `attributes.service.ts` | Definition CRUD and the string-keyed value routes (`/{id}/values`) over `attribute_values` |
| `attribute-values.ts` | The id-based vocabulary (`atv_`): list, create, rename/recolour/reorder, delete or merge, and the definition's `options` list |
| `attribute-groups.ts` | Spec groups (`atg_`); trashing a group ungroups its attributes |
| `attribute-types.ts` | `convertAttributeValueType`: validate everything, switch the type, then rewrite rows in resumable keyset chunks |
| `category-attribute-sets.ts` | Effective set through `category_closure`; order key `(3 - depth) * 100000 + sort_order`, lowest per attribute, ties by name |
| `product-attribute-values.ts` | `prepareProductAttributeValueRows`, used by `products/admin/write.ts` |
| `projection-refresh.ts` | `CatalogProjectionRefresh` (injected by the caller) and the 90-products-per-batch walker |

## Rules

- This domain imports no other domain. Every write that changes `product_attribute_values` rows, or their facet key or label, takes a `CatalogProjectionRefresh`. The API passes `catalogProjectionRefreshStatements`. Each batch covers at most 90 products and holds the row writes, the aggregate revision bump and then the refresh.
- Every statement binds at most 90 parameters. Id and value lists go in as one `json_each` JSON parameter.
- `normalized_value` is always computed in SQL (`lower(trim(value))`), because the column CHECK requires it.
- Code does not read or write `product_attributes.options`. The list responses' `options` field comes from `attribute_values`. Migration `0092_attribute_option_presets` copied the old presets into `attribute_values` (idempotent; the column drop in the next release re-runs it first).
- `valueType` changes only through conversion. Unit is allowed only on number attributes. `range` is allowed only on number, `swatch` only on enum.
- A conversion first drops the attribute's facet rows (they carry old-type keys). Each chunk then writes its products' rows back. Running the same conversion again continues with the rows that are still in the wrong shape.
- A number row is in shape only when its display text equals the canonical number plus the unit, so a unit change through conversion rewrites the display text.
- A permanent delete removes the facet rows, the product values, the vocabulary and then the definition. Trash and permanent delete are still refused while products use the attribute.
- The admin routes bump the cache generation after every buyer-visible write, and also after a failure that may already have committed batches.
