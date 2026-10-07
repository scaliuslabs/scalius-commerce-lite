import { commerceCalendarDateKey } from "@scalius/shared/commerce-time";
import { getStoreTimeZone } from "./store-time-zone";

/** Today (or an instant's day) on the store calendar, as YYYY-MM-DD. */
export function adminCalendarDateKey(value: Date | number = new Date()): string {
  return commerceCalendarDateKey(getStoreTimeZone(), value);
}
