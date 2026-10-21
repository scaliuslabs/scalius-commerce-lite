// Account → Profile → Saved payment methods (security audit N3): the cards
// or wallets a payment provider kept so the store can charge the buyer
// later without them (a subscription's renewals), each with what it was kept
// for. Removing one is a plain POST behind a confirm popover (works without
// JavaScript, Post/Redirect/Get): the provider detaches it, then nothing can
// charge it again. The method id travels only in the POST body; only an
// outcome flag enters the URL, never a brand, digits or an id.
import { formatNumber, numberLocale } from "@scalius/shared/locale-format";
import type { AccountSavedPaymentMethod } from "@/lib/account-server";
import { storefrontLanguage } from "@/lib/storefront-copy";
import { pageLanguage, storeRegion } from "@/lib/store-time-zone";

export const ACCOUNT_PAYMENT_METHOD_INTENT = "remove-payment-method";
export const ACCOUNT_PAYMENT_METHODS_ANCHOR = "payment-methods";

const PAYMENT_METHOD_COPY_EN = {
  heading: "Saved payment methods",
  text: "Cards kept for charges you agreed to, such as a subscription's renewals. Remove one and nothing can charge it again.",
  card: "Card",
  ending: "ending in {last4}",
  expires: "Expires {date}",
  expired: "Expired {date}",
  savedFor: "Saved for {option}",
  remove: "Remove",
  removeTitle: "Remove this payment method?",
  removeNote: "Nothing can charge it again. A subscription that used it will need another way to pay.",
  removeConfirm: "Remove payment method",
  removed: "Payment method removed.",
  removeFailed: "We couldn't remove that payment method right now. Try again in a moment.",
  removeRefused: "The payment provider didn't allow removing it. Contact the store for help.",
  brands: {
    visa: "Visa",
    mastercard: "Mastercard",
    amex: "American Express",
    discover: "Discover",
    jcb: "JCB",
    unionpay: "UnionPay",
    diners: "Diners Club",
    maestro: "Maestro",
    rupay: "RuPay",
  } as Record<string, string>,
};

export type AccountPaymentMethodCopy = typeof PAYMENT_METHOD_COPY_EN;

const PAYMENT_METHOD_COPY_BN: AccountPaymentMethodCopy = {
  heading: "সেভ করা পেমেন্ট পদ্ধতি",
  text: "আপনার সম্মতি দেওয়া চার্জের জন্য রাখা কার্ড, যেমন সাবস্ক্রিপশন নবায়ন। কোনোটি সরিয়ে দিলে তা থেকে আর কেউ টাকা কাটতে পারবে না।",
  card: "কার্ড",
  ending: "শেষ চার সংখ্যা {last4}",
  expires: "মেয়াদ {date} পর্যন্ত",
  expired: "মেয়াদ শেষ হয়েছে {date}",
  savedFor: "{option}-এর জন্য সেভ করা",
  remove: "সরিয়ে দিন",
  removeTitle: "এই পেমেন্ট পদ্ধতি সরিয়ে দেবেন?",
  removeNote: "এটি থেকে আর কোনো চার্জ নেওয়া যাবে না। যে সাবস্ক্রিপশন এটি ব্যবহার করত, তার জন্য অন্যভাবে পেমেন্ট করতে হবে।",
  removeConfirm: "পেমেন্ট পদ্ধতি সরিয়ে দিন",
  removed: "পেমেন্ট পদ্ধতি সরিয়ে দেওয়া হয়েছে।",
  removeFailed: "এখন পেমেন্ট পদ্ধতিটি সরানো যাচ্ছে না। একটু পরে আবার চেষ্টা করুন।",
  removeRefused: "পেমেন্ট প্রোভাইডার এটি সরাতে দেয়নি। সাহায্যের জন্য স্টোরের সঙ্গে যোগাযোগ করুন।",
  brands: {
    visa: "ভিসা",
    mastercard: "মাস্টারকার্ড",
    amex: "আমেরিকান এক্সপ্রেস",
    discover: "ডিসকভার",
    jcb: "জেসিবি",
    unionpay: "ইউনিয়নপে",
    diners: "ডাইনার্স ক্লাব",
    maestro: "মায়েস্ট্রো",
    rupay: "রুপে",
  },
};

/** The section's words in the page's language (Bangla on a Bangla page). */
export function accountPaymentMethodCopy(language: string = pageLanguage()): AccountPaymentMethodCopy {
  return storefrontLanguage(language) === "bn" ? PAYMENT_METHOD_COPY_BN : PAYMENT_METHOD_COPY_EN;
}

const BRAND_ALIASES: Record<string, string> = {
  "american express": "amex",
  american_express: "amex",
  master: "mastercard",
  "master card": "mastercard",
  diners_club: "diners",
  "diners club": "diners",
  union_pay: "unionpay",
};

/**
 * "Visa" / "ভিসা" for a known network; otherwise the provider's own label for
 * it (a wallet's name), else "Card", never a raw lower-case provider code.
 */
export function paymentMethodBrand(method: Pick<AccountSavedPaymentMethod, "brand" | "label">): string {
  const copy = accountPaymentMethodCopy();
  const key = method.brand?.trim().toLowerCase() ?? "";
  return copy.brands[BRAND_ALIASES[key] ?? key] ?? (method.label?.trim() || copy.card);
}

/** "ending in 4242": the last four digits as the card prints them (Latin digits, like a phone number). */
export function paymentMethodEnding(last4: string | null): string | null {
  return last4 && /^[0-9]{4}$/.test(last4) ? accountPaymentMethodCopy().ending.replace("{last4}", last4) : null;
}

/**
 * "Expires 08/27" as the card prints it, in the page's digits; past the end
 * of its month it reads "Expired 08/27". Null when the provider gave no expiry.
 */
export function paymentMethodExpiry(
  method: Pick<AccountSavedPaymentMethod, "expiryMonth" | "expiryYear">,
  now: Date = new Date(),
): { text: string; expired: boolean } | null {
  const { expiryMonth: month, expiryYear: year } = method;
  if (!month || !year || month < 1 || month > 12 || year < 2000 || year > 2200) return null;
  const locale = numberLocale(pageLanguage(), storeRegion());
  const two = (value: number) => formatNumber(value, locale, { minimumIntegerDigits: 2, useGrouping: false });
  const date = `${two(month)}/${two(year % 100)}`;
  const expired = year < now.getUTCFullYear() || (year === now.getUTCFullYear() && month < now.getUTCMonth() + 1);
  const copy = accountPaymentMethodCopy();
  return { text: (expired ? copy.expired : copy.expires).replace("{date}", date), expired };
}

/** "Saved for Subscribe and save": the purchase option the buyer chose at checkout. */
export function paymentMethodSavedFor(savedFor: string | null): string | null {
  return savedFor?.trim() ? accountPaymentMethodCopy().savedFor.replace("{option}", savedFor.trim()) : null;
}

const METHOD_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The method a remove form names, read from the POST body (never a query string). */
export function readAccountPaymentMethodForm(form: FormData): string | null {
  const id = form.get("methodId");
  return typeof id === "string" && METHOD_ID.test(id) ? id : null;
}

export type AccountPaymentMethodFlag = "removed";

/** Where a removal lands: the profile with only the outcome flag, at the section. */
export function accountPaymentMethodLocation(flag: AccountPaymentMethodFlag): string {
  return `/account/profile?${new URLSearchParams({ paymentMethod: flag })}#${ACCOUNT_PAYMENT_METHODS_ANCHOR}`;
}

export function readAccountPaymentMethodFlag(search: URLSearchParams): AccountPaymentMethodFlag | null {
  return search.get("paymentMethod") === "removed" ? "removed" : null;
}

/** What a failed removal says: a provider refusal names the store, anything else asks to retry. */
export function paymentMethodRemoveFailureText(reason: "refused" | "unavailable"): string {
  const copy = accountPaymentMethodCopy();
  return reason === "refused" ? copy.removeRefused : copy.removeFailed;
}
