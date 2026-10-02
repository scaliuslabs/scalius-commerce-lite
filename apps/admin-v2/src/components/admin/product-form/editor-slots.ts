// Shopify's product page has an Inventory card (quantity, SKU, barcode) and a
// Shipping card (weight) between Pricing and Variants. A product without
// options keeps those fields in the variant editor's draft (one hidden SKU,
// one save), so the editor draws them into these two places in the page.
import { createContext, useContext } from "react";

export interface ProductEditorSlots {
  /** Where the Inventory card goes (after Pricing). */
  inventory: HTMLElement | null;
  /** Inside the Shipping card, under the Fulfilment select (the weight). */
  shipping: HTMLElement | null;
}

export const ProductEditorSlotsContext = createContext<ProductEditorSlots | null>(null);

/** Null outside the product page (the variant editor then draws the fields in place). */
export function useProductEditorSlots(): ProductEditorSlots | null {
  return useContext(ProductEditorSlotsContext);
}
