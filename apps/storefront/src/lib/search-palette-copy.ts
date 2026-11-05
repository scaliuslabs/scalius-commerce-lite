// The search palette's own words (components/search/CommandPalette.tsx) in
// English and Bangla. `storefront-copy.ts` carries this catalogue as its
// `searchPalette` entry; the language-parity test fails when one language
// lacks a key. Whole phrases take their parts as arguments, never
// concatenated, so Bangla word order and right-to-left pages read correctly.
// Counts arrive already in the page's digits (formatCount).

export interface SearchPaletteCopy {
  /** The dialog's name for assistive technology. */
  dialog: string;
  placeholder: string;
  input: string;
  close: string;
  /** The close button's visible word on a phone. */
  cancel: string;
  searching: string;
  unavailable: string;
  /** Read out once results arrive: "7 results". */
  results: (count: string, one: boolean) => string;
  start: string;
  failed: string;
  retry: string;
  noResultsFor: (query: string) => string;
  trySpelling: string;
  browseAll: string;
  /** The typed query matched nothing; these hits are for a corrected one. */
  showingInstead: (query: string, corrected: string) => string;
  products: string;
  categories: string;
  pages: string;
  viewAllFor: (query: string) => string;
  viewAll: string;
  /** The keyboard footer (shown only with a mouse or trackpad). */
  keys: { label: string; open: string; search: string; navigate: string; close: string };
}

export const SEARCH_PALETTE_EN: SearchPaletteCopy = {
  dialog: "Search catalogue",
  placeholder: "Search products…",
  input: "Search products",
  close: "Close search",
  cancel: "Cancel",
  searching: "Searching…",
  unavailable: "Search unavailable",
  results: (count, one) => `${count} ${one ? "result" : "results"}`,
  start: "Search products, categories, and pages",
  failed: "Couldn’t reach the store",
  retry: "Retry",
  noResultsFor: (query) => `No results for “${query}”`,
  trySpelling: "Check the spelling or try a more general word.",
  browseAll: "Browse all products",
  showingInstead: (query, corrected) => `No results for “${query}”. Showing results for “${corrected}”.`,
  products: "Products",
  categories: "Categories",
  pages: "Pages",
  viewAllFor: (query) => `View all results for “${query}”`,
  viewAll: "View all results",
  keys: {
    label: "Keyboard shortcuts",
    open: "to open",
    search: "to search",
    navigate: "to navigate",
    close: "to close",
  },
};

export const SEARCH_PALETTE_BN: SearchPaletteCopy = {
  dialog: "ক্যাটালগে খুঁজুন",
  placeholder: "পণ্য খুঁজুন…",
  input: "পণ্য খুঁজুন",
  close: "খোঁজ বন্ধ করুন",
  cancel: "বাতিল",
  searching: "খোঁজা হচ্ছে…",
  unavailable: "খোঁজ এখন চালু নেই",
  results: (count) => `${count}টি ফলাফল`,
  start: "পণ্য, ক্যাটাগরি ও পেজ খুঁজুন",
  failed: "স্টোরের সাথে যোগাযোগ করা যায়নি",
  retry: "আবার চেষ্টা করুন",
  noResultsFor: (query) => `“${query}”-এর কোনো ফলাফল নেই`,
  trySpelling: "বানান দেখুন, বা আরও সাধারণ একটি শব্দ দিয়ে খুঁজুন।",
  browseAll: "সব পণ্য দেখুন",
  showingInstead: (query, corrected) => `“${query}”-এর কোনো ফলাফল নেই। “${corrected}”-এর ফলাফল দেখানো হচ্ছে।`,
  products: "পণ্য",
  categories: "ক্যাটাগরি",
  pages: "পেজ",
  viewAllFor: (query) => `“${query}”-এর সব ফলাফল দেখুন`,
  viewAll: "সব ফলাফল দেখুন",
  keys: {
    label: "কিবোর্ড শর্টকাট",
    open: "খুলতে",
    search: "খুঁজতে",
    navigate: "ওপর-নিচে যেতে",
    close: "বন্ধ করতে",
  },
};
