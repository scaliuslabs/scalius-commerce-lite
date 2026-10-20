// The words of the catalog pages (listings, search, the category directory,
// breadcrumbs and the product page's own controls) that are not in the
// checkout language catalogue, keyed by the store's language like
// lib/storefront-copy.ts. Both languages carry every key (the test fails
// otherwise), so a Bangla store never mixes English into these pages.
// Counts and amounts arrive formatted in the page's digits (formatCount,
// formatMoney); these functions only place them in words.
import { storefrontLanguage, type StorefrontLanguage } from "./storefront-copy";

type Count = string | number;

export interface CatalogCopy {
  breadcrumb: { label: string; home: string };
  directory: {
    title: string;
    description: (names: string, more: boolean) => string;
    emptyDescription: string;
    counts: (departments: Count, categories: Count) => string;
    departments: string;
    empty: string;
    browseAll: string;
    truncated: string;
  };
  search: {
    resultsTitle: string;
    allProducts: string;
    searchProducts: string;
    /** "Search results for “linen”" (the query arrives without quotes). */
    resultsFor: (query: string) => string;
    /** "12 results for “linen”". */
    countFor: (count: string, query: string) => string;
    results: (count: string, one: boolean) => string;
    page: (page: Count) => string;
    describeAll: string;
    noExact: (query: string) => string;
    showingFor: string;
    noResultsFor: (query: string) => string;
    noMatching: string;
    tryFewerFilters: string;
    trySpelling: string;
    emptyStore: string;
    showAllFor: (query: string) => string;
    removeFilters: string;
    browseCategories: string;
    browseAll: string;
    chip: (query: string) => string;
  };
  listing: {
    /** "12 products". */
    products: (count: string, one: boolean) => string;
    searchCategory: string;
    searchCollection: string;
    /** "Search Aarong": a brand's own listing. */
    searchIn: (name: string) => string;
    filters: string;
    filter: string;
    closeFilters: string;
    /** Read after a filter count: "2 applied". */
    applied: string;
    productFilters: string;
    popularFilters: string;
    quickFilters: string;
    categories: string;
    subCategories: string;
    all: string;
    moreFrom: (name: string) => string;
    thisListing: string;
    showPrevious: string;
    choices: (name: string) => string;
    about: (name: string) => string;
    guide: (name: string) => string;
    browseIn: (name: string) => string;
    /** The meta description of a listing the merchant has not described: "Shop Shoes." / "Shop Shoes: A, B and C." */
    metaShop: (name: string, list: string | null) => string;
    /** Some of the listing's products, then more: "A, B and more". */
    metaAndMore: (shown: string) => string;
    emptyTitle: string;
    emptyFiltered: string;
    emptyDescription: string;
    clearFilters: string;
    browseProducts: string;
  };
  sort: {
    sortProducts: string;
    perPage: string;
    sortBy: string;
    show: string;
    bestMatch: string;
    latest: string;
    featured: string;
    priceLowHigh: string;
    priceHighLow: string;
    nameAZ: string;
    nameZA: string;
    biggestDiscount: string;
    topRated: string;
  };
  view: { showAs: string; grid: string; list: string };
  paging: {
    label: string;
    previous: string;
    next: string;
    page: (page: Count) => string;
    of: (total: Count) => string;
    loadMore: string;
    loading: string;
    /** "Showing 21–40 of 484 products". */
    progress: (from: string, to: string, total: string, one: boolean) => string;
  };
  filters: {
    availability: string;
    inStockOnly: string;
    onSale: string;
    freeDelivery: string;
    inStock: string;
    customerRating: string;
    andUp: string;
    starsAndUp: (stars: Count) => string;
    anyRating: string;
    price: string;
    minimumPrice: string;
    maximumPrice: string;
    minPrice: string;
    maxPrice: string;
    from: string;
    to: string;
    go: string;
    apply: (name: string) => string;
    applyPrice: string;
    upTo: (amount: string) => string;
    fromAmount: (amount: string) => string;
    seeMore: (count: Count) => string;
    seeLess: string;
    searchIn: (name: string) => string;
    noMatches: string;
    moreFilters: string;
    clearAll: string;
    applyFilters: string;
    /** Read after a count: ", 2 selected". */
    selected: (count: Count) => string;
    /** The phone sheet's button: "Show 12 products". */
    showProducts: (count: string, one: boolean) => string;
    showProductsPlain: string;
    noMatchingProducts: string;
    filterBy: string;
    appliedFilters: string;
    remove: (label: string) => string;
  };
  product: {
    increaseQuantity: string;
    decreaseQuantity: string;
    zoom: string;
    zoomedView: (name: string) => string;
    zoomedImage: string;
    imageZoom: string;
    closeZoom: string;
    zoomHint: string;
    sections: string;
    description: string;
    details: string;
    reviews: string;
    keyFeatures: string;
    similar: string;
    top: string;
    deliveryFacts: string;
  };
  delivery: {
    free: string;
    freeDelivery: string;
    freeDetail: string;
    calculated: string;
    calculatedDetail: string;
    freeInSomeAreas: string;
    from: (amount: string) => string;
    dependsOnArea: string;
    freeOver: (amount: string) => string;
    freeOverLower: (amount: string) => string;
    single: (fee: string) => string;
    range: (min: string, max: string) => string;
    method: (name: string, fee: string) => string;
    pickupFrom: (amount: string) => string;
    pickupPoints: (count: string) => string;
    cashOnDelivery: string;
    payOnService: string;
    payAdvance: string;
    payOnArrival: string;
    finalSale: string;
    returnsAccepted: string;
    dayReturns: (days: string) => string;
    noReturns: string;
    freeReturn: string;
    buyerPaysReturn: string;
  };
}

const EN: CatalogCopy = {
  breadcrumb: { label: "Breadcrumb", home: "Home" },
  directory: {
    title: "All categories",
    description: (names, more) => `Shop ${names}${more ? " and more" : ""}.`,
    emptyDescription: "Browse every category in the store.",
    counts: (departments, categories) => `${departments} departments · ${categories} categories`,
    departments: "Departments",
    empty: "No categories yet.",
    browseAll: "Browse all products",
    truncated: "Deeper categories are listed on each department's page.",
  },
  search: {
    resultsTitle: "Search results",
    allProducts: "All products",
    searchProducts: "Search products",
    resultsFor: (query) => `Search results for “${query}”`,
    countFor: (count, query) => `${count} for “${query}”`,
    results: (count, one) => `${count} ${one ? "result" : "results"}`,
    page: (page) => ` – Page ${page}`,
    describeAll: "Explore our full collection of products.",
    noExact: (query) => `No exact results for “${query}”.`,
    showingFor: "Showing results for",
    noResultsFor: (query) => `No results for “${query}”`,
    noMatching: "No matching products",
    tryFewerFilters: "Try removing a filter or widening the price range.",
    trySpelling: "Check the spelling, use fewer words, or try a more general word.",
    emptyStore: "This store does not have any products available yet.",
    showAllFor: (query) => `Show all results for “${query}”`,
    removeFilters: "Remove filters",
    browseCategories: "Browse categories",
    browseAll: "Browse all products",
    chip: (query) => `Search: “${query}”`,
  },
  listing: {
    products: (count, one) => `${count} ${one ? "product" : "products"}`,
    searchCategory: "Search this category",
    searchCollection: "Search this collection",
    searchIn: (name) => `Search ${name}`,
    filters: "Filters",
    filter: "Filter",
    closeFilters: "Close filters",
    applied: "applied",
    productFilters: "Product filters",
    popularFilters: "Popular filters",
    quickFilters: "Quick filters",
    categories: "Categories",
    subCategories: "Sub-categories",
    all: "All",
    moreFrom: (name) => `More from ${name}`,
    thisListing: "this listing",
    showPrevious: "Show previous products",
    choices: (name) => `${name} choices`,
    about: (name) => `About ${name}`,
    guide: (name) => `${name} guide`,
    browseIn: (name) => `Browse products in ${name}`,
    metaShop: (name, list) => (list ? `Shop ${name}: ${list}.` : `Shop ${name}.`),
    metaAndMore: (shown) => `${shown} and more`,
    emptyTitle: "No products yet",
    emptyFiltered: "Try fewer filters or a broader price range.",
    emptyDescription: "Explore the rest of the catalog.",
    clearFilters: "Clear filters",
    browseProducts: "Browse products",
  },
  sort: {
    sortProducts: "Sort products",
    perPage: "Products per page",
    sortBy: "Sort by:",
    show: "Show:",
    bestMatch: "Best match",
    latest: "Latest",
    featured: "Featured",
    priceLowHigh: "Price: Low to High",
    priceHighLow: "Price: High to Low",
    nameAZ: "Name: A to Z",
    nameZA: "Name: Z to A",
    biggestDiscount: "Biggest discount",
    topRated: "Top rated",
  },
  view: { showAs: "Show products as", grid: "Grid", list: "List" },
  paging: {
    label: "Pagination",
    previous: "Previous page",
    next: "Next page",
    page: (page) => `Page ${page}`,
    of: (total) => `of ${total}`,
    loadMore: "Load more",
    loading: "Loading…",
    progress: (from, to, total, one) => `Showing ${from}–${to} of ${total} ${one ? "product" : "products"}`,
  },
  filters: {
    availability: "Availability",
    inStockOnly: "Exclude out of stock",
    onSale: "On sale",
    freeDelivery: "Free delivery",
    inStock: "In stock",
    customerRating: "Customer rating",
    andUp: "& up",
    starsAndUp: (stars) => `${stars} stars and up`,
    anyRating: "Any rating",
    price: "Price",
    minimumPrice: "Minimum price",
    maximumPrice: "Maximum price",
    minPrice: "Min price",
    maxPrice: "Max price",
    from: "From",
    to: "To",
    go: "Go",
    apply: (name) => `(apply ${name})`,
    applyPrice: "(apply price)",
    upTo: (amount) => `Up to ${amount}`,
    fromAmount: (amount) => `From ${amount}`,
    seeMore: (count) => `See more (${count})`,
    seeLess: "See less",
    searchIn: (name) => `Search ${name}`,
    noMatches: "No matches",
    moreFilters: "More filters",
    clearAll: "Clear all",
    applyFilters: "Apply filters",
    selected: (count) => `, ${count} selected`,
    showProducts: (count, one) => `Show ${count} ${one ? "product" : "products"}`,
    showProductsPlain: "Show products",
    noMatchingProducts: "No matching products",
    filterBy: "Filter by",
    appliedFilters: "Applied filters",
    remove: (label) => `Remove ${label} filter`,
  },
  product: {
    increaseQuantity: "Increase quantity",
    decreaseQuantity: "Decrease quantity",
    zoom: "Zoom",
    zoomedView: (name) => `${name} — zoomed view`,
    zoomedImage: "Zoomed product image",
    imageZoom: "Product image zoom",
    closeZoom: "Close image zoom",
    zoomHint: "Double tap to zoom • Drag to pan",
    sections: "Product sections",
    description: "Description",
    details: "Details",
    reviews: "Reviews",
    keyFeatures: "Key features",
    similar: "Similar",
    top: "Top",
    deliveryFacts: "Delivery, payment and returns",
  },
  delivery: {
    free: "free",
    freeDelivery: "Free delivery",
    freeDetail: "Delivery is free on any order with this item.",
    calculated: "Delivery calculated at checkout",
    calculatedDetail: "Price depends on your address and order.",
    freeInSomeAreas: "Free delivery in some areas",
    from: (amount) => `Delivery from ${amount}`,
    dependsOnArea: "Price depends on your area",
    freeOver: (amount) => `Free over ${amount}`,
    freeOverLower: (amount) => `free over ${amount}`,
    single: (fee) => `Delivery ${fee}`,
    range: (min, max) => `Delivery ${min}–${max}`,
    method: (name, fee) => `${name} ${fee}`,
    pickupFrom: (amount) => `from ${amount}`,
    pickupPoints: (count) => `${count} pickup points`,
    cashOnDelivery: "Cash on delivery",
    payOnService: "Pay on service",
    payAdvance: "Pay a small advance online, the rest on delivery.",
    payOnArrival: "Pay when your order arrives.",
    finalSale: "Final sale",
    returnsAccepted: "Returns accepted",
    dayReturns: (days) => `${days}-day returns`,
    noReturns: "Returns are not accepted.",
    freeReturn: "Free return shipping.",
    buyerPaysReturn: "Return shipping is paid by the buyer.",
  },
};

const BN: CatalogCopy = {
  breadcrumb: { label: "পেজের পথ", home: "হোম" },
  directory: {
    title: "সব ক্যাটাগরি",
    description: (names, more) => `${names}${more ? " এবং আরও" : ""} কিনুন।`,
    emptyDescription: "স্টোরের সব ক্যাটাগরি দেখুন।",
    counts: (departments, categories) => `${departments}টি বিভাগ · ${categories}টি ক্যাটাগরি`,
    departments: "বিভাগ",
    empty: "এখনো কোনো ক্যাটাগরি নেই।",
    browseAll: "সব পণ্য দেখুন",
    truncated: "আরও ভেতরের ক্যাটাগরি প্রতিটি বিভাগের পেজে আছে।",
  },
  search: {
    resultsTitle: "খোঁজের ফলাফল",
    allProducts: "সব পণ্য",
    searchProducts: "পণ্য খুঁজুন",
    resultsFor: (query) => `“${query}”-এর খোঁজের ফলাফল`,
    countFor: (count, query) => `“${query}”-এর জন্য ${count}`,
    results: (count) => `${count}টি ফলাফল`,
    page: (page) => ` – পেজ ${page}`,
    describeAll: "আমাদের সব পণ্য দেখুন।",
    noExact: (query) => `“${query}”-এর হুবহু কোনো ফলাফল নেই।`,
    showingFor: "যার ফলাফল দেখানো হচ্ছে:",
    noResultsFor: (query) => `“${query}”-এর কোনো ফলাফল নেই`,
    noMatching: "কোনো পণ্য মেলেনি",
    tryFewerFilters: "একটি ফিল্টার সরিয়ে বা দামের সীমা বাড়িয়ে দেখুন।",
    trySpelling: "বানান দেখুন, কম শব্দ লিখুন, বা আরও সাধারণ একটি শব্দ দিয়ে খুঁজুন।",
    emptyStore: "এই স্টোরে এখনো কোনো পণ্য নেই।",
    showAllFor: (query) => `“${query}”-এর সব ফলাফল দেখুন`,
    removeFilters: "ফিল্টার সরান",
    browseCategories: "ক্যাটাগরি দেখুন",
    browseAll: "সব পণ্য দেখুন",
    chip: (query) => `খোঁজ: “${query}”`,
  },
  listing: {
    products: (count) => `${count}টি পণ্য`,
    searchCategory: "এই ক্যাটাগরিতে খুঁজুন",
    searchCollection: "এই কালেকশনে খুঁজুন",
    searchIn: (name) => `${name}-এ খুঁজুন`,
    filters: "ফিল্টার",
    filter: "ফিল্টার",
    closeFilters: "ফিল্টার বন্ধ করুন",
    applied: "টি চালু",
    productFilters: "পণ্যের ফিল্টার",
    popularFilters: "জনপ্রিয় ফিল্টার",
    quickFilters: "দ্রুত ফিল্টার",
    categories: "ক্যাটাগরি",
    subCategories: "সাব-ক্যাটাগরি",
    all: "সব",
    moreFrom: (name) => `${name} থেকে আরও`,
    thisListing: "এই তালিকা",
    showPrevious: "আগের পণ্যগুলো দেখুন",
    choices: (name) => `${name}-এর বিকল্প`,
    about: (name) => `${name} সম্পর্কে`,
    guide: (name) => `${name} গাইড`,
    browseIn: (name) => `${name}-এর পণ্য দেখুন`,
    metaShop: (name, list) => (list ? `${name} কিনুন: ${list}।` : `${name} কিনুন।`),
    metaAndMore: (shown) => `${shown} ও আরও অনেক কিছু`,
    emptyTitle: "এখনো কোনো পণ্য নেই",
    emptyFiltered: "কম ফিল্টার বা আরও বড় দামের সীমা দিয়ে দেখুন।",
    emptyDescription: "স্টোরের বাকি পণ্যগুলো দেখুন।",
    clearFilters: "ফিল্টার মুছুন",
    browseProducts: "পণ্য দেখুন",
  },
  sort: {
    sortProducts: "পণ্য সাজান",
    perPage: "প্রতি পেজে পণ্য",
    sortBy: "সাজান:",
    show: "দেখান:",
    bestMatch: "সবচেয়ে মানানসই",
    latest: "নতুন",
    featured: "বাছাই করা",
    priceLowHigh: "দাম: কম থেকে বেশি",
    priceHighLow: "দাম: বেশি থেকে কম",
    nameAZ: "নাম: ক থেকে হ",
    nameZA: "নাম: হ থেকে ক",
    biggestDiscount: "সবচেয়ে বেশি ছাড়",
    topRated: "সেরা রেটিং",
  },
  view: { showAs: "পণ্য যেভাবে দেখাবে", grid: "গ্রিড", list: "তালিকা" },
  paging: {
    label: "পেজ",
    previous: "আগের পেজ",
    next: "পরের পেজ",
    page: (page) => `পেজ ${page}`,
    of: (total) => `মোট ${total}`,
    loadMore: "আরও দেখুন",
    loading: "লোড হচ্ছে…",
    progress: (from, to, total) => `${total}টির মধ্যে ${from}–${to} দেখানো হচ্ছে`,
  },
  filters: {
    availability: "প্রাপ্যতা",
    inStockOnly: "স্টকে নেই এমন বাদ দিন",
    onSale: "ছাড়ে আছে",
    freeDelivery: "ফ্রি ডেলিভারি",
    inStock: "স্টকে আছে",
    customerRating: "ক্রেতাদের রেটিং",
    andUp: "ও তার বেশি",
    starsAndUp: (stars) => `${stars} স্টার ও তার বেশি`,
    anyRating: "যেকোনো রেটিং",
    price: "দাম",
    minimumPrice: "সর্বনিম্ন দাম",
    maximumPrice: "সর্বোচ্চ দাম",
    minPrice: "সর্বনিম্ন দাম",
    maxPrice: "সর্বোচ্চ দাম",
    from: "সর্বনিম্ন",
    to: "সর্বোচ্চ",
    go: "যান",
    apply: (name) => `(${name} প্রয়োগ করুন)`,
    applyPrice: "(দাম প্রয়োগ করুন)",
    upTo: (amount) => `${amount} পর্যন্ত`,
    fromAmount: (amount) => `${amount} থেকে`,
    seeMore: (count) => `আরও দেখুন (${count})`,
    seeLess: "কম দেখুন",
    searchIn: (name) => `${name} খুঁজুন`,
    noMatches: "কিছু মেলেনি",
    moreFilters: "আরও ফিল্টার",
    clearAll: "সব মুছুন",
    applyFilters: "ফিল্টার প্রয়োগ করুন",
    selected: (count) => `, ${count}টি বাছাই করা`,
    showProducts: (count) => `${count}টি পণ্য দেখুন`,
    showProductsPlain: "পণ্য দেখুন",
    noMatchingProducts: "কোনো পণ্য মেলেনি",
    filterBy: "ফিল্টার করুন",
    appliedFilters: "চালু ফিল্টার",
    remove: (label) => `${label} ফিল্টার সরান`,
  },
  product: {
    increaseQuantity: "পরিমাণ বাড়ান",
    decreaseQuantity: "পরিমাণ কমান",
    zoom: "বড় করুন",
    zoomedView: (name) => `${name} — বড় করে দেখা`,
    zoomedImage: "বড় করা পণ্যের ছবি",
    imageZoom: "পণ্যের ছবি বড় করে দেখা",
    closeZoom: "বড় ছবি বন্ধ করুন",
    zoomHint: "বড় করতে দুবার ট্যাপ করুন • সরাতে টানুন",
    sections: "পণ্যের অংশ",
    description: "বিবরণ",
    details: "বিস্তারিত",
    reviews: "রিভিউ",
    keyFeatures: "মূল ফিচার",
    similar: "একই রকম",
    top: "উপরে",
    deliveryFacts: "ডেলিভারি, পেমেন্ট ও রিটার্ন",
  },
  delivery: {
    free: "ফ্রি",
    freeDelivery: "ফ্রি ডেলিভারি",
    freeDetail: "এই পণ্যসহ যেকোনো অর্ডারে ডেলিভারি ফ্রি।",
    calculated: "ডেলিভারি চার্জ চেকআউটে হিসাব হবে",
    calculatedDetail: "চার্জ আপনার ঠিকানা ও অর্ডারের ওপর নির্ভর করে।",
    freeInSomeAreas: "কিছু এলাকায় ফ্রি ডেলিভারি",
    from: (amount) => `ডেলিভারি ${amount} থেকে`,
    dependsOnArea: "চার্জ আপনার এলাকার ওপর নির্ভর করে",
    freeOver: (amount) => `${amount}-এর বেশি অর্ডারে ফ্রি`,
    freeOverLower: (amount) => `${amount}-এর বেশি অর্ডারে ফ্রি`,
    single: (fee) => `ডেলিভারি ${fee}`,
    range: (min, max) => `ডেলিভারি ${min}–${max}`,
    method: (name, fee) => `${name} ${fee}`,
    pickupFrom: (amount) => `${amount} থেকে`,
    pickupPoints: (count) => `${count}টি পিকআপ পয়েন্ট`,
    cashOnDelivery: "ক্যাশ অন ডেলিভারি",
    payOnService: "সেবা শেষে পরিশোধ",
    payAdvance: "অল্প অগ্রিম অনলাইনে দিন, বাকিটা ডেলিভারির সময়।",
    payOnArrival: "অর্ডার হাতে পেয়ে দাম দিন।",
    finalSale: "ফেরতযোগ্য নয়",
    returnsAccepted: "ফেরত নেওয়া হয়",
    dayReturns: (days) => `${days} দিনের মধ্যে ফেরত`,
    noReturns: "ফেরত নেওয়া হয় না।",
    freeReturn: "ফেরত পাঠানো ফ্রি।",
    buyerPaysReturn: "ফেরত পাঠানোর খরচ ক্রেতার।",
  },
};

export function catalogCopy(language: StorefrontLanguage | string | null | undefined): CatalogCopy {
  return storefrontLanguage(language) === "bn" ? BN : EN;
}
