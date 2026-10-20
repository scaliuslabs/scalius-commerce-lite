// The consent banner's words in English and Bangla (the storefront's two
// catalogue languages, lib/storefront-copy.ts). Whole sentences only.
import type { StorefrontLanguage } from "@/lib/storefront-copy";

export interface ConsentCopy {
  region: string;
  /** Opt-in markets (EEA, UK, Switzerland): nothing runs until the buyer agrees. */
  optInText: string;
  /** Notice markets: measurement and ads run unless the buyer says no. */
  noticeText: string;
  accept: string;
  reject: string;
  ok: string;
  manage: string;
  choices: string;
  necessary: string;
  necessaryHint: string;
  analytics: string;
  analyticsHint: string;
  marketing: string;
  marketingHint: string;
  saleOfData: string;
  saleOfDataHint: string;
  save: string;
  privacyChoices: string;
}

const EN: ConsentCopy = {
  region: "Cookie and privacy choices",
  optInText: "We use cookies to measure visits and, with your permission, to show you relevant ads. Choose what you allow.",
  noticeText: "We use cookies to measure visits and show you relevant ads. You can change this any time.",
  accept: "Accept all",
  reject: "Reject all",
  ok: "OK",
  manage: "Choose",
  choices: "What you allow",
  necessary: "Necessary",
  necessaryHint: "Cart, checkout and sign-in. Always on.",
  analytics: "Analytics",
  analyticsHint: "Counts visits and what sells, so we can improve the store.",
  marketing: "Advertising",
  marketingHint: "Lets ad partners such as Meta, Google and TikTok measure and personalise ads.",
  saleOfData: "Share data with ad partners",
  saleOfDataHint: "Allows sharing that some laws treat as a sale of personal data.",
  save: "Save choices",
  privacyChoices: "Your privacy choices",
};

const BN: ConsentCopy = {
  region: "কুকি ও গোপনীয়তার পছন্দ",
  optInText: "ভিজিট পরিমাপ করতে এবং আপনার অনুমতি নিয়ে প্রাসঙ্গিক বিজ্ঞাপন দেখাতে আমরা কুকি ব্যবহার করি। কী চালু থাকবে বেছে নিন।",
  noticeText: "ভিজিট পরিমাপ করতে এবং প্রাসঙ্গিক বিজ্ঞাপন দেখাতে আমরা কুকি ব্যবহার করি। যেকোনো সময় এটি বদলাতে পারবেন।",
  accept: "সব মেনে নিন",
  reject: "সব বাতিল করুন",
  ok: "ঠিক আছে",
  manage: "বেছে নিন",
  choices: "আপনি যা চালু রাখবেন",
  necessary: "প্রয়োজনীয়",
  necessaryHint: "কার্ট, চেকআউট ও সাইন-ইন। সবসময় চালু।",
  analytics: "অ্যানালিটিক্স",
  analyticsHint: "ভিজিট ও বিক্রি গণনা করে, যাতে আমরা স্টোর উন্নত করতে পারি।",
  marketing: "বিজ্ঞাপন",
  marketingHint: "Meta, Google ও TikTok-এর মতো বিজ্ঞাপন সহযোগীদের বিজ্ঞাপন পরিমাপ ও ব্যক্তিগতকরণ করতে দেয়।",
  saleOfData: "বিজ্ঞাপন সহযোগীদের সাথে তথ্য শেয়ার",
  saleOfDataHint: "কিছু আইনে এই শেয়ারকে ব্যক্তিগত তথ্য বিক্রি গণ্য করা হয়।",
  save: "পছন্দ সংরক্ষণ করুন",
  privacyChoices: "আপনার গোপনীয়তার পছন্দ",
};

const COPY: Record<StorefrontLanguage, ConsentCopy> = { en: EN, bn: BN };

export function consentCopy(language: StorefrontLanguage): ConsentCopy {
  return COPY[language];
}
