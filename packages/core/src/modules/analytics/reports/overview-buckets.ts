import { sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import type { AnalyticsInstantRange } from "@scalius/shared/analytics-period";
import type { ZoneOffsetSchedule } from "@scalius/shared/commerce-time";

type Interval = [start: number, endExclusive: number];
/** Merged [start, end) UTC spans of sealed days: their buckets equal their facts. */
export type SealedIntervals = readonly Interval[];
const DAY = 86_400;
const QUARTER_HOUR = 900;

function mergeIntervals(intervals: Interval[]): Interval[] {
  const merged: Interval[] = [];
  for (const [start, end] of intervals.sort((left, right) => left[0] - right[0])) {
    if (start >= end) continue;
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** The sealed days touching [from, to), merged into spans. */
export async function readSealedIntervals(db: Database, from: number, to: number): Promise<SealedIntervals> {
  const rows = await db.all<{ day: number }>(sql`select day from analytics_sealed_days
    where day >= ${Math.floor(from / DAY) * DAY} and day < ${Math.ceil(to / DAY) * DAY} order by day`);
  return mergeIntervals(rows.map((row): Interval => [Number(row.day), Number(row.day) + DAY]));
}

function intersect(intervals: readonly Interval[], sealed: SealedIntervals): Interval[] {
  return mergeIntervals(intervals.flatMap(([start, end]) => sealed
    .map(([lo, hi]): Interval => [Math.max(start, lo), Math.min(end, hi)])));
}

function subtract(intervals: readonly Interval[], sealed: SealedIntervals): Interval[] {
  return intervals.flatMap(([start, end]) => {
    const pieces: Interval[] = [];
    let cursor = start;
    for (const [lo, hi] of sealed) {
      if (hi <= cursor || lo >= end) continue;
      if (lo > cursor) pieces.push([cursor, lo]);
      cursor = Math.max(cursor, hi);
    }
    if (cursor < end) pieces.push([cursor, end]);
    return pieces;
  });
}

/**
 * Bucket intervals inside sealed days, and exact fact intervals wherever a
 * boundary cuts a bucket or a day is not sealed.
 */
export function overviewReadRanges(instants: AnalyticsInstantRange, offsets: ZoneOffsetSchedule, sealed: SealedIntervals = []): {
  fullDays: Interval[];
  periodEdges: Interval[];
  quarterHours: Interval[];
  dayEdges: Interval[];
} {
  const ranges = utcReadRanges(instants, offsets);
  return {
    fullDays: intersect([ranges.fullDays], sealed),
    periodEdges: mergeIntervals([...ranges.periodEdges, ...subtract([ranges.fullDays], sealed)]),
    quarterHours: intersect(ranges.quarterHours, sealed),
    dayEdges: mergeIntervals([...ranges.dayEdges, ...subtract(ranges.quarterHours, sealed)]),
  };
}

/** Complete UTC buckets, with exact fact intervals wherever a boundary cuts one. */
function utcReadRanges(instants: AnalyticsInstantRange, offsets: ZoneOffsetSchedule): {
  fullDays: Interval;
  periodEdges: Interval[];
  quarterHours: Interval[];
  dayEdges: Interval[];
} {
  const { start, endExclusive: end } = instants;
  const firstDay = Math.ceil(start / DAY) * DAY;
  const lastDay = Math.max(firstDay, Math.floor(end / DAY) * DAY);
  const periodEdges = mergeIntervals([
    [start, Math.min(end, firstDay)],
    [Math.max(start, lastDay), end],
  ]);
  // The existing merchant-day SQL truncates negative wall times toward zero;
  // an instant on their exact boundary cannot share a bucket with its remainder.
  if (start + Math.min(offsets.initialOffset, ...offsets.changes.map((change) => change.offset)) < 0) {
    return { fullDays: [firstDay, lastDay], periodEdges, quarterHours: [], dayEdges: [[start, end]] };
  }

  const boundaries = [start, end];
  let segmentStart = start;
  let offset = offsets.initialOffset;
  for (const change of [...offsets.changes, { at: end, offset }]) {
    const segmentEnd = Math.min(change.at, end);
    for (let midnight = (Math.floor((segmentStart + offset) / DAY) + 1) * DAY - offset;
      midnight < segmentEnd; midnight += DAY) {
      boundaries.push(midnight);
    }
    if (change.at > start && change.at < end) boundaries.push(change.at);
    segmentStart = segmentEnd;
    offset = change.offset;
  }
  const dayEdges = mergeIntervals(boundaries
    .filter((boundary) => boundary % QUARTER_HOUR !== 0)
    .map((boundary): Interval => {
      const bucket = Math.floor(boundary / QUARTER_HOUR) * QUARTER_HOUR;
      return [Math.max(start, bucket), Math.min(end, bucket + QUARTER_HOUR)];
    }));
  const quarterHours: Interval[] = [];
  let cursor = Math.ceil(start / QUARTER_HOUR) * QUARTER_HOUR;
  const lastQuarter = Math.floor(end / QUARTER_HOUR) * QUARTER_HOUR;
  for (const [edgeStart, edgeEnd] of dayEdges) {
    const before = Math.min(lastQuarter, Math.floor(edgeStart / QUARTER_HOUR) * QUARTER_HOUR);
    if (cursor < before) quarterHours.push([cursor, before]);
    cursor = Math.max(cursor, Math.ceil(edgeEnd / QUARTER_HOUR) * QUARTER_HOUR);
  }
  if (cursor < lastQuarter) quarterHours.push([cursor, lastQuarter]);
  return { fullDays: [firstDay, lastDay], periodEdges, quarterHours, dayEdges };
}
