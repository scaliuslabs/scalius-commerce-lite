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

export const GIFT_CARD_PAGE_COPY = {
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
} as const;

const STATUS_TEXT: Record<GiftCardBalanceStatus, string> = {
  active: "Active",
  disabled: "Disabled",
  expired: "Expired",
};

/** The status a buyer sees; an expired card keeps its balance but can't be used. */
export function giftCardStatusText(status: GiftCardBalanceStatus): string {
  return STATUS_TEXT[status];
}

export function accountGiftCardStatus(card: Pick<AccountGiftCard, "status" | "expired">): GiftCardBalanceStatus {
  if (card.status === "disabled") return "disabled";
  return card.expired ? "expired" : "active";
}

export function giftCardStatusTone(status: GiftCardBalanceStatus): string {
  return status === "active" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground";
}

/** "•••• 7K2Q" */
export function maskedGiftCard(last4: string): string {
  return `•••• ${last4}`;
}

export function giftCardTitle(last4: string): string {
  return GIFT_CARD_PAGE_COPY.cardTitle.replace("{card}", maskedGiftCard(last4));
}

export function giftCardExpiryText(expiresAt: string | null): string {
  return expiresAt ? formatAccountDate(expiresAt, { time: false }) || GIFT_CARD_PAGE_COPY.noExpiry : GIFT_CARD_PAGE_COPY.noExpiry;
}

export function giftCardMoney(amount: number, currencyCode: string): string {
  return accountMoney(amount, currencyCode);
}

/** One uniform sentence per failure: never says whether a code exists. */
export function giftCardBalanceFailureText(reason: GiftCardFailureReason): string {
  if (reason === "rate_limited") return GIFT_CARD_PAGE_COPY.rateLimited;
  if (reason === "unavailable") return GIFT_CARD_PAGE_COPY.unavailable;
  return GIFT_CARD_PAGE_COPY.notFound;
}

export function giftCardSaveFailureText(reason: GiftCardFailureReason): string {
  if (reason === "rate_limited") return GIFT_CARD_PAGE_COPY.rateLimited;
  if (reason === "unavailable") return GIFT_CARD_PAGE_COPY.unavailable;
  return GIFT_CARD_PAGE_COPY.saveFailed;
}

export function giftCardRevealFailureText(reason: GiftCardFailureReason): string {
  return reason === "rate_limited" ? GIFT_CARD_PAGE_COPY.rateLimited : GIFT_CARD_PAGE_COPY.revealFailed;
}

/** "Used on order #1042", "Issued", … */
export function giftCardTransactionText(transaction: Pick<AccountGiftCardTransaction, "kind" | "orderNumber">): string {
  const order = transaction.orderNumber ? ` ${transaction.orderNumber.startsWith("#") ? "" : "#"}${transaction.orderNumber}` : "";
  switch (transaction.kind) {
    case "issue":
      return "Issued";
    case "redeem":
      return order ? `Used on order${order}` : "Used on an order";
    case "release":
      return order ? `Returned from order${order}` : "Returned from an order";
    case "refund":
      return order ? `Refund from order${order}` : "Refund";
    case "adjust":
      return "Adjusted by the store";
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
