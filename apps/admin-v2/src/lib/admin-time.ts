import { unixToDate } from "@scalius/shared/timestamps";
import {
  COMMERCE_TIME_ZONE,
  commerceCalendarDateKey,
  formatCommerceCalendarDate,
} from "@scalius/shared/commerce-time";

export const ADMIN_TIME_ZONE = COMMERCE_TIME_ZONE;

export type AdminTimestamp = Date | string | number;

const ADMIN_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: ADMIN_TIME_ZONE,
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const ADMIN_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: ADMIN_TIME_ZONE,
  year: "numeric",
  month: "short",
  day: "numeric",
});

const ADMIN_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: ADMIN_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function toAdminDate(
  value: AdminTimestamp | null | undefined,
): Date | null {
  const date = unixToDate(value);
  return date && Number.isFinite(date.getTime()) ? date : null;
}

export function formatAdminTimestamp(
  value: AdminTimestamp | null | undefined,
): string | null {
  const date = toAdminDate(value);
  return date ? ADMIN_TIMESTAMP_FORMATTER.format(date) : null;
}

export function formatAdminDate(
  value: AdminTimestamp | null | undefined,
): string | null {
  const date = toAdminDate(value);
  return date ? ADMIN_DATE_FORMATTER.format(date) : null;
}

export function formatAdminTime(
  value: AdminTimestamp | null | undefined,
): string | null {
  const date = toAdminDate(value);
  return date ? ADMIN_TIME_FORMATTER.format(date) : null;
}

export function formatAdminCalendarDate(
  value: string,
  options?: Intl.DateTimeFormatOptions,
): string {
  return formatCommerceCalendarDate(value, options);
}

export function adminCalendarDateKey(value: Date | number = new Date()): string {
  return commerceCalendarDateKey(value);
}
