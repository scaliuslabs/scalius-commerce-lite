# Attributes

Typed product attributes: definitions, spec groups, the value vocabulary, value-type conversion, category attribute sets and the typed product-value writer. Read this before you change attribute writes. Storefront filters and facet counts are in `catalog/facets.ts`.

## Entries and layer

- `browser.ts` exports `attributes.validation.ts` (Zod schemas, `RESERVED_ATTRIBUTE_SLUGS`) and `attribute-value-codec.ts` (pure value encoding). `index.ts` exports everything in `browser.ts`, plus the attribute service, vocabulary, groups, type conversion, category sets, `prepareProductAttributeValueRows` and the projection-refresh helpers.
- Layer L0: the domain imports no other domain. `product-admin` and `store-transfer` import it.

## Owns

| Table | Notes |
|-------|-------|
| `product_attributes` | Definition: `slug`, `value_type` (`text`, `number`, `boolean`, `enum`), `unit` (number only), `facet_display` (`range` only on number, `swatch` only on enum), `key_spec`, `highlight`, `group_id`, `filterable`. Code never reads or writes the old `options` JSON column |
| `attribute_values` | Value vocabulary, id prefix `atv_`. `normalized_value` is `lower(trim(value))` (column CHECK). A live row is unique per `(attribute_id, normalized_value)`. `swatch_hex` is lowercase `#rrggbb` |
| `attribute_groups` | Spec groups, id prefix `atg_`. A live name is unique, ignoring case |
| `category_attribute_sets` | One row per `(category_id, attribute_id)` with `sort_order` |

The domain also writes `product_attribute_values` (enum rows carry `value_id`, number and yes/no rows carry `value_number`, `value` stays the display text) and deletes an attribute's `product_facet_values` rows. The `products` domain owns both tables.

The domain declares no settings document and no `deps.*` reads. Triggers on its tables advance the DVC keys (`attr:`, `c:<categoryId>` for a category set, `p:<productId>` for product values).

## Routes

Admin routes are in `apps/api/src/routes/admin/attributes.ts` and `attributes-typed.ts` under `/api/v1/admin/attributes`. Permissions are in `packages/core/src/auth/rbac/route-permissions/catalog.ts` and `attributes-typed.ts` (`attributes.view`, `create`, `edit`, `delete`). Lists use page and limit paging, not cursors.

| Method and path | Note |
|-----------------|------|
| `GET /`, `GET /summaries`, `POST /` | List (with `valueCount`), bounded agent summaries, create |
| `PUT /{id}`, `DELETE /{id}`, `POST /{id}/restore`, `DELETE /{id}/permanent` | Update, trash, restore, permanent delete |
| `POST /bulk-delete`, `POST /bulk-restore` | At most 90 ids |
| `GET`, `POST`, `PUT`, `DELETE /{id}/values` | String-keyed values over product values and presets |
| `GET`, `POST /{id}/normalized-values`; `PUT .../order`; `PATCH`, `DELETE .../{valueId}` | Id-based vocabulary (`atv_`). Delete takes `mergeIntoValueId` |
| `POST /{id}/convert-type` | Value-type conversion, with `dryRun` |
| `GET`, `POST /groups`; `PUT /groups/order`; `PATCH`, `DELETE /groups/{groupId}` | Spec groups |
| `GET`, `PUT /category-sets/{categoryId}` | A category's effective set; replace its own set |

Public reads (`apps/api/src/routes/attributes.ts`: `/api/v1/attributes/category/{categoryId}`, `/category-slug/{categorySlug}`, `/search-filters`) return `catalog` facets for agents and tools. Storefront pages do not call them.

## Rules

- A write that changes `product_attribute_values` rows, or their facet key or label, takes a `CatalogProjectionRefresh`. The domain does not import `products`, so the API passes `catalogProjectionRefreshStatements`.
- Such a write runs in batches of at most 90 products. A batch holds the row writes, the aggregate revision bump and the projection refresh, so it commits whole or not at all.
- `valueType` changes only through `convertAttributeValueType`. It validates every value, switches the type, then rewrites rows in keyset chunks of 90 products. A repeated run continues with rows still in the wrong shape. A conversion first drops the attribute's facet rows, because they carry old-type keys.
- A number row is in shape only when its display text equals the canonical number plus the unit. A unit change through conversion rewrites the display text.
- Number and yes/no attributes have no vocabulary. An enum conversion creates at most 2,000 values. Any conversion refuses more than 50,000 distinct values.
- Deleting an enum value that products use is refused, unless the request names another live value of the same attribute to merge into.
- Trash and permanent delete are refused while any product value uses the attribute. A permanent delete removes the facet rows, the product values, the vocabulary and then the definition. Trashing a group ungroups its attributes in the same batch.
- Reserved slugs (`brand`, `category`, `search`, `q`, `page`, `limit`, `sort`, `ids`) are storefront query keys and cannot be attribute slugs.
- A category's effective set is its own rows plus every ancestor's, read through `category_closure`. The order key is `(3 - depth) * 100000 + sort_order`. The lowest key per attribute wins; ties sort by name. The facet reader in `catalog` uses the same rule.
