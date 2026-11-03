// B5 (warranty): the product page's warranty facts. `productWarranty` reads the
// product's `warranty` (the policy's current terms, from GET /products/{slug});
// `warrantySpecRow` is the specification table's "Warranty" row. Until the
// spec table lands (templates), the row renders in the classic description tab.
import type { Product, ProductVariant } from "@/lib/api";
import {
  warrantySummaryText,
  type WarrantyCopy,
  type WarrantyDurationUnit,
  type WarrantyProvider,
  type WarrantyTerms,
} from "@/lib/account-warranties";

/** `product.warranty` as the API sends it; null without a policy. */
export interface ProductWarrantyView {
  name: string;
  provider: WarrantyProvider;
  duration: { value: number; unit: WarrantyDurationUnit };
  replacementDays: number | null;
  terms: string | null;
}

/** The product's warranty, or null when it has none (or the field is malformed). */
export function productWarranty(product: Product): ProductWarrantyView | null {
  return parseWarranty(product.warranty);
}

/**
 * Each SKU's effective warranty (it inherits the product's, has its own, or
 * none): the page's `warranties` by id, and each variant's `warrantyId`.
 */
export function skuWarranties(product: Product, variants: readonly ProductVariant[]): {
  byId: Map<string, ProductWarrantyView>;
  byVariant: Record<string, string | null>;
} {
  const byId = new Map<string, ProductWarrantyView>();
  for (const entry of product.warranties ?? []) {
    const warranty = parseWarranty(entry);
    if (warranty) byId.set(entry.id, warranty);
  }
  const byVariant: Record<string, string | null> = {};
  for (const variant of variants) {
    const id = variant.warrantyId ?? null;
    byVariant[variant.id] = id !== null && byId.has(id) ? id : null;
  }
  return { byId, byVariant };
}

function parseWarranty(value: unknown): ProductWarrantyView | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<ProductWarrantyView>;
  const duration = raw.duration;
  if (
    typeof raw.name !== "string" || !raw.name.trim() ||
    (raw.provider !== "brand" && raw.provider !== "store") ||
    !duration || typeof duration.value !== "number" || !Number.isInteger(duration.value) || duration.value < 1 ||
    (duration.unit !== "days" && duration.unit !== "months" && duration.unit !== "years")
  ) {
    return null;
  }
  return {
    name: raw.name.trim(),
    provider: raw.provider,
    duration: { value: duration.value, unit: duration.unit },
    replacementDays: typeof raw.replacementDays === "number" && raw.replacementDays > 0 ? raw.replacementDays : null,
    terms: typeof raw.terms === "string" && raw.terms.trim() ? raw.terms.trim() : null,
  };
}

export function productWarrantyTerms(warranty: ProductWarrantyView): WarrantyTerms {
  return {
    provider: warranty.provider,
    durationValue: warranty.duration.value,
    durationUnit: warranty.duration.unit,
    replacementDays: warranty.replacementDays,
  };
}

/** The spec table's row: "Warranty · 1 year brand warranty · 7-day replacement". */
export function warrantySpecRow(product: Product, copy: WarrantyCopy): { label: string; value: string } | null {
  const warranty = productWarranty(product);
  return warranty
    ? { label: copy.warrantyLabelText, value: warrantySummaryText(productWarrantyTerms(warranty), copy) }
    : null;
}
