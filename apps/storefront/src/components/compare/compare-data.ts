/**
 * The comparison page's data: at most four public products and their specs
 * grouped by attribute group, from `GET /api/v1/products/compare` (one read
 * that joins the render's storefront batch). Ids come from the URL; they are
 * product ids, not personal data.
 */
import { getApiV1ProductsCompare } from "@scalius/api-client/sdk";
import { getConfiguredSdkClient } from "@/lib/api/transport";
import { unwrapData } from "@/lib/api/unwrap";

export const COMPARE_MAX = 4;
/** The compare list in the buyer's browser (the tray script). */
export const COMPARE_STORAGE_KEY = "scalius:compare";

export interface CompareProduct {
  id: string;
  name: string;
  slug: string;
  price: number;
  discountedPrice: number;
  priceVaries: boolean;
  hasVariants: boolean;
  availableForSale: boolean;
  brand: { id: string; name: string; slug: string } | null;
  imageUrl: string | null;
  imageAlt: string | null;
}

export interface CompareSpecRow {
  attributeId: string;
  name: string;
  values: Array<string | null>;
}

export interface CompareSpecGroup {
  id: string | null;
  name: string | null;
  rows: CompareSpecRow[];
}

export interface Comparison {
  products: CompareProduct[];
  groups: CompareSpecGroup[];
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

/** Up to four distinct, well-formed ids from `?ids=a,b`, in order. */
export function parseCompareIds(value: string | null): string[] {
  const ids: string[] = [];
  for (const raw of (value ?? "").split(",")) {
    const id = raw.trim();
    if (ID_PATTERN.test(id) && !ids.includes(id)) ids.push(id);
    if (ids.length === COMPARE_MAX) break;
  }
  return ids;
}

/**
 * Whether the row's values differ across the compared products (an empty
 * cell counts as a value), for highlighting.
 */
export function compareRowDiffers(values: ReadonlyArray<string | null>): boolean {
  const normalized = values.map((value) => (value ?? "").trim().toLowerCase());
  return new Set(normalized).size > 1;
}

/** The comparison, or null when the API cannot answer (the page says so). */
export async function getComparison(ids: readonly string[]): Promise<Comparison | null> {
  if (ids.length === 0) return { products: [], groups: [] };
  try {
    const { data, error } = await getApiV1ProductsCompare({
      client: getConfiguredSdkClient(),
      query: { ids: ids.join(",") },
    });
    if (error) {
      console.error("[Compare] read failed");
      return null;
    }
    const payload = unwrapData<Comparison>(data);
    return payload && Array.isArray(payload.products) && Array.isArray(payload.groups) ? payload : null;
  } catch {
    console.error("[Compare] read failed");
    return null;
  }
}
