// Plugin cron schedules (packages/plugin-sdk/docs/apps.md, "Cron"): standard
// five-field schedules (minute hour day-of-month month day-of-week), evaluated
// in the store's time zone. The API's scheduled handler asks, once per tick,
// for the latest slot at or before now; a slot runs at most once (claimed in
// `plugin_cron_runs`), so a schedule finer than the platform tick coalesces to
// one run per tick and a missed tick runs only its latest slot, never a
// backlog. Pure (its only import is the merchant calendar): the manifest
// parser and the API share it. Part of the versioned plugin API.

import { commerceWallTimeToEpoch, timeZoneOffsetSeconds } from "../commerce-time";

/** One parsed field: `allowed[value]` for every value in the field's range. */
interface CronField {
  allowed: boolean[];
  /** False when the field is `*` (matters for the day-of-month/day-of-week rule). */
  restricted: boolean;
}

export interface PluginCronSchedule {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  /** 0 = Sunday … 6 = Saturday (7 is folded into 0). */
  dayOfWeek: CronField;
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const FIELDS = [
  { name: "minute", min: 0, max: 59, names: null },
  { name: "hour", min: 0, max: 23, names: null },
  { name: "day of month", min: 1, max: 31, names: null },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES },
  { name: "day of week", min: 0, max: 7, names: DAY_NAMES },
] as const;

function parseValue(raw: string, field: (typeof FIELDS)[number]): number | null {
  const lower = raw.toLowerCase();
  if (field.names) {
    const index = (field.names as readonly string[]).indexOf(lower);
    if (index >= 0) return field.name === "month" ? index + 1 : index;
  }
  if (!/^\d{1,2}$/.test(raw)) return null;
  const value = Number(raw);
  return value >= field.min && value <= field.max ? value : null;
}

function parseField(text: string, field: (typeof FIELDS)[number]): CronField | string {
  const allowed = new Array<boolean>(field.max + 1).fill(false);
  if (text === "*") {
    for (let value = field.min; value <= field.max; value += 1) allowed[value] = true;
    return { allowed, restricted: false };
  }
  for (const item of text.split(",")) {
    const [range, stepText, extra] = item.split("/");
    if (extra !== undefined || range === undefined || range === "") return `Invalid ${field.name} "${item}".`;
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d{1,2}$/.test(stepText) || Number(stepText) < 1) return `Invalid ${field.name} step "${item}".`;
      step = Number(stepText);
    }
    let start: number | null;
    let end: number | null;
    if (range === "*") {
      start = field.min;
      end = field.max;
    } else {
      const bounds = range.split("-");
      if (bounds.length > 2) return `Invalid ${field.name} range "${item}".`;
      start = parseValue(bounds[0]!, field);
      // `a/n` means every n from a to the end of the field (Vixie cron).
      end = bounds.length === 2 ? parseValue(bounds[1]!, field) : stepText !== undefined ? field.max : start;
    }
    if (start === null || end === null || start > end) return `Invalid ${field.name} "${item}".`;
    for (let value = start; value <= end; value += step) allowed[value] = true;
  }
  return { allowed, restricted: true };
}

/** Parses a five-field schedule; a string is the reason it is invalid. */
export function parsePluginCronSchedule(expression: string): PluginCronSchedule | string {
  if (typeof expression !== "string") return "A schedule is a string.";
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return "Use a five-field cron schedule (minute hour day month weekday).";
  const parsed: CronField[] = [];
  for (let index = 0; index < 5; index += 1) {
    const field = parseField(parts[index]!, FIELDS[index]!);
    if (typeof field === "string") return field;
    parsed.push(field);
  }
  const dayOfWeek = parsed[4]!;
  if (dayOfWeek.allowed[7]) dayOfWeek.allowed[0] = true;
  dayOfWeek.allowed.length = 7;
  return { minute: parsed[0]!, hour: parsed[1]!, dayOfMonth: parsed[2]!, month: parsed[3]!, dayOfWeek };
}

export function isPluginCronSchedule(expression: string): boolean {
  return typeof parsePluginCronSchedule(expression) !== "string";
}

function dayMatches(schedule: PluginCronSchedule, local: Date): boolean {
  const dom = schedule.dayOfMonth.allowed[local.getUTCDate()] === true;
  const dow = schedule.dayOfWeek.allowed[local.getUTCDay()] === true;
  // Both restricted: either may match (standard cron); otherwise both must.
  if (schedule.dayOfMonth.restricted && schedule.dayOfWeek.restricted) return dom || dow;
  return dom && dow;
}

const MINUTE_MS = 60_000;

/**
 * The latest minute at or before `nowMs` the schedule fires at, as epoch
 * milliseconds, searching back at most `lookbackMinutes`; null when none.
 * The schedule reads the store's wall clock in `timeZone`: across a daylight
 * saving change, a wall time the clocks skip runs just after the gap, and one
 * they repeat runs once (the earlier).
 */
export function latestPluginCronSlot(
  schedule: PluginCronSchedule,
  nowMs: number,
  options: { timeZone: string; lookbackMinutes: number },
): number | null {
  const { timeZone } = options;
  const newest = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS;
  const oldest = newest - options.lookbackMinutes * MINUTE_MS;
  const wallOf = (instantMs: number) => instantMs + timeZoneOffsetSeconds(timeZone, instantMs / 1000) * 1000;
  // Walk back in wall-clock time, skipping whole months, days and hours that
  // cannot match; an hour of margin covers a daylight saving change.
  let local = wallOf(newest);
  const oldestLocal = wallOf(oldest) - 60 * MINUTE_MS;
  while (local >= oldestLocal) {
    const date = new Date(local);
    if (!schedule.month.allowed[date.getUTCMonth() + 1]) {
      // The last minute of the previous month.
      local = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) - MINUTE_MS;
      continue;
    }
    if (!dayMatches(schedule, date)) {
      local = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - MINUTE_MS;
      continue;
    }
    if (!schedule.hour.allowed[date.getUTCHours()]) {
      local = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours()) - MINUTE_MS;
      continue;
    }
    if (!schedule.minute.allowed[date.getUTCMinutes()]) {
      local -= MINUTE_MS;
      continue;
    }
    const instant = commerceWallTimeToEpoch(
      timeZone,
      date.toISOString().slice(0, 10),
      date.getUTCHours(),
      date.getUTCMinutes(),
    );
    if (instant === null || instant * 1000 > newest) {
      local -= MINUTE_MS;
      continue;
    }
    return instant * 1000 >= oldest ? instant * 1000 : null;
  }
  return null;
}
