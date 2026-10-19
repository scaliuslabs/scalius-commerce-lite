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
    /** One photo of a gallery list: "Zoom photo 2 of 4". */
    zoomPhotoOf: (position: number, total: number) => string;
    previousPhoto: string;
    nextPhoto: string;
    /** Where the phone gallery is, read out as it changes: "Photo 2 of 5" (placeholders allowed). */
    photoOf: (position: number | string, total: number | string) => string;
  };
  compare: {
    title: string;
    /** The empty state when a product page can start a comparison. */
    emptyHow: string;
    /** The empty state when nothing can start one. */
    empty: string;
    continueShopping: string;
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
    zoomPhotoOf: (position, total) => `Zoom photo ${position} of ${total}`,
    previousPhoto: "Previous photo",
    nextPhoto: "Next photo",
    photoOf: (position, total) => `Photo ${position} of ${total}`,
  },
  compare: {
    title: "Compare products",
    emptyHow: "Nothing to compare yet. Open a product and use its “Compare with similar items” section to see products side by side.",
    empty: "Nothing to compare yet.",
    continueShopping: "Continue shopping",
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
    zoomPhotoOf: (position, total) => `${total}টির মধ্যে ${position} নম্বর ছবি বড় করুন`,
    previousPhoto: "আগের ছবি",
    nextPhoto: "পরের ছবি",
    photoOf: (position, total) => `${total}টির মধ্যে ${position} নম্বর ছবি`,
  },
  compare: {
    title: "পণ্য তুলনা",
    emptyHow: "এখনো তুলনা করার কিছু নেই। একটি পণ্য খুলে তার তুলনার অংশ থেকে পণ্যগুলো পাশাপাশি দেখুন।",
    empty: "এখনো তুলনা করার কিছু নেই।",
    continueShopping: "কেনাকাটা চালিয়ে যান",
  },
  cart: {
    popularNow: "এখন জনপ্রিয়",
    shopByCategory: "ক্যাটাগরি অনুযায়ী কিনুন",
  },
};

export function shopCopy(language: StorefrontLanguage | string | null | undefined): ShopCopy {
  return (language === "bn" || storefrontLanguage(language) === "bn") ? BN : EN;
}
