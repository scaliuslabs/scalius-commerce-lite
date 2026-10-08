// The storefront's own words (English and Bangla) for the shared UI
// primitives (components/ui: Price, Badge, Stock, Rating, SectionHeader)
// and the product card. One catalogue, keyed by the store's language: the
// active checkout language's base code (the layout's
// `storefrontCopy.languageCode`), so a Bangla store never mixes English
// chrome into its pages. Slices that move more strings here add keys to
// both languages; the test fails when one language lacks a key.
import { checkoutLanguageBaseCode } from "@scalius/shared/checkout-language";

export type StorefrontLanguage = "en" | "bn";

/** The store language the storefront speaks: Bangla for `bn…`, else English. */
export function storefrontLanguage(code: unknown): StorefrontLanguage {
  return checkoutLanguageBaseCode(code) === "bn" ? "bn" : "en";
}

export interface StorefrontCopy {
  price: {
    /** Visually hidden before a discounted price. */
    sale: string;
    /** Visually hidden before the struck regular price. */
    regular: string;
    /** Visually hidden before an undiscounted price. */
    price: string;
    /** A price that varies by option: "From ৳2,450". */
    from: (amount: string) => string;
    /** The saving beside a discounted price: "Save ৳600". */
    save: (amount: string) => string;
  };
  badge: { sale: string; soldOut: string; new: string };
  stock: {
    inStock: string;
    low: (count: number) => string;
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
    /** "+2" after the swatches, and its words. */
    moreColours: (count: number) => string;
    freeDelivery: string;
    deliveryFrom: (fee: string) => string;
    /** The visually hidden heading over a grid of cards. */
    products: string;
  };
  section: {
    viewAll: string;
  };
  /** The home page's sections, hero and carousels. */
  home: {
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
    viewAllOf: (title: string) => string;
  };
}

const EN: StorefrontCopy = {
  price: {
    sale: "Sale price",
    regular: "Regular price",
    price: "Price",
    from: (amount) => `From ${amount}`,
    save: (amount) => `Save ${amount}`,
  },
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
    moreColours: (count) => `${count} more ${count === 1 ? "colour" : "colours"}`,
    freeDelivery: "Free delivery",
    deliveryFrom: (fee) => `Delivery from ${fee}`,
    products: "Products",
  },
  section: {
    viewAll: "View all",
  },
  home: {
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
    viewAllOf: (title) => `View all ${title}`,
  },
};

const BN: StorefrontCopy = {
  price: {
    sale: "ছাড়ের দাম",
    regular: "নিয়মিত দাম",
    price: "দাম",
    from: (amount) => `${amount} থেকে`,
    save: (amount) => `${amount} সাশ্রয়`,
  },
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
    freeDelivery: "ফ্রি ডেলিভারি",
    deliveryFrom: (fee) => `ডেলিভারি ${fee} থেকে`,
    products: "পণ্যসমূহ",
  },
  section: {
    viewAll: "সব দেখুন",
  },
  home: {
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
    viewAllOf: (title) => `${title}: সব দেখুন`,
  },
};

const COPY: Record<StorefrontLanguage, StorefrontCopy> = { en: EN, bn: BN };

export function storefrontCopy(language: StorefrontLanguage): StorefrontCopy {
  return COPY[language];
}
