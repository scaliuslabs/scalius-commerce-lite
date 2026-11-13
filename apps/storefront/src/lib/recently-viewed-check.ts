/**
 * The "Recently viewed" check, run in the browser after the row has painted
 * (recently-viewed.ts draws it from localStorage before paint, so nothing
 * shifts). One public read asks which of the kept products are still public
 * (at most twelve product ids; nothing about the buyer), priced in the page's
 * market. Products it does not return are removed from the row and from
 * storage, and a row left empty is hidden; the others show today's price, as
 * a product card does (a stored price would go stale). If the read fails the list stays as it is: it is a convenience, and
 * a click on a gone product shows the normal 404. It loads when the browser is
 * idle and a row is shown (recently-viewed-client.ts), never with the page.
 */
import {
  RECENTLY_VIEWED_LIMIT,
  RECENTLY_VIEWED_STORAGE_KEY,
  pruneStoredRecentlyViewed,
  recentlyViewedGoneIds,
  recentlyViewedIds,
} from "@/lib/recently-viewed";

const CHECKED_ATTRIBUTE = "data-recently-viewed-checked";

/** A public product's price as a card shows it: what it costs now, and whether it varies by option. */
export interface RecentlyViewedPrice {
  current: number;
  from: boolean;
}

/** The public products among `ids` with their prices, or null when the read failed. */
export type PublicIdsReader = (ids: readonly string[]) => Promise<Map<string, RecentlyViewedPrice | null> | null>;

async function readPublicIds(ids: readonly string[]): Promise<Map<string, RecentlyViewedPrice | null> | null> {
  try {
    const { fetchProductsByIds } = await import("@/lib/api/browser-products");
    const response = await fetchProductsByIds(ids.join(","), RECENTLY_VIEWED_LIMIT);
    return response
      ? new Map(response.data.map((product) => [product.id, Number.isFinite(product.discountedPrice) && product.discountedPrice > 0
        ? { current: product.discountedPrice, from: product.priceVaries === true }
        : null]))
      : null;
  } catch {
    return null;
  }
}

/** Removes the gone products from every shown row; a row with none left is hidden. */
export function dropGoneFromRows(rows: Iterable<HTMLElement>, goneIds: ReadonlySet<string>): void {
  for (const row of rows) {
    for (const item of row.querySelectorAll<HTMLElement>("[data-recently-viewed-id]")) {
      if (goneIds.has(item.dataset.recentlyViewedId ?? "")) item.remove();
    }
    if (!row.querySelector("[data-recently-viewed-id]")) row.hidden = true;
  }
}

function storedEntries(): unknown[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(RECENTLY_VIEWED_STORAGE_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Checks the shown rows once; the reader is a parameter for tests. */
export async function checkRecentlyViewed(read: PublicIdsReader = readPublicIds): Promise<void> {
  const rows = [...document.querySelectorAll<HTMLElement>("[data-recently-viewed]")].filter(
    (row) => !row.hidden && !row.hasAttribute(CHECKED_ATTRIBUTE),
  );
  if (rows.length === 0) return;
  for (const row of rows) row.setAttribute(CHECKED_ATTRIBUTE, "");
  const ids = recentlyViewedIds(storedEntries());
  if (ids.length === 0) return;
  const prices = await read(ids);
  if (!prices) return;
  // The money and price words load with the answer (recently-viewed-prices.ts), never with the page.
  await import("@/lib/recently-viewed-prices").then(({ showRecentlyViewedPrices }) => showRecentlyViewedPrices(rows, prices), () => undefined);
  const gone = recentlyViewedGoneIds(ids, new Set(prices.keys()));
  if (gone.size === 0) return;
  dropGoneFromRows(rows, gone);
  try {
    pruneStoredRecentlyViewed(localStorage, gone);
  } catch {
    // Storage blocked: the row is already corrected for this view.
  }
}
