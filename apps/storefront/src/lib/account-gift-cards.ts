// Buyer gift-card pages (Wave B §4.5): /gift-card-balance and the account's
// "Gift cards" tab. Both are server-rendered and answer plain form POSTs, so
// they work before and without JavaScript; a code only ever arrives in a POST
// body and is never written back into the page, a URL or a log. The one code
// a page shows is the buyer's own card after "Show code" (POST, no-store).

import { accountMoney, formatAccountDate } from "@/lib/account-format";
import type {
  AccountGiftCard,
  AccountGiftCardTransaction,
  GiftCardApiResult,
  GiftCardBalance,
  GiftCardBalanceStatus,
  GiftCardFailureReason,
} from "@/lib/api/gift-cards";
import { storefrontLanguage } from "@/lib/storefront-copy";
import { pageLanguage } from "@/lib/store-time-zone";

const GIFT_CARD_PAGE_COPY_EN = {
  balanceTitle: "Check a gift card balance",
  balanceIntro: "Enter the 16-character code from your gift card to see what's left on it.",
  codeLabel: "Gift card code",
  checkBalance: "Check balance",
  cardTitle: "Gift card {card}",
  balanceLabel: "Balance",
  valueLabel: "Value",
  expiresLabel: "Expires",
  noExpiry: "Never expires",
  statusLabel: "Status",
  useAtCheckout: "To use it, enter the code on the payment step at checkout.",
  notFound: "We couldn't find a gift card with that code. Check it and try again.",
  rateLimited: "Too many tries. Wait a minute, then try again.",
  unavailable: "We couldn't check gift cards right now. Try again in a moment.",
  accountTitle: "Gift cards",
  accountEmpty: "No gift cards on your account yet.",
  saveTitle: "Save a gift card to your account",
  saveIntro: "Add a card you received so its balance and history show here.",
  save: "Save card",
  saved: "Gift card {card} is saved to your account.",
  saveFailed: "We couldn't save that gift card. Check the code and try again.",
  showCode: "Show code",
  codeTitle: "Code for gift card {card}",
  codeHint: "Keep this code private: anyone who has it can spend the balance.",
  revealFailed: "We couldn't show that code right now. Try again in a moment.",
  history: "History",
  signInTitle: "Sign in to see your gift cards",
  signInBody: "Gift cards saved to your account appear here after you sign in.",
  status: { active: "Active", disabled: "Disabled", expired: "Expired" } as Record<GiftCardBalanceStatus, string>,
  issued: "Issued",
  usedOn: "Used on order {order}",
  usedOnAnOrder: "Used on an order",
  returnedFrom: "Returned from order {order}",
  returnedFromAnOrder: "Returned from an order",
  refundFrom: "Refund from order {order}",
  refund: "Refund",
  adjusted: "Adjusted by the store",
};

export type GiftCardPageCopy = typeof GIFT_CARD_PAGE_COPY_EN;

const GIFT_CARD_PAGE_COPY_BN: GiftCardPageCopy = {
  balanceTitle: "গিফট কার্ডের ব্যালেন্স দেখুন",
  balanceIntro: "কার্ডে কত টাকা বাকি আছে দেখতে আপনার গিফট কার্ডের ১৬ অক্ষরের কোডটি লিখুন।",
  codeLabel: "গিফট কার্ডের কোড",
  checkBalance: "ব্যালেন্স দেখুন",
  cardTitle: "গিফট কার্ড {card}",
  balanceLabel: "ব্যালেন্স",
  valueLabel: "মূল্য",
  expiresLabel: "মেয়াদ শেষ",
  noExpiry: "মেয়াদ শেষ হয় না",
  statusLabel: "অবস্থা",
  useAtCheckout: "ব্যবহার করতে চেকআউটের পেমেন্ট ধাপে কোডটি লিখুন।",
  notFound: "এই কোডের কোনো গিফট কার্ড পাওয়া যায়নি। কোডটি দেখে আবার চেষ্টা করুন।",
  rateLimited: "অনেকবার চেষ্টা করা হয়েছে। এক মিনিট পরে আবার চেষ্টা করুন।",
  unavailable: "এখন গিফট কার্ড দেখা যাচ্ছে না। একটু পরে আবার চেষ্টা করুন।",
  accountTitle: "গিফট কার্ড",
  accountEmpty: "আপনার অ্যাকাউন্টে এখনো কোনো গিফট কার্ড নেই।",
  saveTitle: "অ্যাকাউন্টে গিফট কার্ড সেভ করুন",
  saveIntro: "পাওয়া কার্ড যোগ করুন, তার ব্যালেন্স ও লেনদেন এখানে দেখা যাবে।",
  save: "কার্ড সেভ করুন",
  saved: "গিফট কার্ড {card} আপনার অ্যাকাউন্টে সেভ হয়েছে।",
  saveFailed: "গিফট কার্ডটি সেভ করা যায়নি। কোডটি দেখে আবার চেষ্টা করুন।",
  showCode: "কোড দেখুন",
  codeTitle: "গিফট কার্ড {card}-এর কোড",
  codeHint: "এই কোড গোপন রাখুন: যার কাছে এটি থাকবে সে-ই ব্যালেন্স খরচ করতে পারবে।",
  revealFailed: "এখন কোডটি দেখানো যাচ্ছে না। একটু পরে আবার চেষ্টা করুন।",
  history: "লেনদেন",
  signInTitle: "আপনার গিফট কার্ড দেখতে সাইন ইন করুন",
  signInBody: "সাইন ইন করলে আপনার অ্যাকাউন্টে সেভ করা গিফট কার্ড এখানে দেখা যাবে।",
  status: { active: "চালু", disabled: "বন্ধ", expired: "মেয়াদ শেষ" },
  issued: "দেওয়া হয়েছে",
  usedOn: "অর্ডার {order}-এ ব্যবহার হয়েছে",
  usedOnAnOrder: "একটি অর্ডারে ব্যবহার হয়েছে",
  returnedFrom: "অর্ডার {order} থেকে ফেরত এসেছে",
  returnedFromAnOrder: "একটি অর্ডার থেকে ফেরত এসেছে",
  refundFrom: "অর্ডার {order}-এর রিফান্ড",
  refund: "রিফান্ড",
  adjusted: "স্টোর বদলেছে",
};

/** The gift-card pages' words in the page's language (Bangla on a Bangla page). */
export function giftCardPageCopy(language: string = pageLanguage()): GiftCardPageCopy {
  return storefrontLanguage(language) === "bn" ? GIFT_CARD_PAGE_COPY_BN : GIFT_CARD_PAGE_COPY_EN;
}

/** The status a buyer sees; an expired card keeps its balance but can't be used. */
export function giftCardStatusText(status: GiftCardBalanceStatus): string {
  return giftCardPageCopy().status[status];
}

export function accountGiftCardStatus(card: Pick<AccountGiftCard, "status" | "expired">): GiftCardBalanceStatus {
  if (card.status === "disabled") return "disabled";
  return card.expired ? "expired" : "active";
}

export function giftCardStatusTone(status: GiftCardBalanceStatus): string {
  return status === "active" ? "bg-primary/10 text-primary-ink" : "bg-muted text-muted-foreground";
}

/** "•••• 7K2Q" */
export function maskedGiftCard(last4: string): string {
  return `•••• ${last4}`;
}

export function giftCardTitle(last4: string): string {
  return giftCardPageCopy().cardTitle.replace("{card}", maskedGiftCard(last4));
}

export function giftCardExpiryText(expiresAt: string | null): string {
  const copy = giftCardPageCopy();
  return expiresAt ? formatAccountDate(expiresAt, { time: false }) || copy.noExpiry : copy.noExpiry;
}

export function giftCardMoney(amount: number, currencyCode: string): string {
  return accountMoney(amount, currencyCode);
}

/** One uniform sentence per failure: never says whether a code exists. */
export function giftCardBalanceFailureText(reason: GiftCardFailureReason): string {
  const copy = giftCardPageCopy();
  if (reason === "rate_limited") return copy.rateLimited;
  if (reason === "unavailable") return copy.unavailable;
  return copy.notFound;
}

export function giftCardSaveFailureText(reason: GiftCardFailureReason): string {
  const copy = giftCardPageCopy();
  if (reason === "rate_limited") return copy.rateLimited;
  if (reason === "unavailable") return copy.unavailable;
  return copy.saveFailed;
}

export function giftCardRevealFailureText(reason: GiftCardFailureReason): string {
  return reason === "rate_limited" ? giftCardPageCopy().rateLimited : giftCardPageCopy().revealFailed;
}

/** "Used on order #1042", "Issued", … */
export function giftCardTransactionText(transaction: Pick<AccountGiftCardTransaction, "kind" | "orderNumber">): string {
  const order = transaction.orderNumber ? `${transaction.orderNumber.startsWith("#") ? "" : "#"}${transaction.orderNumber}` : "";
  const copy = giftCardPageCopy();
  const withOrder = (template: string) => template.replace("{order}", order);
  switch (transaction.kind) {
    case "issue":
      return copy.issued;
    case "redeem":
      return order ? withOrder(copy.usedOn) : copy.usedOnAnOrder;
    case "release":
      return order ? withOrder(copy.returnedFrom) : copy.returnedFromAnOrder;
    case "refund":
      return order ? withOrder(copy.refundFrom) : copy.refund;
    case "adjust":
      return copy.adjusted;
  }
}

/** "+৳500" / "−৳250": the ledger's signed amount. */
export function giftCardTransactionAmount(amount: number, currencyCode: string): string {
  const formatted = accountMoney(Math.abs(amount), currencyCode);
  return amount < 0 ? `−${formatted}` : `+${formatted}`;
}

/** The balance page's form, read from the POST body (never a query string). */
export async function readGiftCardFormFields(request: Request): Promise<Record<string, string>> {
  try {
    const length = Number(request.headers.get("Content-Length") ?? "0");
    if (!Number.isFinite(length) || length > 4096) return {};
    const form = await request.formData();
    const fields: Record<string, string> = {};
    for (const key of ["intent", "code", "giftCardId"]) {
      const value = form.get(key);
      if (typeof value === "string") fields[key] = value.slice(0, 128);
    }
    return fields;
  } catch {
    return {};
  }
}

export type GiftCardBalanceView =
  | { kind: "form" }
  | { kind: "result"; card: GiftCardBalance }
  | { kind: "error"; message: string };

export function giftCardBalanceView(result: GiftCardApiResult<GiftCardBalance> | null): GiftCardBalanceView {
  if (!result) return { kind: "form" };
  return result.ok
    ? { kind: "result", card: result.data }
    : { kind: "error", message: giftCardBalanceFailureText(result.reason) };
}

/** HTTP status for a page answer: the page still renders, but a limiter or outage is not a 200. */
export function giftCardPageStatus(result: GiftCardApiResult<unknown> | null): number {
  if (!result || result.ok) return 200;
  if (result.reason === "rate_limited") return 429;
  if (result.reason === "unavailable") return 503;
  return 200;
}
