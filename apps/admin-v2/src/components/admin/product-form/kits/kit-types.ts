import type { ProductRevisionConflict } from "~/lib/admin-api-conflicts";

/** One of the product's saved, live SKUs, as the bundle card lists it. */
export interface ProductSkuSummary {
  id: string;
  sku: string;
  /** Its option values ("Red / M"); empty for a product without options. */
  label: string;
}

/**
 * The product's aggregate revision for a section that saves on its own: the
 * revision to write against, what to do once a write moved it, and the
 * editor's stale-revision path (the conflict dialog), as the variant editor's
 * own save uses them.
 */
export interface ProductRevisionHandle {
  current: () => number | undefined;
  saved: (revision: number) => void;
  conflict: (conflict: ProductRevisionConflict) => void;
}

/** The product's live SKUs for the bundle card: its variants, or its one default SKU. */
export function productSkuSummaries(variants: ReadonlyArray<{
  id: string;
  sku?: string | null;
  isDefault?: boolean | null;
  deletedAt?: unknown;
  selectedOptions?: ReadonlyArray<{ value: string; position: number }>;
}>): ProductSkuSummary[] {
  const live = variants.filter((variant) => !variant.deletedAt);
  const withOptions = live.filter((variant) => !variant.isDefault);
  return (withOptions.length > 0 ? withOptions : live).map((variant) => ({
    id: variant.id,
    sku: variant.sku ?? "",
    label: [...(variant.selectedOptions ?? [])].sort((a, b) => a.position - b.position).map((option) => option.value).join(" / "),
  }));
}
