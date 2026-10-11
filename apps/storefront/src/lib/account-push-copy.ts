// The "Browser notifications" control on Account → Profile, in the store's
// language (English and Bangla), chosen like the News and offers section:
// the layout's `storefrontCopy.languageCode` (lib/newsletter-copy).
import type { NewsletterLanguage } from "./newsletter-copy";

export interface AccountPushCopy {
  heading: string;
  text: string;
  /** The state, in words. */
  on: string;
  off: string;
  blocked: string;
  blockedHint: string;
  unsupported: string;
  unsupportedHint: string;
  homeScreen: string;
  homeScreenHint: string;
  loadFailed: string;
  retry: string;
  soundHint: string;
  turnOn: string;
  turnOff: string;
  working: string;
  failed: string;
}

const EN: AccountPushCopy = {
  heading: "Browser notifications",
  text: "Receive order notifications sent by this store, even when its tab is closed. This applies to this browser only.",
  on: "On in this browser",
  off: "Off in this browser",
  blocked: "Blocked by the browser",
  blockedHint: "Notifications are blocked for this store. Allow them in your browser’s site settings, then come back here.",
  unsupported: "Not supported in this browser",
  unsupportedHint: "Use a browser that supports notifications, such as a current version of Chrome, Edge, Firefox or Safari.",
  homeScreen: "Add this store to your Home Screen",
  homeScreenHint: "On iPhone or iPad, open this store in Safari, tap Share → Add to Home Screen, then open that icon to turn on notifications. Requires iOS or iPadOS 16.4 or later.",
  loadFailed: "Couldn’t check notification settings",
  retry: "Retry",
  soundHint: "Sound depends on your browser and device; some browsers show notifications silently. If no notification appears, check your device’s notification and Focus or Do Not Disturb settings.",
  turnOn: "Turn on",
  turnOff: "Turn off",
  working: "Working…",
  failed: "That did not work. Try again.",
};

const BN: AccountPushCopy = {
  heading: "ব্রাউজার নোটিফিকেশন",
  text: "স্টোরের ট্যাব বন্ধ থাকলেও স্টোর থেকে পাঠানো অর্ডারের নোটিফিকেশন পান। এটি শুধু এই ব্রাউজারের জন্য।",
  on: "এই ব্রাউজারে চালু আছে",
  off: "এই ব্রাউজারে বন্ধ আছে",
  blocked: "ব্রাউজার ব্লক করেছে",
  blockedHint: "এই স্টোরের নোটিফিকেশন ব্লক করা আছে। ব্রাউজারের সাইট সেটিংসে অনুমতি দিন, তারপর এখানে ফিরে আসুন।",
  unsupported: "এই ব্রাউজারে সমর্থিত নয়",
  unsupportedHint: "নোটিফিকেশন সমর্থন করে এমন ব্রাউজার ব্যবহার করুন, যেমন Chrome, Edge, Firefox বা Safari-এর বর্তমান সংস্করণ।",
  homeScreen: "স্টোরটি হোম স্ক্রিনে যোগ করুন",
  homeScreenHint: "iPhone বা iPad-এ Safari দিয়ে স্টোর খুলে Share → Add to Home Screen চাপুন। তারপর সেই আইকন থেকে খুলে নোটিফিকেশন চালু করুন। iOS বা iPadOS 16.4 বা পরের সংস্করণ প্রয়োজন।",
  loadFailed: "নোটিফিকেশনের সেটিংস যাচাই করা যায়নি",
  retry: "আবার চেষ্টা করুন",
  soundHint: "শব্দ আপনার ব্রাউজার ও ডিভাইসের ওপর নির্ভর করে; কিছু ব্রাউজার শব্দ ছাড়া নোটিফিকেশন দেখায়। নোটিফিকেশন না এলে ডিভাইসের নোটিফিকেশন এবং Focus বা Do Not Disturb সেটিংস যাচাই করুন।",
  turnOn: "চালু করুন",
  turnOff: "বন্ধ করুন",
  working: "কাজ চলছে…",
  failed: "হয়নি। আবার চেষ্টা করুন।",
};

export function accountPushCopy(language: NewsletterLanguage): AccountPushCopy {
  return language === "bn" ? BN : EN;
}
