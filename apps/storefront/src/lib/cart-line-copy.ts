// A cart line's repair actions and remove, in English and Bangla, for both cart
// surfaces (the drawer and the cart page), keyed by the page's language like
// cart-drawer-copy.ts. A control shows a short word ("Remove"); its name is the
// `...For` phrase, which holds that word unchanged and names the line
// (`cartLineName`), so a screen reader tells two lines apart and a voice user
// can say what they see. Counts arrive already in the page's digits.
import { storefrontLanguage } from "./storefront-language";
import { pageLanguage } from "./store-time-zone";

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
  /** A long answer's fold (lib/long-answer.ts): open it, close it. */
  answerMore: string;
  answerLess: string;
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
  answerMore: "Show more",
  answerLess: "Show less",
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
  answerMore: "আরও দেখুন",
  answerLess: "কম দেখুন",
};

const COPY = { en: EN, bn: BN } as const;

/** A cart line's action words in the page's language (Bangla on a Bangla page). */
export function cartLineCopy(language: string = pageLanguage()): CartLineCopy {
  return COPY[storefrontLanguage(language)];
}

/** Characters past which a buyer's answer folds (lib/long-answer.ts; about three lines at the drawer's width). */
export const LONG_ANSWER_CHARACTERS = 100;

/** Whether a buyer's answer is long enough to fold. */
export function isLongAnswer(text: string): boolean {
  return text.length > LONG_ANSWER_CHARACTERS || text.split("\n").length > 3;
}
