// The storefront's own words (English and Bangla) for the shared UI
// primitives (components/ui: Price, Badge, Stock, Rating, SectionHeader)
// and the product card. One catalogue, keyed by the store's language: the
// active checkout language's base code (the layout's
// `storefrontCopy.languageCode`), so a Bangla store never mixes English
// chrome into its pages. Slices that move more strings here add keys to
// both languages; the test fails when one language lacks a key.
import type { ProductCondition } from "@scalius/shared/product-condition";
import { CHROME_BN, CHROME_EN, type ChromeCopy } from "./chrome-copy";
import { SEARCH_PALETTE_BN, SEARCH_PALETTE_EN, type SearchPaletteCopy } from "./search-palette-copy";
import { SIGN_IN_BN, SIGN_IN_EN, type SignInCopy } from "./sign-in-copy";

import { priceCopy, type PriceCopy } from "./price-copy";
import type { StorefrontLanguage } from "./storefront-language";
export { storefrontLanguage, type StorefrontLanguage } from "./storefront-language";

export interface StorefrontCopy {
  price: PriceCopy;
  badge: { sale: string; soldOut: string; new: string };
  stock: {
    inStock: string;
    /** `count` in the page's digits. */
    low: (count: string) => string;
    soldOut: string;
    preOrder: string;
  };
  rating: {
    /** The whole rating for screen readers. */
    summary: (average: string, count: string, reviews: number) => string;
  };
  card: {
    addToCart: string;
    chooseOptions: string;
    viewProduct: string;
    colours: (names: string) => string;
    /** "+2" after the swatches, and its words (`count` in the page's digits). */
    moreColours: (count: string, colours: number) => string;
    /** The saved product condition, as the card's detail line names it. */
    condition: Record<ProductCondition, string>;
    freeDelivery: string;
    deliveryFrom: (fee: string) => string;
    /** The visually hidden heading over a grid of cards. */
    products: string;
  };
  section: {
    viewAll: string;
  };
  /** A product placed in a page or an article (the [product] shortcode). */
  productEmbed: {
    buyNow: string;
    /** Shown only in a theme preview, where a shortcode names a product the store does not have. */
    missingProduct: (reference: string) => string;
  };
  /** The short page a Buy now link shows while it adds the item and opens checkout (/buy/<slug>). */
  quickBuy: { title: string; preparing: string; failed: string; continue: string };
  /** Header, menus, drawers and footer (chrome-copy.ts). */
  chrome: ChromeCopy;
  /** The search palette (search-palette-copy.ts). */
  searchPalette: SearchPaletteCopy;
  /** The sign-in dialog (sign-in-copy.ts). */
  signIn: SignInCopy;
  /** The home page's sections, hero and carousels. */
  home: {
    /** Theme editor only: a section that draws nothing until the merchant fills it. */
    emptyHero: { title: string; text: string };
    emptySection: { title: string; text: string };
    featured: string;
    slideOf: (position: number, total: number) => string;
    goToSlide: (position: number) => string;
    previousSlide: string;
    nextSlide: string;
    pauseSlides: string;
    playSlides: string;
    banner: (position: number) => string;
    promotion: (position: number) => string;
    promotions: string;
    whyShop: string;
    notices: string;
    aboutStore: string;
    shopByCategory: string;
    viewMore: string;
    shopAll: string;
    newArrivals: string;
    onSale: string;
    popular: string;
    moreToExplore: string;
    endsIn: string;
    endsOn: (date: string) => string;
    previousProducts: (title: string) => string;
    nextProducts: (title: string) => string;
    shopByBrand: string;
    questions: string;
    ourStory: string;
    highlights: string;
    customersSay: string;
    storeServices: string;
    shopBy: string;
    loadMore: string;
  };
}

const EN: StorefrontCopy = {
  price: priceCopy("en"),
  badge: { sale: "Sale", soldOut: "Sold out", new: "New" },
  stock: {
    inStock: "In stock",
    low: (count) => `Only ${count} left`,
    soldOut: "Sold out",
    preOrder: "Pre-order",
  },
  rating: {
    summary: (average, count, reviews) => `Rated ${average} out of 5 from ${count} ${reviews === 1 ? "review" : "reviews"}`,
  },
  card: {
    addToCart: "Add to cart",
    chooseOptions: "Choose options",
    viewProduct: "View product",
    colours: (names) => `Colours: ${names}`,
    moreColours: (count, colours) => `${count} more ${colours === 1 ? "colour" : "colours"}`,
    condition: { new: "New", refurbished: "Refurbished", used: "Used" },
    freeDelivery: "Free delivery",
    deliveryFrom: (fee) => `Delivery from ${fee}`,
    products: "Products",
  },
  section: {
    viewAll: "View all",
  },
  productEmbed: {
    buyNow: "Buy now",
    missingProduct: (reference) => `This page names a product the store does not have ("${reference}"). Buyers see nothing here: fix or remove the [product] shortcode.`,
  },
  quickBuy: {
    title: "Adding to cart…",
    preparing: "Adding to cart and preparing checkout…",
    failed: "Could not prepare quick buy. Returning to cart…",
    continue: "Continue to checkout",
  },
  chrome: CHROME_EN,
  searchPalette: SEARCH_PALETTE_EN,
  signIn: SIGN_IN_EN,
  home: {
    emptyHero: {
      title: "Add a slide to show this hero",
      text: "A hero with no slides shows nothing on your store. Add a slide with a photo in this section's settings.",
    },
    emptySection: {
      title: "This section has nothing to show yet",
      text: "Buyers don't see it until you add its content in this section's settings.",
    },
    featured: "Featured",
    slideOf: (position, total) => `${position} of ${total}`,
    goToSlide: (position) => `Go to slide ${position}`,
    previousSlide: "Previous slide",
    nextSlide: "Next slide",
    pauseSlides: "Pause slideshow",
    playSlides: "Play slideshow",
    banner: (position) => `Banner ${position}`,
    promotion: (position) => `Promotion ${position}`,
    promotions: "Promotions",
    whyShop: "Why shop with us",
    notices: "Store notices",
    aboutStore: "About the store",
    shopByCategory: "Shop by category",
    viewMore: "View more",
    shopAll: "Shop all",
    newArrivals: "New arrivals",
    onSale: "On sale",
    popular: "Popular right now",
    moreToExplore: "More to explore",
    endsIn: "Ends in",
    endsOn: (date) => `Ends ${date}`,
    previousProducts: (title) => `Previous products in ${title}`,
    nextProducts: (title) => `Next products in ${title}`,
    shopByBrand: "Shop by brand",
    questions: "Questions and answers",
    ourStory: "Our story",
    highlights: "Highlights",
    customersSay: "What customers say",
    storeServices: "Store services",
    shopBy: "Shop by",
    loadMore: "Load more",
  },
};

const BN: StorefrontCopy = {
  price: priceCopy("bn"),
  badge: { sale: "সেল", soldOut: "স্টক শেষ", new: "নতুন" },
  stock: {
    inStock: "স্টকে আছে",
    low: (count) => `মাত্র ${count}টি বাকি`,
    soldOut: "স্টক শেষ",
    preOrder: "প্রি-অর্ডার",
  },
  rating: {
    summary: (average, count) => `৫-এর মধ্যে ${average} রেটিং, ${count}টি রিভিউ`,
  },
  card: {
    addToCart: "কার্টে যোগ করুন",
    chooseOptions: "অপশন বেছে নিন",
    viewProduct: "পণ্যটি দেখুন",
    colours: (names) => `রং: ${names}`,
    moreColours: (count) => `আরও ${count}টি রং`,
    condition: { new: "নতুন", refurbished: "রিফার্বিশড", used: "ব্যবহৃত" },
    freeDelivery: "ফ্রি ডেলিভারি",
    deliveryFrom: (fee) => `ডেলিভারি ${fee} থেকে`,
    products: "পণ্যসমূহ",
  },
  section: {
    viewAll: "সব দেখুন",
  },
  productEmbed: {
    buyNow: "এখনই কিনুন",
    missingProduct: (reference) => `এই পেজে এমন একটি পণ্যের নাম আছে যা স্টোরে নেই ("${reference}")। ক্রেতারা এখানে কিছু দেখবেন না: পণ্যের শর্টকোডটি ঠিক করুন বা মুছে দিন।`,
  },
  quickBuy: {
    title: "কার্টে যোগ হচ্ছে…",
    preparing: "কার্টে যোগ করে চেকআউট প্রস্তুত করা হচ্ছে…",
    failed: "এখনই কেনা প্রস্তুত করা যায়নি। কার্টে ফিরে যাওয়া হচ্ছে…",
    continue: "চেকআউটে যান",
  },
  chrome: CHROME_BN,
  searchPalette: SEARCH_PALETTE_BN,
  signIn: SIGN_IN_BN,
  home: {
    emptyHero: {
      title: "এই হিরো দেখাতে একটি স্লাইড যোগ করুন",
      text: "স্লাইড ছাড়া হিরো আপনার স্টোরে কিছুই দেখায় না। এই সেকশনের সেটিংসে ছবিসহ একটি স্লাইড যোগ করুন।",
    },
    emptySection: {
      title: "এই সেকশনে এখনো দেখানোর কিছু নেই",
      text: "এই সেকশনের সেটিংসে কনটেন্ট যোগ না করা পর্যন্ত ক্রেতারা এটি দেখবেন না।",
    },
    featured: "বিশেষ আয়োজন",
    slideOf: (position, total) => `${total}-এর ${position} নম্বর`,
    goToSlide: (position) => `${position} নম্বর স্লাইডে যান`,
    previousSlide: "আগের স্লাইড",
    nextSlide: "পরের স্লাইড",
    pauseSlides: "স্লাইডশো থামান",
    playSlides: "স্লাইডশো চালান",
    banner: (position) => `ব্যানার ${position}`,
    promotion: (position) => `প্রচার ${position}`,
    promotions: "অফার",
    whyShop: "কেন আমাদের থেকে কিনবেন",
    notices: "স্টোরের জানানি",
    aboutStore: "স্টোর সম্পর্কে",
    shopByCategory: "ক্যাটাগরি অনুযায়ী কিনুন",
    viewMore: "আরও দেখুন",
    shopAll: "সব কিনুন",
    newArrivals: "নতুন পণ্য",
    onSale: "ছাড়ে পণ্য",
    popular: "এখন জনপ্রিয়",
    moreToExplore: "আরও দেখুন",
    endsIn: "শেষ হতে বাকি",
    endsOn: (date) => `শেষ ${date}`,
    previousProducts: (title) => `${title}: আগের পণ্য`,
    nextProducts: (title) => `${title}: পরের পণ্য`,
    shopByBrand: "ব্র্যান্ড অনুযায়ী কিনুন",
    questions: "প্রশ্ন ও উত্তর",
    ourStory: "আমাদের গল্প",
    highlights: "বিশেষত্ব",
    customersSay: "ক্রেতারা যা বলেন",
    storeServices: "স্টোরের সেবা",
    shopBy: "ধরন অনুযায়ী কিনুন",
    loadMore: "আরও পণ্য দেখুন",
  },
};

const COPY: Record<StorefrontLanguage, StorefrontCopy> = { en: EN, bn: BN };

export function storefrontCopy(language: StorefrontLanguage): StorefrontCopy {
  return COPY[language];
}
