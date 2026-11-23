import { createContext, useContext } from "react";

/**
 * The product's SKUs that are bundles (kits): the product read's `isKit`,
 * then what the bundle card saves (`ProductForm`). A bundle holds no stock of
 * its own: the variant editor shows a note instead of its quantity and never
 * turns tracking on. Null outside the product editor (the variant editor then
 * reads its own SKUs' `isKit`).
 */
export const KitSkuIdsContext = createContext<ReadonlySet<string> | null>(null);

const NONE: ReadonlySet<string> = new Set();

/** The bundle SKUs as the editor knows them now. */
export const useKitSkuIds = () => useContext(KitSkuIdsContext) ?? NONE;

export const useIsKitSku = (variantId: string | undefined) => {
  const kits = useKitSkuIds();
  return variantId !== undefined && kits.has(variantId);
};
