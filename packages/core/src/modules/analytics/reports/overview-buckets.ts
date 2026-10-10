import type { AnalyticsInstantRange } from "@scalius/shared/analytics-period";
import type { ZoneOffsetSchedule } from "@scalius/shared/commerce-time";

type Interval = [start: number, endExclusive: number];
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

/** Complete UTC buckets, with exact fact intervals wherever a boundary cuts one. */
export function overviewReadRanges(instants: AnalyticsInstantRange, offsets: ZoneOffsetSchedule): {
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
