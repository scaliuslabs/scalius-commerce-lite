/**
 * Maintenance slices. The cron fires every 15 minutes; the sweeps are grouped
 * into slices and the plan profile (`planLimits().maintenance.slices`) says how
 * many slices the cron rotates through. On Workers Free one run may use 10 ms of
 * CPU and 50 D1 queries, which all the sweeps together do not fit, so each
 * slice runs once an hour (4 slices); on Paid there is one slice and every
 * sweep runs every tick. `"every"` sweeps run on every tick on any plan: the
 * ones whose delay a buyer, a merchant or a webhook consumer would notice.
 */
import { planLimits } from "@scalius/shared/plan-limits";

/** The cron's interval: a tick is one 15-minute slot, numbered from the epoch. */
export const MAINTENANCE_TICK_MS = 15 * 60 * 1_000;

export type SweepSlice = 0 | 1 | 2 | 3 | "every";

/** The number of the tick of `scheduledAt`, or null when the time is unknown (a manual run: every sweep). */
export function maintenanceTick(scheduledAt: number | undefined): number | null {
  return typeof scheduledAt === "number" && Number.isFinite(scheduledAt)
    ? Math.floor(scheduledAt / MAINTENANCE_TICK_MS)
    : null;
}

/** Whether a sweep of `slice` is due on the tick of `scheduledAt` under `slices`. */
export function maintenanceSliceDue(
  scheduledAt: number | undefined,
  slice: SweepSlice,
  slices: number = planLimits().maintenance.slices,
): boolean {
  const tick = maintenanceTick(scheduledAt);
  if (tick === null || slice === "every") return true;
  return slice % slices === tick % slices;
}
