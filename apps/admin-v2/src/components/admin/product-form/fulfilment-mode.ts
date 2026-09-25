// The product's Fulfilment select, read from its saved SKUs. Its own file so
// the editor route can set the form's first value without loading the option
// matrix editor's model before the page renders.
import type { ProductVariant } from "~/lib/api-query-options/products";

/**
 * What the product's SKUs are, from the product's Fulfilment select: all
 * physical, all digital, all services, or set per variant ("mixed", a
 * Fulfilment column).
 */
export type ProductFulfilmentMode = "physical" | "digital" | "service" | "mixed";
type EditableKind = Exclude<ProductFulfilmentMode, "mixed">;

/** The mode the saved SKUs are in. */
export function fulfilmentModeOf(variants: ReadonlyArray<Pick<ProductVariant, "fulfillmentKind" | "deletedAt">>): ProductFulfilmentMode {
  const kinds = new Set(variants.filter((variant) => !variant.deletedAt).map((variant) => variant.fulfillmentKind ?? "physical"));
  if (kinds.size === 0) return "physical";
  if (kinds.size === 1) return [...kinds][0] as EditableKind;
  return "mixed";
}
