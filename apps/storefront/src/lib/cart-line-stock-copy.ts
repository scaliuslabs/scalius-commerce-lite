/**
 * What a cart line says about its stock (`CartLineStock`, line-view.ts), the
 * same words on both cart surfaces, in English and Bangla: it holds every
 * unit there is, asks for more than is left (and what the subtotal counts of
 * it), sold out, or gone.
 */
import { cartLineCopy } from "./cart-line-copy";
import type { CartLineView } from "./cart/line-view";
import { storefrontLanguage } from "./storefront-language";
import { formatCount, pageLanguage } from "./store-time-zone";

interface StockWords {
  overLimit: (available: string, counted: string) => string;
  soldOut: string;
  unavailable: string;
}

const WORDS: Record<"en" | "bn", StockWords> = {
  en: {
    overLimit: (available, counted) => `Only ${available} left. The subtotal counts ${counted}.`,
    soldOut: "Sold out. The subtotal leaves it out.",
    unavailable: "No longer available. The subtotal leaves it out.",
  },
  bn: {
    overLimit: (available, counted) => `মাত্র ${available}টি আছে। সাবটোটালে ${counted}টি ধরা হয়েছে।`,
    soldOut: "স্টক শেষ। সাবটোটালে এটি ধরা হয়নি।",
    unavailable: "এটি আর পাওয়া যাচ্ছে না। সাবটোটালে এটি ধরা হয়নি।",
  },
};

/** The line's stock sentence in the page's language (counts in its digits), or null with nothing to say. */
export function cartLineStockText(view: Pick<CartLineView, "stock" | "countedQuantity">, language: string = pageLanguage()): string | null {
  const stock = view.stock;
  if (!stock) return null;
  const words = WORDS[storefrontLanguage(language)];
  switch (stock.state) {
    case "at-limit": return cartLineCopy(language).atLimit(formatCount(stock.available));
    case "over-limit": return words.overLimit(formatCount(stock.available), formatCount(view.countedQuantity));
    case "sold-out": return words.soldOut;
    case "unavailable": return words.unavailable;
  }
}
