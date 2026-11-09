import { formatPhoneIn } from "@scalius/shared/phone-input";
import { dashboardNumberLocale } from "~/i18n";
import { getStoreRegion } from "~/lib/store-time-zone";

/**
 * A phone as the dashboard shows it to read: the store country's format in
 * the dashboard's digits ("০১৭১২-৩৪৫৬৭৮" in Bangla). Links (`tel:`, WhatsApp),
 * fields and copied values keep Latin digits (`formatPhoneIn`).
 */
export function formatPhone(e164: string): string {
  return formatPhoneIn(e164, getStoreRegion(), dashboardNumberLocale());
}
