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
  turnOn: string;
  turnOff: string;
  working: string;
  failed: string;
}

const EN: AccountPushCopy = {
  heading: "Browser notifications",
  text: "Get order updates as notifications in this browser, even when the store is closed. This applies to this browser only.",
  on: "On in this browser",
  off: "Off in this browser",
  blocked: "Blocked by the browser",
  blockedHint: "Notifications are blocked for this store. Allow them in your browser’s site settings, then come back here.",
  turnOn: "Turn on",
  turnOff: "Turn off",
  working: "Working…",
  failed: "That did not work. Try again.",
};

const BN: AccountPushCopy = {
  heading: "ব্রাউজার নোটিফিকেশন",
  text: "স্টোর বন্ধ থাকলেও এই ব্রাউজারে অর্ডারের আপডেট নোটিফিকেশন হিসেবে পান। এটি শুধু এই ব্রাউজারের জন্য।",
  on: "এই ব্রাউজারে চালু আছে",
  off: "এই ব্রাউজারে বন্ধ আছে",
  blocked: "ব্রাউজার ব্লক করেছে",
  blockedHint: "এই স্টোরের নোটিফিকেশন ব্লক করা আছে। ব্রাউজারের সাইট সেটিংসে অনুমতি দিন, তারপর এখানে ফিরে আসুন।",
  turnOn: "চালু করুন",
  turnOff: "বন্ধ করুন",
  working: "কাজ চলছে…",
  failed: "হয়নি। আবার চেষ্টা করুন।",
};

export function accountPushCopy(language: NewsletterLanguage): AccountPushCopy {
  return language === "bn" ? BN : EN;
}
