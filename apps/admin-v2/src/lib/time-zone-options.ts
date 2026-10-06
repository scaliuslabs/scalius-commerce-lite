// The time zone picker's options, Shopify's style: "(GMT-05:00) America/New
// York", searchable by the zone's name ("Eastern Time"). Offsets are today's.
import { timeZoneOffsetSeconds } from "@scalius/shared/commerce-time";

export interface TimeZoneOption {
  value: string;
  label: string;
  keywords: string[];
}

function gmtOffset(timeZone: string, nowSeconds: number): string {
  const offset = timeZoneOffsetSeconds(timeZone, nowSeconds) / 60;
  const sign = offset < 0 ? "-" : "+";
  const minutes = Math.abs(offset);
  return `(GMT${sign}${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")})`;
}

function zoneName(timeZone: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "longGeneric" })
      .formatToParts(0).find((part) => part.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

/** Every zone this browser knows (and the current one, if it does not list it), by offset then name. */
export function timeZoneOptions(current: string, locale = "en", now = Date.now()): TimeZoneOption[] {
  const listed = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const zones = [...new Set([...listed, current, "UTC"].filter(Boolean))];
  const nowSeconds = Math.floor(now / 1000);
  return zones
    .map((zone) => ({ zone, offset: timeZoneOffsetSeconds(zone, nowSeconds) }))
    .sort((left, right) => left.offset - right.offset || left.zone.localeCompare(right.zone))
    .map(({ zone }) => ({
      value: zone,
      label: `${gmtOffset(zone, nowSeconds)} ${zone.replaceAll("_", " ")}`,
      keywords: [zone, zoneName(zone, locale)].filter(Boolean),
    }));
}

/** One zone's label, for a settings row. */
export function timeZoneLabel(timeZone: string, now = Date.now()): string {
  return `${gmtOffset(timeZone, Math.floor(now / 1000))} ${timeZone.replaceAll("_", " ")}`;
}

/** The browser's zone: the new-store setup step's default. */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}
