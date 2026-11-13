// A cart line's repair actions and remove, in English and Bangla, for both cart
// surfaces (the drawer and the cart page), keyed by the page's language like
// cart-drawer-copy.ts. A control shows a short word ("Remove"); its name is the
// `...For` phrase, which holds that word unchanged and names the line
// (`cartLineName`), so a screen reader tells two lines apart and a voice user
// can say what they see. Counts arrive already in the page's digits.
import { storefrontLanguage } from "./storefront-language";
import { formatCount, pageLanguage } from "./store-time-zone";
import type { CartLineView } from "./cart/line-view";

export interface CartLineCopy {
  updateQuantity: (count: string) => string;
  updateQuantityFor: (count: string, line: string) => string;
  refreshPrice: string;
  refreshPriceFor: (line: string) => string;
  editDetails: string;
  editDetailsFor: (line: string) => string;
  chooseOption: string;
  chooseOptionFor: (line: string) => string;
  remove: string;
  removeFor: (line: string) => string;
  /** The cart-wide repairs, each with how many lines it fixes. */
  removeUnavailable: (count: string) => string;
  updateQuantities: (count: string) => string;
  refreshPrices: (count: string) => string;
  /** A line its own discount pays in full (a free gift), as a screen reader hears its struck price and zero. */
  freeLine: (price: string) => string;
  /** After one unit's price on a line of several: "৳150 each". */
  each: string;
  /** The drawer's notes on how a line reaches the buyer (the cart page's are the checkout language's). */
  digital: string;
  service: string;
  shipsFree: string;
  /** Under a line that holds every unit the store can sell ("+" is off): said, not only heard. */
  atLimit: (count: string) => string;
  /** A line that asks for more than is left, and the units the subtotal counts of it. */
  overLimit: (available: string, counted: string) => string;
  /** A sold-out line, and that the subtotal leaves it out. */
  soldOut: string;
  /** A line whose product or option is gone, and that the subtotal leaves it out. */
  unavailable: string;
}

const EN: CartLineCopy = {
  updateQuantity: (count) => `Update quantity to ${count}`,
  updateQuantityFor: (count, line) => `Update quantity to ${count} for ${line}`,
  refreshPrice: "Refresh price",
  refreshPriceFor: (line) => `Refresh price for ${line}`,
  editDetails: "Edit details",
  editDetailsFor: (line) => `Edit details for ${line}`,
  chooseOption: "Choose option",
  chooseOptionFor: (line) => `Choose option for ${line}`,
  remove: "Remove",
  removeFor: (line) => `Remove ${line} from cart`,
  removeUnavailable: (count) => `Remove unavailable (${count})`,
  updateQuantities: (count) => `Update quantities (${count})`,
  refreshPrices: (count) => `Refresh prices (${count})`,
  freeLine: (price) => `Free, was ${price}`,
  each: "each",
  digital: "Digital item, no shipping",
  service: "Service, no shipping",
  shipsFree: "Ships free",
  atLimit: (count) => `Only ${count} available, all in your cart`,
  overLimit: (available, counted) => `Only ${available} left. The subtotal counts ${counted}.`,
  soldOut: "Sold out. The subtotal leaves it out.",
  unavailable: "No longer available. The subtotal leaves it out.",
};

const BN: CartLineCopy = {
  updateQuantity: (count) => `পরিমাণ ${count} করুন`,
  updateQuantityFor: (count, line) => `${line}-এর পরিমাণ ${count} করুন`,
  refreshPrice: "দাম হালনাগাদ করুন",
  refreshPriceFor: (line) => `${line}-এর দাম হালনাগাদ করুন`,
  editDetails: "বিবরণ বদলান",
  editDetailsFor: (line) => `${line}-এর বিবরণ বদলান`,
  chooseOption: "অপশন বেছে নিন",
  chooseOptionFor: (line) => `${line}-এর অপশন বেছে নিন`,
  remove: "সরান",
  removeFor: (line) => `কার্ট থেকে ${line} সরান`,
  removeUnavailable: (count) => `অনুপলভ্য পণ্য সরান (${count})`,
  updateQuantities: (count) => `পরিমাণ হালনাগাদ করুন (${count})`,
  refreshPrices: (count) => `দাম হালনাগাদ করুন (${count})`,
  freeLine: (price) => `ফ্রি, আগে ছিল ${price}`,
  each: "প্রতিটি",
  digital: "ডিজিটাল পণ্য, শিপিং লাগবে না",
  service: "সেবা, শিপিং লাগবে না",
  shipsFree: "ফ্রি ডেলিভারি",
  atLimit: (count) => `মাত্র ${count}টি আছে, সবগুলো আপনার কার্টে`,
  overLimit: (available, counted) => `মাত্র ${available}টি আছে। সাবটোটালে ${counted}টি ধরা হয়েছে।`,
  soldOut: "স্টক শেষ। সাবটোটালে এটি ধরা হয়নি।",
  unavailable: "এটি আর পাওয়া যাচ্ছে না। সাবটোটালে এটি ধরা হয়নি।",
};

const COPY = { en: EN, bn: BN } as const;

/** A cart line's action words in the page's language (Bangla on a Bangla page). */
export function cartLineCopy(language: string = pageLanguage()): CartLineCopy {
  return COPY[storefrontLanguage(language)];
}

/**
 * What a line says about its stock, the same words on both cart surfaces
 * (`CartLineStock`); null when there is nothing to say. Counts in the page's digits.
 */
export function cartLineStockText(view: Pick<CartLineView, "stock" | "countedQuantity">, copy: CartLineCopy = cartLineCopy()): string | null {
  const stock = view.stock;
  if (!stock) return null;
  switch (stock.state) {
    case "at-limit": return copy.atLimit(formatCount(stock.available));
    case "over-limit": return copy.overLimit(formatCount(stock.available), formatCount(view.countedQuantity));
    case "sold-out": return copy.soldOut;
    case "unavailable": return copy.unavailable;
  }
}
