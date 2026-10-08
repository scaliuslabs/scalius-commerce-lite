// The storefront chrome's own words (header, menus, drawers, footer) in
// English and Bangla. `storefront-copy.ts` carries this catalogue as its
// `chrome` entry; the language-parity test fails when one language lacks a
// key. Whole phrases take their parts as arguments ("Call {phone}"), never
// concatenated, so Bangla word order and right-to-left pages read correctly.

export interface ChromeCopy {
  skipToContent: string;
  home: string;
  topBar: { trackOrder: string };
  header: {
    openMenu: string;
    closeMenu: string;
    search: string;
    searchProducts: string;
    /** The department select beside the search field. */
    searchIn: string;
    allScopes: string;
    account: string;
    cart: string;
    call: (phone: string) => string;
  };
  nav: {
    main: string;
    mobileMenu: string;
    mobileNavigation: string;
    menu: string;
    shopByDepartment: string;
    allCategories: string;
    allDepartments: string;
    more: string;
    categories: string;
    storeLinks: string;
    shortcuts: string;
    callSupport: string;
    trackOrder: string;
    social: string;
    /** The first row of a department's level: "All Shoes". */
    allOf: (title: string) => string;
    /** The link that ends a fly-out column: "Show all Shoes". */
    showAll: (title: string) => string;
    featuredIn: (title: string) => string;
    /** Names the button that opens a department's submenu. */
    submenu: (title: string) => string;
  };
  tabs: {
    label: string;
    home: string;
    categories: string;
    offers: string;
    compare: string;
    search: string;
    cart: string;
    account: string;
  };
  footer: {
    callUs: string;
    callUsLabel: string;
    messageUs: string;
    whatsapp: string;
    visitUs: string;
    support: string;
    stayConnected: string;
    policies: string;
    storePolicies: string;
    footerLinks: string;
    storeDirectory: string;
    customerCare: string;
    contactUs: string;
    aboutStore: (name: string) => string;
    about: string;
    hotline: string;
    trackOrder: string;
    backToTop: string;
    call: (phone: string) => string;
    showMoreLinks: (count: number, title: string) => string;
    hideExtraLinks: (title: string) => string;
    rights: (year: number, name: string) => string;
    rightsNoName: (year: number) => string;
    social: string;
  };
}

export const CHROME_EN: ChromeCopy = {
  skipToContent: "Skip to content",
  home: "Home",
  topBar: { trackOrder: "Track your order" },
  header: {
    openMenu: "Open menu",
    closeMenu: "Close menu",
    search: "Search",
    searchProducts: "Search products",
    searchIn: "Search in",
    allScopes: "All",
    account: "Account",
    cart: "Cart",
    call: (phone) => `Call ${phone}`,
  },
  nav: {
    main: "Main navigation",
    mobileMenu: "Mobile menu",
    mobileNavigation: "Mobile navigation",
    menu: "Menu",
    shopByDepartment: "Shop by department",
    allCategories: "All categories",
    allDepartments: "All departments",
    more: "More",
    categories: "Categories",
    storeLinks: "Store links",
    shortcuts: "Shortcuts",
    callSupport: "Call support",
    trackOrder: "Track your order",
    social: "Social",
    allOf: (title) => `All ${title}`,
    showAll: (title) => `Show all ${title}`,
    featuredIn: (title) => `Featured in ${title}`,
    submenu: (title) => `${title} submenu`,
  },
  tabs: {
    label: "Shortcuts",
    home: "Home",
    categories: "Categories",
    offers: "Offers",
    compare: "Compare",
    search: "Search",
    cart: "Cart",
    account: "Account",
  },
  footer: {
    callUs: "Call us:",
    callUsLabel: "Call us",
    messageUs: "Message us",
    whatsapp: "WhatsApp",
    visitUs: "Visit us",
    support: "Support",
    stayConnected: "Stay connected",
    policies: "Policies",
    storePolicies: "Store policies",
    footerLinks: "Footer",
    storeDirectory: "Store directory",
    customerCare: "Customer care",
    contactUs: "Contact us",
    aboutStore: (name) => `About ${name}`,
    about: "About",
    hotline: "For any help, call us",
    trackOrder: "Track your order",
    backToTop: "Back to top",
    call: (phone) => `Call ${phone}`,
    showMoreLinks: (count, title) => `Show ${count} more ${title} links`,
    hideExtraLinks: (title) => `Hide extra ${title} links`,
    rights: (year, name) => `© ${year} ${name}. All rights reserved.`,
    rightsNoName: (year) => `© ${year}. All rights reserved.`,
    social: "Social",
  },
};

export const CHROME_BN: ChromeCopy = {
  skipToContent: "মূল অংশে যান",
  home: "হোম",
  topBar: { trackOrder: "অর্ডার ট্র্যাক করুন" },
  header: {
    openMenu: "মেনু খুলুন",
    closeMenu: "মেনু বন্ধ করুন",
    search: "খুঁজুন",
    searchProducts: "পণ্য খুঁজুন",
    searchIn: "যে বিভাগে খুঁজবেন",
    allScopes: "সব",
    account: "অ্যাকাউন্ট",
    cart: "কার্ট",
    call: (phone) => `${phone} নম্বরে কল করুন`,
  },
  nav: {
    main: "প্রধান মেনু",
    mobileMenu: "মোবাইল মেনু",
    mobileNavigation: "মোবাইল নেভিগেশন",
    menu: "মেনু",
    shopByDepartment: "বিভাগ অনুযায়ী কিনুন",
    allCategories: "সব ক্যাটাগরি",
    allDepartments: "সব বিভাগ",
    more: "আরও",
    categories: "ক্যাটাগরি",
    storeLinks: "স্টোরের লিংক",
    shortcuts: "শর্টকাট",
    callSupport: "সাপোর্টে কল করুন",
    trackOrder: "অর্ডার ট্র্যাক করুন",
    social: "সোশ্যাল",
    allOf: (title) => `সব ${title}`,
    showAll: (title) => `সব ${title} দেখুন`,
    featuredIn: (title) => `${title}-এ বিশেষ`,
    submenu: (title) => `${title} সাবমেনু`,
  },
  tabs: {
    label: "শর্টকাট",
    home: "হোম",
    categories: "ক্যাটাগরি",
    offers: "অফার",
    compare: "তুলনা",
    search: "খুঁজুন",
    cart: "কার্ট",
    account: "অ্যাকাউন্ট",
  },
  footer: {
    callUs: "কল করুন:",
    callUsLabel: "কল করুন",
    messageUs: "মেসেজ করুন",
    whatsapp: "হোয়াটসঅ্যাপ",
    visitUs: "আমাদের ঠিকানা",
    support: "সাপোর্ট",
    stayConnected: "যোগাযোগ রাখুন",
    policies: "নীতিমালা",
    storePolicies: "স্টোরের নীতিমালা",
    footerLinks: "ফুটার",
    storeDirectory: "স্টোরের তালিকা",
    customerCare: "গ্রাহক সেবা",
    contactUs: "যোগাযোগ করুন",
    aboutStore: (name) => `${name} সম্পর্কে`,
    about: "পরিচিতি",
    hotline: "যেকোনো সাহায্যে কল করুন",
    trackOrder: "অর্ডার ট্র্যাক করুন",
    backToTop: "উপরে ফিরে যান",
    call: (phone) => `${phone} নম্বরে কল করুন`,
    showMoreLinks: (count, title) => `${title}-এর আরও ${count}টি লিংক দেখুন`,
    hideExtraLinks: (title) => `${title}-এর বাড়তি লিংক লুকান`,
    rights: (year, name) => `© ${year} ${name}। সর্বস্বত্ব সংরক্ষিত।`,
    rightsNoName: (year) => `© ${year}। সর্বস্বত্ব সংরক্ষিত।`,
    social: "সোশ্যাল",
  },
};
