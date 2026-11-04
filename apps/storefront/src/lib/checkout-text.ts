import { formatCheckoutLanguageText } from "@scalius/shared/checkout-language-format";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { formatCount, formatPageNumber, pageLanguage } from "@/lib/store-time-zone";

/**
 * A catalogue template filled for the page: `{name}` placeholders take their
 * values, and a number is written in the page's digits (Bangla on a Bangla
 * page, "১টি কিনলে"), never as `String(n)`. Every storefront template is
 * filled through here (scripts/check-source-policies.mjs).
 */
export function checkoutText(template: string, values: Readonly<Record<string, string | number>>): string {
  const filled: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) filled[key] = typeof value === "number" ? formatCount(value) : value;
  return formatCheckoutLanguageText(template, filled);
}

/**
 * An identifier or a number written as text (an order number "#1105", a
 * phone number) in the page's digits: each Latin digit becomes the page's
 * own (Bangla on a Bangla page); everything else stays as it is. Links keep
 * the Latin text (`tel:`); this is only what the buyer reads.
 */
export function pageDigits(value: string | null | undefined, language: string = pageLanguage()): string {
  const text = value ?? "";
  const zero = formatPageNumber(0, language);
  if (zero === "0" || zero.length !== 1) return text;
  const base = zero.codePointAt(0)!;
  return text.replace(/[0-9]/g, (digit) => String.fromCodePoint(base + Number(digit)));
}

/**
 * An order's number as the buyer reads it ("#১১০৫" on a Bangla page): the
 * shared format in the page's digits. An order without a number shows its
 * reference as it is.
 */
export function pageOrderNumber(orderNumber: number | null | undefined, fallbackId: string, language?: string): string {
  const text = formatOrderNumber(orderNumber, fallbackId);
  return typeof orderNumber === "number" ? pageDigits(text, language) : text;
}
