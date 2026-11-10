// The host's words around an app's line inputs on a cart line (the cart page,
// the drawer and the no-script checkout): the choice control, the
// confirmation dialog and the bulk actions, in English and Bangla, keyed by
// the page's language like cart-line-copy.ts. The app's own words (the
// input's label, its choices, its agreement and its bulk labels) arrive
// already in the buyer's language from the cart check.
import { storefrontLanguage } from "./storefront-language";
import { pageLanguage } from "./store-time-zone";

export interface CartLineInputCopy {
  /** The empty choice of a select nobody has answered yet. */
  notChosen: string;
  /** A control's name: the input, then the line it is on. */
  inputFor: (input: string, line: string) => string;
  save: string;
  saveFor: (input: string, line: string) => string;
  /** A file input is answered on the product page. */
  editOnProduct: string;
  /** The confirmation dialog's defaults (an app may give its own title and tick-box words). */
  confirmTitle: string;
  agree: string;
  goBack: string;
  confirm: string;
  /** Said once a change is saved and the cart is being checked again. */
  updated: (count: string) => string;
  failed: string;
  /** No-script checkout: a choice that needs the tick box before it is taken. */
  confirmNeeded: string;
  /** Place order with undecided lines: the dialog's button that agrees and goes on. */
  continue: string;
  /** Above the items the agreement is taken for. */
  appliesTo: string;
  /** Phones: the lines that need a choice, shown above the folded order summary. */
  decisionsHeading: string;
  /** Place order with an item the buyer must choose for themselves. */
  chooseFirst: string;
  /** No-script checkout: undecided items, and how to go on without choosing. */
  undecided: string;
  agreeForAll: string;
}

const EN: CartLineInputCopy = {
  notChosen: "Not chosen",
  inputFor: (input, line) => `${input} for ${line}`,
  save: "Save",
  saveFor: (input, line) => `Save ${input} for ${line}`,
  editOnProduct: "Edit on the product page",
  confirmTitle: "Confirm your choice",
  agree: "I agree",
  goBack: "Go back",
  confirm: "Confirm",
  updated: (count) => `Updated ${count} ${count === "1" ? "item" : "items"}.`,
  failed: "This item couldn't be updated. Try again.",
  confirmNeeded: "Tick the box to agree before this choice is taken.",
  continue: "Continue",
  appliesTo: "For these items:",
  decisionsHeading: "Choose for these items before checkout",
  chooseFirst: "Choose an option for each item that asks for one before you place your order.",
  undecided: "Choose an option for each item marked below.",
  agreeForAll: "Or agree to this for every item still without a choice:",
};

const BN: CartLineInputCopy = {
  notChosen: "বেছে নেওয়া হয়নি",
  inputFor: (input, line) => `${line}-এর ${input}`,
  save: "সংরক্ষণ করুন",
  saveFor: (input, line) => `${line}-এর ${input} সংরক্ষণ করুন`,
  editOnProduct: "পণ্যের পাতায় বদলান",
  confirmTitle: "আপনার পছন্দ নিশ্চিত করুন",
  agree: "আমি সম্মত",
  goBack: "ফিরে যান",
  confirm: "নিশ্চিত করুন",
  updated: (count) => `${count}টি পণ্য হালনাগাদ হয়েছে।`,
  failed: "পণ্যটি হালনাগাদ করা যায়নি। আবার চেষ্টা করুন।",
  confirmNeeded: "এই পছন্দটি নিতে আগে বক্সে টিক দিয়ে সম্মতি দিন।",
  continue: "চালিয়ে যান",
  appliesTo: "এই পণ্যগুলোর জন্য:",
  decisionsHeading: "চেকআউটের আগে এই পণ্যগুলোর জন্য বেছে নিন",
  chooseFirst: "অর্ডার দেওয়ার আগে যেসব পণ্যে বেছে নিতে বলা হয়েছে, প্রতিটিতে একটি অপশন বেছে নিন।",
  undecided: "নিচে চিহ্নিত প্রতিটি পণ্যের জন্য একটি অপশন বেছে নিন।",
  agreeForAll: "অথবা যেসব পণ্যে এখনও বেছে নেওয়া হয়নি, সবগুলোর জন্য এতে সম্মতি দিন:",
};

const COPY = { en: EN, bn: BN } as const;

/** The line-input words in the page's language (Bangla on a Bangla page). */
export function cartLineInputCopy(language: string = pageLanguage()): CartLineInputCopy {
  return COPY[storefrontLanguage(language)];
}
