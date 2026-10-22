// The cart drawer's own words (CartFlyout) in English and Bangla, keyed by the
// page's language like lib/storefront-copy.ts. Both languages carry every key
// (cart-drawer-copy.test.ts fails otherwise), so a Bangla page never shows an
// English drawer. Counts and amounts arrive already formatted in the page's
// digits (formatCount, formatMoney); these functions only place them in words.
import { storefrontLanguage } from "./storefront-copy";
import { pageLanguage } from "./store-time-zone";

export interface CartDrawerCopy {
  title: string;
  /** The count badge's words for assistive technology: "3 items". */
  itemCount: (count: string, one: boolean) => string;
  close: string;
  describeAdded: (name: string, count?: string) => string;
  describe: string;
  added: string;
  /** The add was capped to what is left: "Added 40 (all that's left)". */
  addedLeft: (count: string) => string;
  soldOut: string;
  announceAdded: (name: string, items: string) => string;
  /** Several lines went in at once (Buy again): how many, not just the first one's name. */
  announceAddedMany: (count: string, items: string) => string;
  announceOutcome: (name: string, outcome: string, items: string) => string;
  empty: string;
  startShopping: string;
  edit: string;
  editItem: (name: string) => string;
  updateQuantity: (count: string) => string;
  remove: string;
  removed: (name: string) => string;
  decrease: (name: string) => string;
  increase: (name: string) => string;
  removeItem: (name: string) => string;
  undo: string;
  discount: string;
  /** An offer the cart qualifies for: "free" or "20% off". */
  offerFree: string;
  offerPercent: (percent: string) => string;
  add: string;
  view: string;
  fixToCheckout: string;
  estimatedTotal: string;
  subtotal: string;
  viewCart: string;
  checkout: string;
  continueShopping: string;
}

const EN: CartDrawerCopy = {
  title: "Cart",
  itemCount: (count, one) => `${count} ${one ? "item" : "items"}`,
  close: "Close cart",
  describeAdded: (name, count) => `${count ? `${count} products were` : `${name} was`} added to your cart. View your cart, check out, or continue shopping.`,
  describe: "Review cart items, change quantities, or continue to checkout.",
  added: "Added to your cart",
  addedLeft: (count) => `Added ${count} (all that's left)`,
  soldOut: "Sold out: nothing more could be added",
  announceAdded: (name, items) => `${name} added to your cart. Cart has ${items}.`,
  announceAddedMany: (count, items) => `${count} products added to your cart. Cart has ${items}.`,
  announceOutcome: (name, outcome, items) => `${name}: ${outcome}. Cart has ${items}.`,
  empty: "Cart is empty",
  startShopping: "Start shopping",
  edit: "Edit",
  editItem: (name) => `Edit ${name}`,
  updateQuantity: (count) => `Update quantity to ${count}`,
  remove: "Remove",
  removed: (name) => `${name} removed`,
  decrease: (name) => `Decrease ${name} quantity`,
  increase: (name) => `Increase ${name} quantity`,
  removeItem: (name) => `Remove ${name} from cart`,
  undo: "Undo",
  discount: "Discount",
  offerFree: "free",
  offerPercent: (percent) => `${percent} off`,
  add: "Add",
  view: "View",
  fixToCheckout: "Fix the highlighted items to check out.",
  estimatedTotal: "Estimated total (excl. shipping)",
  subtotal: "Subtotal (excl. shipping)",
  viewCart: "View cart",
  checkout: "Check out",
  continueShopping: "Continue shopping",
};

const BN: CartDrawerCopy = {
  title: "কার্ট",
  itemCount: (count) => `${count}টি পণ্য`,
  close: "কার্ট বন্ধ করুন",
  describeAdded: (name, count) => `${count ? `${count}টি পণ্য` : name} আপনার কার্টে যোগ হয়েছে। কার্ট দেখুন, চেকআউট করুন, অথবা কেনাকাটা চালিয়ে যান।`,
  describe: "কার্টের পণ্য দেখুন, পরিমাণ বদলান, অথবা চেকআউটে যান।",
  added: "আপনার কার্টে যোগ হয়েছে",
  addedLeft: (count) => `${count}টি যোগ হয়েছে (যা বাকি ছিল সব)`,
  soldOut: "স্টক শেষ: আর যোগ করা গেল না",
  announceAdded: (name, items) => `${name} আপনার কার্টে যোগ হয়েছে। কার্টে আছে ${items}।`,
  announceAddedMany: (count, items) => `${count}টি পণ্য আপনার কার্টে যোগ হয়েছে। কার্টে আছে ${items}।`,
  announceOutcome: (name, outcome, items) => `${name}: ${outcome}। কার্টে আছে ${items}।`,
  empty: "কার্ট খালি",
  startShopping: "কেনাকাটা শুরু করুন",
  edit: "বদলান",
  editItem: (name) => `${name} বদলান`,
  updateQuantity: (count) => `পরিমাণ ${count} করুন`,
  remove: "সরান",
  removed: (name) => `${name} সরানো হয়েছে`,
  decrease: (name) => `${name}-এর পরিমাণ কমান`,
  increase: (name) => `${name}-এর পরিমাণ বাড়ান`,
  removeItem: (name) => `কার্ট থেকে ${name} সরান`,
  undo: "ফিরিয়ে আনুন",
  discount: "ছাড়",
  offerFree: "ফ্রি",
  offerPercent: (percent) => `${percent} ছাড়`,
  add: "যোগ করুন",
  view: "দেখুন",
  fixToCheckout: "চেকআউট করতে চিহ্নিত পণ্যগুলো ঠিক করুন।",
  estimatedTotal: "আনুমানিক মোট (ডেলিভারি চার্জ ছাড়া)",
  subtotal: "সাবটোটাল (ডেলিভারি চার্জ ছাড়া)",
  viewCart: "কার্ট দেখুন",
  checkout: "চেকআউট",
  continueShopping: "কেনাকাটা চালিয়ে যান",
};

const COPY = { en: EN, bn: BN } as const;

/** The drawer's words in the page's language (Bangla on a Bangla page). */
export function cartDrawerCopy(language: string = pageLanguage()): CartDrawerCopy {
  return COPY[storefrontLanguage(language)];
}
