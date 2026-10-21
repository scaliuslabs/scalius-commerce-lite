import { defineMessages } from "./index";

/** The customer page's saved payment methods (security audit N3). */
export const customerPaymentMethodsMessages = defineMessages({
  en: {
    title: "Saved payment methods",
    empty: "No saved payment methods",
    loadFailed: "Couldn't load saved payment methods.",
    card: "Card",
    ending: "ending in {last4}",
    expires: "Expires {date}",
    expired: "Expired {date}",
    savedFor: "Saved for {option}",
    chargedBy: "Charged by {app}",
    staffOnly: "Staff only",
    sourceOrder: "Order that saved it",
    remove: "Remove",
    removeTitle: "Remove {method}?",
    removeBody: "The payment provider detaches it and nothing can charge it again. A subscription that used it needs another way to pay.",
    removed: "Payment method removed",
  },
  bn: {
    title: "সেভ করা পেমেন্ট পদ্ধতি",
    empty: "কোনো পেমেন্ট পদ্ধতি সেভ করা নেই",
    loadFailed: "সেভ করা পেমেন্ট পদ্ধতি লোড করা যায়নি।",
    card: "কার্ড",
    ending: "শেষ চার সংখ্যা {last4}",
    expires: "মেয়াদ {date} পর্যন্ত",
    expired: "মেয়াদ শেষ হয়েছে {date}",
    savedFor: "{option}-এর জন্য সেভ করা",
    chargedBy: "চার্জ করতে পারে {app}",
    staffOnly: "শুধু স্টাফ",
    sourceOrder: "যে অর্ডারে সেভ হয়েছে",
    remove: "সরিয়ে দিন",
    removeTitle: "{method} সরিয়ে দেবেন?",
    removeBody: "পেমেন্ট প্রোভাইডার এটি আলাদা করে দেবে, এরপর এটি থেকে আর কোনো চার্জ নেওয়া যাবে না। যে সাবস্ক্রিপশন এটি ব্যবহার করত, তার জন্য অন্যভাবে পেমেন্ট করতে হবে।",
    removed: "পেমেন্ট পদ্ধতি সরানো হয়েছে",
  },
});

/** Card networks by their printed names; a network not listed reads as the provider's label, else "Card". */
export const CARD_BRAND_NAMES: Readonly<Record<string, string>> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  "american express": "American Express",
  american_express: "American Express",
  discover: "Discover",
  jcb: "JCB",
  unionpay: "UnionPay",
  diners: "Diners Club",
  maestro: "Maestro",
  rupay: "RuPay",
};
