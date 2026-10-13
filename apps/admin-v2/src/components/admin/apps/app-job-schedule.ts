import { parsePluginCronSchedule } from "@scalius/shared/plugins/cron";
import { formatDateTime, formatNumber, translate } from "~/i18n";
import { installedAppsMessages } from "~/i18n/apps";

/** Describe only exact common patterns; never approximate cron's day-of-month/weekday OR rule. */
export function appJobScheduleText(expression: string): string {
  const schedule = parsePluginCronSchedule(expression);
  const fallback = () => translate(installedAppsMessages, "scheduleAppDefined");
  if (typeof schedule === "string" || schedule.dayOfMonth.restricted || !schedule.month.allowed.slice(1).every(Boolean)) return fallback();
  const values = (allowed: boolean[]) => allowed.flatMap((enabled, value) => enabled ? [value] : []);
  const minutes = values(schedule.minute.allowed);
  const hours = values(schedule.hour.allowed);
  const weekdays = values(schedule.dayOfWeek.allowed);
  if (!schedule.dayOfWeek.restricted && hours.length === 24) {
    if (minutes.length === 60) return translate(installedAppsMessages, "scheduleEveryMinute");
    const interval = minutes[1];
    if (interval && 60 % interval === 0 && minutes.length === 60 / interval && minutes.every((minute, index) => minute === index * interval)) {
      return translate(installedAppsMessages, interval < 15 ? "scheduleFrequentMinutes" : "scheduleEveryMinutes", { count: interval });
    }
    if (minutes.length === 1) return translate(installedAppsMessages, "scheduleHourly", { minute: formatNumber(minutes[0]!, { minimumIntegerDigits: 2 }) });
  }
  if (hours.length !== 1 || minutes.length !== 1) return fallback();
  // A UTC carrier formats the declared wall time without shifting it to the viewer's or store's zone.
  const carrier = new Date(Date.UTC(2023, 0, 1, hours[0], minutes[0]));
  const time = formatDateTime(carrier, { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  if (!schedule.dayOfWeek.restricted) return translate(installedAppsMessages, "scheduleDaily", { time });
  if (weekdays.length !== 1) return fallback();
  carrier.setUTCDate(1 + weekdays[0]!);
  const day = formatDateTime(carrier, { weekday: "long", timeZone: "UTC" });
  return translate(installedAppsMessages, "scheduleWeekly", { day, time });
}
