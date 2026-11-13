/**
 * Today's price under each "Recently viewed" tile, as a product card shows it
 * ("From" when it varies by option), in the page's money and words. Loaded by
 * the idle check (recently-viewed-check.ts) once the read has answered.
 */
import { formatMoney } from "@/lib/currency";
import { priceCopy } from "@/lib/price-copy";
import { pageLanguage } from "@/lib/store-time-zone";
import type { RecentlyViewedPrice } from "@/lib/recently-viewed-check";

/** Writes each kept product's price under its name. */
export function showRecentlyViewedPrices(rows: Iterable<HTMLElement>, prices: ReadonlyMap<string, RecentlyViewedPrice | null>): void {
  const words = priceCopy(pageLanguage());
  for (const row of rows) {
    for (const item of row.querySelectorAll<HTMLElement>("[data-recently-viewed-id]")) {
      const price = prices.get(item.dataset.recentlyViewedId ?? "");
      const slot = item.querySelector<HTMLElement>("[data-recently-viewed-price]");
      if (!slot || !price) continue;
      const amount = formatMoney(price.current);
      slot.textContent = price.from ? words.from(amount) : amount;
    }
  }
}
