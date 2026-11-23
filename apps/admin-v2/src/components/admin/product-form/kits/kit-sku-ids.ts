import { createContext, useContext, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { productKitsQueryOptions } from "../merchandising/section-api";

const NONE: ReadonlySet<string> = new Set();

/**
 * The product's SKUs that are bundles (kits), from the bundle card's own read
 * (one request for both). A bundle holds no stock of its own: the variant
 * editor shows a note instead of its quantity and never turns tracking on.
 */
export function useKitSkuIds(productId: string | undefined): ReadonlySet<string> {
  const { data } = useQuery({
    ...productKitsQueryOptions(productId ?? ""),
    enabled: Boolean(productId),
    select: (section) => section.items.map((item) => item.variantId).sort().join("\n"),
  });
  return useMemo(() => (data ? new Set(data.split("\n")) : NONE), [data]);
}

/** The bundle SKUs, for the variant table's rows and fields under the editor. */
export const KitSkuIdsContext = createContext<ReadonlySet<string>>(NONE);

export const useIsKitSku = (variantId: string | undefined) => {
  const kits = useContext(KitSkuIdsContext);
  return variantId !== undefined && kits.has(variantId);
};
