import { defineMessages } from "./index";

/** Settings navigation labels, keyed by `SETTINGS_NAV[].key`. */
export const settingsNavMessages = defineMessages({
  en: {
    settings: "Settings",
    store: "Store details",
    users: "Users and permissions",
    payments: "Payments",
    checkout: "Checkout",
    shipping: "Shipping and delivery",
    taxes: "Taxes",
    notifications: "Notifications",
    policies: "Policies",
    apps: "Apps",
    customerAccounts: "Customer accounts",
    advanced: "Advanced",
  },
  bn: {
    settings: "সেটিংস",
    store: "স্টোরের তথ্য",
    users: "স্টাফ ও পারমিশন",
    payments: "পেমেন্ট",
    checkout: "চেকআউট",
    shipping: "শিপিং ও ডেলিভারি",
    taxes: "ট্যাক্স",
    notifications: "নোটিফিকেশন",
    policies: "পলিসি",
    apps: "অ্যাপস",
    customerAccounts: "কাস্টমার অ্যাকাউন্ট",
    advanced: "অ্যাডভান্সড",
  },
});

/** Group headings in the settings list, keyed by `SETTINGS_GROUPS`. */
export const settingsGroupMessages = defineMessages({
  en: { general: "General", selling: "Selling", customers: "Customers", more: "More" },
  bn: { general: "সাধারণ", selling: "বিক্রি", customers: "কাস্টমার", more: "আরও" },
});

/** One-line summaries on the phone settings list. */
export const settingsSummaryMessages = defineMessages({
  en: {
    store: "Name, address, currency",
    users: "Staff and roles",
    payments: "Cash on delivery and online payments",
    checkout: "Checkout form, text and requests",
    shipping: "Delivery charges, areas and couriers",
    taxes: "Tax rates and overrides",
    notifications: "Messages to customers and staff",
    policies: "Return policy",
    apps: "Tracking, Facebook, fraud check, AI",
    customerAccounts: "How customers sign in",
    advanced: "Trusted websites, sign-in and refresh",
  },
  bn: {
    store: "নাম, ঠিকানা, কারেন্সি",
    users: "স্টাফ ও রোল",
    payments: "ক্যাশ অন ডেলিভারি ও অনলাইন পেমেন্ট",
    checkout: "চেকআউট ফর্ম, লেখা ও রিকোয়েস্ট",
    shipping: "ডেলিভারি চার্জ, এলাকা ও কুরিয়ার",
    taxes: "ট্যাক্স রেট ও ব্যতিক্রম",
    notifications: "কাস্টমার ও স্টাফকে মেসেজ",
    policies: "রিটার্ন পলিসি",
    apps: "ট্র্যাকিং, ফেসবুক, ফ্রড চেক, AI",
    customerAccounts: "কাস্টমার কীভাবে সাইন ইন করবে",
    advanced: "বিশ্বস্ত ওয়েবসাইট, সাইন ইন ও রিফ্রেশ",
  },
});

/** Shared settings chrome: load errors, permissions, common actions. */
export const settingsMessages = defineMessages({
  en: {
    search: "Search",
    close: "Close settings",
    loadFailed: "Couldn't load this. Nothing changed.",
    saveFailed: "Couldn't save. Your edits are kept.",
    retry: "Try again",
    readOnly: "You can view this but not change it.",
    optional: "Optional",
    add: "Add",
    edit: "Edit",
    remove: "Remove",
    cancel: "Cancel",
    save: "Save",
    delete: "Delete",
    deleteNamed: "Delete “{name}”?",
    on: "On",
    off: "Off",
    back: "Settings",
    openEditorFailed: "This section couldn't open. Reload the page.",
    reload: "Reload",
  },
  bn: {
    search: "খুঁজুন",
    close: "সেটিংস বন্ধ করুন",
    loadFailed: "লোড করা যায়নি। কিছু বদলায়নি।",
    saveFailed: "সেভ করা যায়নি। আপনার পরিবর্তন রাখা আছে।",
    retry: "আবার চেষ্টা করুন",
    readOnly: "আপনি এটি দেখতে পারবেন, কিন্তু বদলাতে পারবেন না।",
    optional: "ঐচ্ছিক",
    add: "যোগ করুন",
    edit: "এডিট",
    remove: "সরান",
    cancel: "বাতিল",
    save: "সেভ",
    delete: "ডিলিট",
    deleteNamed: "“{name}” ডিলিট করবেন?",
    on: "চালু",
    off: "বন্ধ",
    back: "সেটিংস",
    openEditorFailed: "এই অংশটি খোলা যায়নি। পেজটি রিলোড করুন।",
    reload: "রিলোড",
  },
});
