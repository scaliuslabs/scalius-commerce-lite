// The words of the theme preview's own pages in the store's language: the
// preview canvas a merchant opens in a new tab (`/theme-preview`) and the
// notice a preview shows in place of a page it never draws (a buyer's own
// page). Staff read them, in the language the storefront resolves for the
// request, like the preview bar (`theme-preview-bar.ts`).
import { storefrontLanguage } from "./storefront-language";

export interface ThemePreviewCopy {
  documentTitle: string;
  title: string;
  /** The draft's and the published theme's revisions, already in the page's digits. */
  revisions: (draft: string, published: string) => string;
  width: string;
  devices: { full: string; desktop: string; mobile: string };
  exit: string;
  /** The frame's accessible name: the page it shows. */
  frameTitle: (path: string) => string;
  unavailableTitle: string;
  /** The API said the preview session is over (expired or revoked). */
  ended: string;
  /** The API gave no answer: the preview may still be live, so it stays open. */
  noAnswer: string;
  retry: string;
  openStore: string;
  dashboard: string;
  buyerPageTitle: string;
  buyerPage: string;
  notAPageTitle: string;
  notAPage: string;
  openHome: string;
  exitPreview: string;
}

const EN: ThemePreviewCopy = {
  documentTitle: "Storefront draft preview",
  title: "Draft preview",
  revisions: (draft, published) => `Draft r${draft} · published r${published}`,
  width: "Preview width",
  devices: { full: "Full", desktop: "Desktop", mobile: "Mobile" },
  exit: "Exit",
  frameTitle: (path) => `Storefront draft preview of ${path}`,
  unavailableTitle: "Draft preview unavailable",
  ended: "This preview expired or is no longer valid. Return to Theme settings and open a new preview.",
  noAnswer: "Your store didn't answer just now, so this preview is still open. Try again in a moment.",
  retry: "Try again",
  openStore: "Open the store",
  dashboard: "Back to the dashboard",
  buyerPageTitle: "This page can't be previewed",
  buyerPage: "Checkout, accounts, receipts and order tracking are each buyer's own pages, so a draft theme is never shown on them.",
  notAPageTitle: "This isn't a store page",
  notAPage: "The preview shows your store's pages. Open the home page to keep previewing.",
  openHome: "Open Home",
  exitPreview: "Exit preview",
};

const BN: ThemePreviewCopy = {
  documentTitle: "স্টোরফ্রন্টের খসড়া প্রিভিউ",
  title: "খসড়া প্রিভিউ",
  revisions: (draft, published) => `খসড়া r${draft} · প্রকাশিত r${published}`,
  width: "প্রিভিউয়ের প্রস্থ",
  devices: { full: "পূর্ণ", desktop: "ডেস্কটপ", mobile: "মোবাইল" },
  exit: "বন্ধ করুন",
  frameTitle: (path) => `${path} পেজের খসড়া প্রিভিউ`,
  unavailableTitle: "খসড়া প্রিভিউ পাওয়া যাচ্ছে না",
  ended: "এই প্রিভিউয়ের মেয়াদ শেষ হয়েছে বা এটি আর বৈধ নয়। থিম সেটিংসে ফিরে নতুন প্রিভিউ খুলুন।",
  noAnswer: "আপনার স্টোর এই মুহূর্তে সাড়া দেয়নি, তাই প্রিভিউটি এখনও খোলা আছে। একটু পরে আবার চেষ্টা করুন।",
  retry: "আবার চেষ্টা করুন",
  openStore: "স্টোর খুলুন",
  dashboard: "ড্যাশবোর্ডে ফিরে যান",
  buyerPageTitle: "এই পেজের প্রিভিউ দেখা যায় না",
  buyerPage: "চেকআউট, অ্যাকাউন্ট, রসিদ ও অর্ডার ট্র্যাকিং প্রতিটি ক্রেতার নিজস্ব পেজ, তাই এগুলোতে খসড়া থিম কখনো দেখানো হয় না।",
  notAPageTitle: "এটি স্টোরের কোনো পেজ নয়",
  notAPage: "প্রিভিউতে আপনার স্টোরের পেজগুলো দেখা যায়। প্রিভিউ চালিয়ে যেতে হোম পেজ খুলুন।",
  openHome: "হোম পেজ খুলুন",
  exitPreview: "প্রিভিউ বন্ধ করুন",
};

/** The preview's words in the store's language (Bangla for `bn…`, else English). */
export function themePreviewCopy(languageCode: unknown): ThemePreviewCopy {
  return storefrontLanguage(languageCode) === "bn" ? BN : EN;
}
