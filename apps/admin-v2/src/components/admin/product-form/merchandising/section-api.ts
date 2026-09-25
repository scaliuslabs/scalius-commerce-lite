import { queryOptions } from "@tanstack/react-query";
import {
  getApiV1AdminProductsByIdSectionsBySection,
  patchApiV1AdminProductsByIdSectionsBySection,
} from "@scalius/api-client/sdk";
import { apiData, type ApiBody, type ApiResult } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";

type SectionResult = ApiResult<typeof getApiV1AdminProductsByIdSectionsBySection>;
type SectionPatch = ApiBody<typeof patchApiV1AdminProductsByIdSectionsBySection>;
export type ProductSectionOf<S extends SectionResult["section"]> = Extract<SectionResult, { section: S }>;
export type ProductSectionPatchOf<S extends SectionPatch["section"]> = Extract<SectionPatch, { section: S }>;
export type ContentBlockItem = ProductSectionOf<"content_blocks">["items"][number];
export type ContentBlockMedia = ProductSectionOf<"content_blocks">["media"][number];
export type BundleItem = ProductSectionOf<"bundles">["items"][number];

export const productSectionKey = (productId: string, section: string) =>
  [...queryKeys.products.detail(productId), "section", section] as const;

async function readSection<S extends SectionResult["section"]>(
  productId: string,
  section: S,
  query: { offset?: number; limit?: number; itemId?: string } = {},
): Promise<ProductSectionOf<S>> {
  const data = await apiData(getApiV1AdminProductsByIdSectionsBySection({
    path: { id: productId, section },
    query: { offset: query.offset ?? 0, limit: query.limit ?? 20, ...(query.itemId ? { itemId: query.itemId } : {}) },
  }));
  return data as ProductSectionOf<S>;
}

/** The product's base facts the side card needs (template, EMI eligibility). */
export const productBaseSectionQueryOptions = (productId: string) =>
  queryOptions({
    queryKey: productSectionKey(productId, "base"),
    queryFn: () => readSection(productId, "base"),
    staleTime: 0,
  });

export const productBundlesQueryOptions = (productId: string) =>
  queryOptions({
    queryKey: productSectionKey(productId, "bundles"),
    queryFn: () => readSection(productId, "bundles"),
    staleTime: 0,
  });

/**
 * Every block of the product (at most 40, one page) with its settings: a
 * block too large for the list is read by chunks.
 */
export const productContentBlocksQueryOptions = (productId: string) =>
  queryOptions({
    queryKey: productSectionKey(productId, "content_blocks"),
    queryFn: async () => {
      const page = await readSection(productId, "content_blocks", { limit: 40 });
      const items = await Promise.all(page.items.map(async (item) => {
        if (item.settings) return item;
        let text = "";
        let offset: number | null = 0;
        while (offset !== null) {
          const chunk: ProductSectionOf<"content_block"> = await readSection(productId, "content_block", { itemId: item.id, offset });
          text += chunk.value;
          offset = chunk.nextOffset;
        }
        return { ...item, settings: JSON.parse(text) as Record<string, unknown> };
      }));
      return { ...page, items };
    },
    staleTime: 0,
  });

/** Writes one section under the product revision; resolves with the new revision. */
export async function saveProductSection(productId: string, body: SectionPatch): Promise<number> {
  const result = await apiData(patchApiV1AdminProductsByIdSectionsBySection({
    path: { id: productId, section: body.section },
    body,
  }));
  return (result as { aggregateRevision: number }).aggregateRevision;
}
