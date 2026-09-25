// The public listing facet contract (catalog/facets.ts), shared by the
// product, category, collection, brand and attribute routes.
import { z } from "@hono/zod-openapi";
import { ATTRIBUTE_FACET_DISPLAYS } from "@scalius/shared/catalog-attributes";
import type { CatalogFacetFilter } from "@scalius/core/modules/products";

export const productFacetSchema = z.object({
  id: z.string().openapi({ description: "The attribute id, `option.<axis>`, `brand`, or `category`." }),
  name: z.string(),
  slug: z.string().openapi({
    description:
      "Query key for this facet: an attribute slug (with `<slug>.min` / `<slug>.max` for a range), `option.<axis>` for a product option such as Size, or `brand` (values are brand slugs). `category` is the category-tree facet: its values are category slugs to link to (a sub-category page), not a filter.",
  }),
  kind: z.enum(["attribute", "option", "brand", "category"]),
  display: z.enum(ATTRIBUTE_FACET_DISPLAYS).openapi({
    description: "The merchant's filter widget for attribute facets; `checkbox` for options and brands.",
  }),
  unit: z.string().nullable().openapi({ description: "Number attributes: the unit of the values and range bounds." }),
  values: z.array(z.object({
    value: z.string().openapi({ description: "The normalised URL value: lowercase text, a canonical number, `1`/`0`, or a brand slug." }),
    label: z.string(),
    count: z.number().int().min(0).openapi({ description: "Products matching the other facets' selections and this value." }),
    swatch: z.string().nullable().openapi({ description: "`#rrggbb` of an enum value, for swatch facets." }),
  })).max(500).openapi({ description: "At most 100 values (500 for brands), the most common first and every selected value kept." }),
  range: z.object({ min: z.number(), max: z.number() }).nullable().openapi({
    description: "`display: range` only: the value bounds over products matching the other selections; `values` is empty.",
  }),
});

export const appliedFacetFilterSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  values: z.array(z.string()),
  range: z.object({ min: z.number().nullable(), max: z.number().nullable() }).optional(),
});

/** The applied filters as echoed to the buyer (no internal value keys). */
export function appliedFacetFilters(filters: readonly CatalogFacetFilter[]): Array<z.infer<typeof appliedFacetFilterSchema>> {
  return filters.map(({ id, name, slug, values, range }) => ({ id, name, slug, values, ...(range ? { range } : {}) }));
}
