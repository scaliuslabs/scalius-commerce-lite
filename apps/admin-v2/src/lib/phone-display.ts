import { formatPhoneForDisplay } from "@scalius/shared/phone-input";
import { getStoreRegion } from "~/lib/store-time-zone";

/**
 * A stored (E.164) phone number as the dashboard shows it, everywhere the
 * same: in the store country's own national format ("01712-345678" in a
 * Bangladesh store), another country's number with its code set apart.
 */
export function displayPhone(e164: string): string {
  return formatPhoneForDisplay(e164, getStoreRegion());
}
