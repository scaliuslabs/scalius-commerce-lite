// A digital SKU's stock is not typed in (packages/core/src/modules/digital/README.md):
// a licence-key SKU's quantity is its key pool, moved only by key import and
// revoke; a file SKU sells unlimited downloads. The editor shows that instead
// of a quantity field, and says when the SKU can't be sold yet.
import { queryOptions } from "@tanstack/react-query";
import { getApiV1AdminProductsByIdDigitalAssets } from "@scalius/api-client/sdk";
import { apiData } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import type { DigitalAssetDto } from "./digital-upload";

/** The Digital delivery card's id, for `revealCard()` (Inventory's "Add file" and "Import keys"). */
export const DIGITAL_CARD_ID = "product-digital";

export const digitalAssetsKey = (productId: string) => [...queryKeys.products.detail(productId), "digital-assets"] as const;

/** The product's files and licence-key pools (the Digital delivery card and the Inventory card share it). */
export const digitalAssetsQueryOptions = (productId: string) => queryOptions({
  queryKey: digitalAssetsKey(productId),
  queryFn: async (): Promise<DigitalAssetDto[]> =>
    (await apiData(getApiV1AdminProductsByIdDigitalAssets({ path: { id: productId } }))).assets,
});

type AssetFacts = Pick<DigitalAssetDto, "kind" | "status" | "variantId"> & { keys?: { available: number } | null };

export interface DigitalSkuStock {
  /** Licence keys still free in the SKU's ready pool, or null without one. */
  keys: number | null;
  /** A ready file delivers to this SKU (a product-wide file or its own). */
  file: boolean;
  /**
   * Checkout accepts the SKU: a ready file or a ready key pool, and no ready
   * pool that is empty. The same rule as `digitalDeliverableSql` in
   * packages/core/src/modules/digital/deliverable.ts.
   */
  sellable: boolean;
}

export function digitalSkuStock(variantId: string | null | undefined, assets: readonly AssetFacts[]): DigitalSkuStock {
  const ready = assets.filter((asset) => asset.status === "ready");
  const file = ready.some((asset) => asset.kind === "file" && (asset.variantId === null || asset.variantId === variantId));
  const pools = variantId ? ready.filter((asset) => asset.kind === "licence_keys" && asset.variantId === variantId) : [];
  const keys = pools.length > 0 ? pools.reduce((total, pool) => total + (pool.keys?.available ?? 0), 0) : null;
  const emptyPool = pools.some((pool) => (pool.keys?.available ?? 0) === 0);
  return { keys, file, sellable: (file || pools.length > 0) && !emptyPool };
}
