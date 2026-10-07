// Route search validation runs in the dashboard entry: keep this file free of
// the label model, which brings barcode validation with it.
export const MAX_LABEL_SKUS = 150;

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
