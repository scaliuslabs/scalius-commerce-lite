// The words of the notice a page shows when the store was updated after the
// page loaded and a part of it can no longer load (scripts/lazy-script.ts),
// in English and Bangla.
import { storefrontLanguage } from "./storefront-language";

export interface StalePageCopy {
  /** The store was updated: the part needs a reload. */
  updated: string;
  /** On checkout, where the typed details come back after a reload. */
  draftKept: string;
  /** The button that reloads the page. */
  reload: string;
}

const EN: StalePageCopy = {
  updated: "This page has been updated. Reload to continue.",
  draftKept: "Your checkout details stay filled in.",
  reload: "Reload",
};

const BN: StalePageCopy = {
  updated: "এই পেজটি হালনাগাদ হয়েছে। চালিয়ে যেতে পেজটি আবার লোড করুন।",
  draftKept: "আপনার চেকআউটের তথ্য পূরণ করা থাকবে।",
  reload: "আবার লোড করুন",
};

export function stalePageCopy(language: unknown): StalePageCopy {
  return storefrontLanguage(language) === "bn" ? BN : EN;
}
