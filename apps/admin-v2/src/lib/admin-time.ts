import { unixToDate } from "@scalius/shared/timestamps";

export const ADMIN_TIME_ZONE = "Asia/Dhaka";

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
