import { normalizeTimeZone } from "@scalius/shared/commerce-time";

/**
 * The store's IANA time zone (Settings → Store details → Store defaults),
 * resolved at Worker entry with the Platform settings: the merchant calendar
 * of reports, date filters, file names and scheduled windows. No read.
 */
export function storeTimeZoneOf(env: Pick<Env, "PLATFORM_CONFIG"> | null | undefined): string {
  return normalizeTimeZone(env?.PLATFORM_CONFIG?.timeZone);
}
