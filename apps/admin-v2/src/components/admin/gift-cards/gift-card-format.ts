// Pure presentation rules for the Gift cards pages (Wave B §4, §9.1). No
// code material ever passes through here: staff see the last 4 only.
import { commerceCalendarDateKey, commerceCalendarDayBounds } from "@scalius/shared/commerce-time";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { toMinor } from "@scalius/shared/money";
import { normalizeBdMobile, toLatinDigits } from "@scalius/shared/phone-input";
import { unixToDate } from "@scalius/shared/timestamps";
import type { BadgeVariant } from "~/components/ui/badge";
import { formatDateTime } from "~/i18n";
import { formatSavedMinorAmount } from "~/lib/order-tax-presentation";

export type GiftCardTimestamp = string | number | null | undefined;

/** What staff read in the Status column: Shopify's Active / Disabled / Expired / Used up. */
export type GiftCardDisplayStatus = "active" | "disabled" | "expired" | "usedUp";

export function giftCardDisplayStatus(card: { status: string; expired: boolean; balanceMinor: number }): GiftCardDisplayStatus {
  if (card.status === "disabled") return "disabled";
  if (card.expired) return "expired";
  if (card.balanceMinor <= 0) return "usedUp";
  return "active";
}

/** DESIGN.md status table: active is success, expired critical, the rest neutral. */
export const GIFT_CARD_STATUS_BADGE: Record<GiftCardDisplayStatus, BadgeVariant> = {
  active: "success",
  disabled: "secondary",
  expired: "destructive",
  usedUp: "secondary",
};

/** "•••• 7K2Q": how a card is named everywhere in the dashboard. */
export function maskedGiftCard(last4: string): string {
  return `•••• ${last4}`;
}

/** A card's minor-unit amount in its own currency, e.g. "৳1,000.00". */
export function formatGiftCardMoney(amountMinor: number, currencyCode: string): string {
  return formatSavedMinorAmount(amountMinor, { currencyCode, decimalPlaces: getDecimalPlaces(currencyCode) });
}

function epochSeconds(value: GiftCardTimestamp): number | null {
  const date = unixToDate(value ?? null);
  return date ? Math.floor(date.getTime() / 1_000) : null;
}

/**
 * The last store day (Asia/Dhaka, YYYY-MM-DD) a card can be used. Cards expire
 * at an instant; one that expires at midnight is last usable the day before.
 */
export function giftCardLastDay(expiresAt: GiftCardTimestamp): string | null {
  const seconds = epochSeconds(expiresAt);
  return seconds === null ? null : commerceCalendarDateKey((seconds - 1) * 1_000);
}

/** The last usable day as a medium date in the dashboard language. */
export function formatGiftCardLastDay(expiresAt: GiftCardTimestamp): string | null {
  const seconds = epochSeconds(expiresAt);
  return seconds === null ? null : formatDateTime(new Date((seconds - 1) * 1_000), { dateStyle: "medium" });
}

/** A chosen last day → the ISO instant it ends (the next Dhaka midnight), or null when not a date. */
export function giftCardExpiresAtFromDay(day: string): string | null {
  try {
    return new Date((commerceCalendarDayBounds(day).end + 1) * 1_000).toISOString();
  } catch {
    return null;
  }
}

/** Today in the store's time zone, for the expiry field's `min`. */
export function todayStoreDay(now: Date | number = Date.now()): string {
  return commerceCalendarDateKey(now);
}

/** An expiry day must be today or later (a card that ends today still works until midnight). */
export function isValidExpiryDay(day: string, now: Date | number = Date.now()): boolean {
  return giftCardExpiresAtFromDay(day) !== null && day >= todayStoreDay(now);
}

/** A typed amount (major units) → minor units in the currency; null when not a positive amount. */
export function giftCardAmountMinor(amount: number | null, currencyCode: string): number | null {
  if (amount === null || !Number.isFinite(amount) || amount <= 0) return null;
  try {
    const minor = toMinor(amount, getDecimalPlaces(currencyCode));
    return minor > 0 ? minor : null;
  } catch {
    return null;
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidRecipientEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

/** A Bangladesh mobile (01XXXXXXXXX in any format) or a full international number. The API checks it again. */
export function isValidRecipientPhone(value: string): boolean {
  if (normalizeBdMobile(value)) return true;
  const compact = toLatinDigits(value).replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(compact);
}
