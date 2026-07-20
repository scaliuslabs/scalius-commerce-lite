import { MAX_LABEL_SKUS } from "./barcode-label-model";

export type BarcodeLabelSearch = {
  variants?: string;
};

export function normalizeBarcodeLabelVariantIds(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return Array.from(new Set(
    value.split(",").map((id) => id.trim()).filter((id) => /^var_[A-Za-z0-9_-]+$/.test(id)),
  )).slice(0, MAX_LABEL_SKUS);
}

export function validateBarcodeLabelSearch(
  search: Record<string, unknown>,
): BarcodeLabelSearch {
  const variants = normalizeBarcodeLabelVariantIds(search.variants);
  return variants.length > 0 ? { variants: variants.join(",") } : {};
}
