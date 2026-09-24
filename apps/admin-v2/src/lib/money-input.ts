import { toLatinDigits } from "@scalius/shared/phone-input";

/**
 * A typed money amount ("60", "৬০", "1,500.50") as a number with at most two
 * decimals, or null when it isn't one. Bangla digits and lakh commas are fine.
 */
export function parseAmountInput(raw: string): number | null {
  const text = toLatinDigits(raw).replace(/[,\s]/g, "");
  return /^\d{1,12}(?:\.\d{1,2})?$/.test(text) ? Number(text) : null;
}
