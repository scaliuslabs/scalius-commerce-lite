// The words of the listing, product page and empty cart that are not in the
// checkout language catalogue (English and Bangla), keyed by the store's
// language like lib/storefront-copy.ts. Both languages carry every key, so a
// Bangla store never mixes English into these parts.
import { storefrontLanguage, type StorefrontLanguage } from "./storefront-copy";

export interface ShopCopy {
  description: {
    readMore: string;
    readLess: string;
    /** Read by assistive technology after the button's words: "about Women". */
    about: (name: string) => string;
  };
  product: {
    soldOutNote: string;
    seeSimilar: string;
    /** The stock line beside the price; "sold out" is the checkout language's. */
    stock: { inStock: string; lowStock: string };
    showAllPhotos: (count: number) => string;
    zoomPhoto: string;
    morePhotos: (count: number) => string;
  };
  cart: {
    popularNow: string;
    shopByCategory: string;
  };
}

const EN: ShopCopy = {
  description: {
    readMore: "Read more",
    readLess: "Read less",
    about: (name) => `about ${name}`,
  },
  product: {
    soldOutNote: "This item is sold out right now.",
    seeSimilar: "See similar items",
    stock: { inStock: "In stock", lowStock: "Low stock" },
    showAllPhotos: (count) => `Show all photos (${count})`,
    zoomPhoto: "Zoom photo",
    morePhotos: (count) => `${count} more photos`,
  },
  cart: {
    popularNow: "Popular now",
    shopByCategory: "Shop by category",
  },
};

const BN: ShopCopy = {
  description: {
    readMore: "আরও পড়ুন",
    readLess: "কম দেখান",
    about: (name) => `${name} সম্পর্কে`,
  },
  product: {
    soldOutNote: "এই পণ্যটি এখন স্টকে নেই।",
    seeSimilar: "একই ধরনের পণ্য দেখুন",
    stock: { inStock: "স্টকে আছে", lowStock: "স্টক কম" },
    showAllPhotos: (count) => `সব ছবি দেখুন (${count})`,
    zoomPhoto: "ছবি বড় করুন",
    morePhotos: (count) => `আরও ${count}টি ছবি`,
  },
  cart: {
    popularNow: "এখন জনপ্রিয়",
    shopByCategory: "ক্যাটাগরি অনুযায়ী কিনুন",
  },
};

export function shopCopy(language: StorefrontLanguage | string | null | undefined): ShopCopy {
  return (language === "bn" || storefrontLanguage(language) === "bn") ? BN : EN;
}
