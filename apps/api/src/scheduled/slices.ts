/**
 * The scheduled tick. The cron fires every minute. Every tick runs the
 * background drains (scheduled-maintenance.ts `BACKGROUND_DRAINS`): the
 * retries and backstop of work first attempted right after the write that
 * created it. A sweep tick also runs the next jobs of the sweep rotation
 * (`MAINTENANCE_SWEEPS`, in list order, wrapping). The plan profile says how
 * often a sweep tick comes (`maintenance.sweepEveryMinutes`) and how many
 * jobs it runs (`maintenance.sweepsPerTick`):
 *
 * - Workers Free allows 50 D1 queries per invocation, which the drains and
 *   all the jobs together do not fit. Every minute runs the drains and one
 *   job, so each job runs once per rotation (one minute per job).
 * - Paid runs every job on every fifteenth minute.
 *
 * A manual run (no scheduled time) runs every job.
 */
import { planLimits, type PlanLimits } from "@scalius/shared/plan-limits";

/** The cron's interval (`* * * * *`). */
export const DRAIN_TICK_MS = 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;

type MaintenanceLimits = PlanLimits["maintenance"];

function minuteOf(scheduledAt: number | undefined): number | null {
  return typeof scheduledAt === "number" && Number.isFinite(scheduledAt)
    ? Math.floor(scheduledAt / DRAIN_TICK_MS)
    : null;
}

/** The rotation positions (indexes into a list of `count` jobs) due on the tick of `scheduledAt`. */
export function dueSweepIndexes(
  scheduledAt: number | undefined,
  count: number,
  limits: MaintenanceLimits = planLimits().maintenance,
): number[] {
  if (count <= 0) return [];
  const minute = minuteOf(scheduledAt);
  if (minute === null) return Array.from({ length: count }, (_, index) => index);
  if (minute % limits.sweepEveryMinutes !== 0) return [];
  const perTick = Math.min(limits.sweepsPerTick, count);
  const start = ((minute / limits.sweepEveryMinutes) * perTick) % count;
  return Array.from({ length: perTick }, (_, index) => (start + index) % count);
}

/** How often each of `count` jobs runs, in minutes. */
export function sweepPeriodMinutes(count: number, limits: MaintenanceLimits = planLimits().maintenance): number {
  const perTick = Math.max(1, Math.min(limits.sweepsPerTick, count));
  return Math.ceil(count / perTick) * limits.sweepEveryMinutes;
}

/**
 * Whether a job of a `count`-job rotation running at `scheduledAt` is its
 * first run of the clock hour: true exactly once an hour while the rotation
 * period is at most an hour (and on a manual run). Hourly work inside a job
 * (exchange rates) keys off it.
 */
export function firstSweepRunOfHour(
  scheduledAt: number | undefined,
  count: number,
  limits: MaintenanceLimits = planLimits().maintenance,
): boolean {
  if (typeof scheduledAt !== "number" || !Number.isFinite(scheduledAt)) return true;
  return scheduledAt % HOUR_MS < sweepPeriodMinutes(count, limits) * DRAIN_TICK_MS;
}
