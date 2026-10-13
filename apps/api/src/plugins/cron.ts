// Plugin cron (docs/platform/PLUGINS.md, "Extension points" 5), run from the
// API's sweep rotation (every 15 minutes on Paid, every 24 minutes on Free;
// scheduled/slices.ts). Each tick, for every job of every active plugin, the latest
// slot of its schedule at or before now (store wall clock, 24 hour lookback)
// runs once:
//
//   - a slot is claimed by inserting its `plugin_cron_runs` row, so two ticks
//     (or two Workers) can never both run it;
//   - one running row per job (partial unique index): runs never overlap;
//   - slots before the plugin's activation never run, and a missed tick runs
//     only the latest slot (no backlog);
//   - a schedule finer than the tick coalesces to one run per tick;
//   - at most `planLimits().background.pluginCronPerRun` runs per tick,
//     sequentially, and none starts after the tick's time budget; the rest
//     wait for the next tick.
//
// With no active cron job a tick costs one indexed read.

import type { Database } from "@scalius/database/client";
import {
  claimPluginCronRun,
  expireStalePluginCronRuns,
  finishPluginCronRun,
  listActiveCronJobs,
  releasePluginCronRun,
} from "@scalius/core/modules/plugins";
import { latestPluginCronSlot, parsePluginCronSchedule } from "@scalius/shared/plugins/cron";
import type { PluginHostOptions } from "./host";
import { planLimits } from "@scalius/shared/plan-limits";
import { storeTimeZoneOf } from "../utils/store-time-zone";

/** No run starts this long after the tick began (each run is bounded by its own wall time). */
export const PLUGIN_CRON_TICK_BUDGET_MS = 3 * 60 * 1000;
/** How far back a missed slot is still run. */
export const PLUGIN_CRON_LOOKBACK_MINUTES = 24 * 60;

export interface PluginCronTickResult {
  due: number;
  ran: number;
  failed: number;
  /** Already claimed by another tick, or another run of the job is still going. */
  skipped: number;
  /** Left for the next tick (run cap or time budget). */
  deferred: number;
  expired: number;
}

type CronJob = Awaited<ReturnType<typeof listActiveCronJobs>>[number];

function dueCronJobs(jobs: readonly CronJob[], nowMs: number, timeZone: string) {
  const due: Array<{ job: CronJob; slot: number }> = [];
  for (const job of jobs) {
    const declared = job.installation.manifest.cron.find((entry) => entry.name === job.name);
    const schedule = declared ? parsePluginCronSchedule(declared.schedule) : null;
    if (!schedule || typeof schedule === "string") continue;
    const slotMs = latestPluginCronSlot(schedule, nowMs, {
      timeZone,
      lookbackMinutes: PLUGIN_CRON_LOOKBACK_MINUTES,
    });
    if (slotMs === null) continue;
    const slot = Math.floor(slotMs / 1000);
    if (job.installation.activatedAt === null || slot < job.installation.activatedAt) continue;
    due.push({ job, slot });
  }
  return due;
}

export async function runDuePluginCron(options: {
  db: Database;
  env: Env;
  ctx: ExecutionContext;
  nowMs?: number;
  maxRuns?: number;
  budgetMs?: number;
  loaderFor?: PluginHostOptions["loaderFor"];
}): Promise<PluginCronTickResult> {
  const result: PluginCronTickResult = { due: 0, ran: 0, failed: 0, skipped: 0, deferred: 0, expired: 0 };
  const { db } = options;
  const jobs = await listActiveCronJobs(db);
  if (jobs.length === 0) return result;
  const nowMs = options.nowMs ?? Date.now();
  const started = Date.now();
  result.expired = await expireStalePluginCronRuns(db);

  const due = dueCronJobs(jobs, nowMs, storeTimeZoneOf(options.env));
  result.due = due.length;
  if (due.length === 0) return result;

  const { PluginHost } = await import("./host");
  const host = new PluginHost({ env: options.env, ctx: options.ctx, db, ...(options.loaderFor ? { loaderFor: options.loaderFor } : {}) });
  const maxRuns = options.maxRuns ?? planLimits().background.pluginCronPerRun;
  const budgetMs = options.budgetMs ?? PLUGIN_CRON_TICK_BUDGET_MS;
  for (const { job, slot } of due) {
    if (result.ran >= maxRuns || Date.now() - started >= budgetMs) {
      result.deferred += 1;
      continue;
    }
    const claim = await claimPluginCronRun(db, { pluginId: job.installation.pluginId, cronName: job.name, scheduledFor: slot });
    if (!claim) {
      result.skipped += 1;
      continue;
    }
    const runStarted = Date.now();
    const outcome = await host.invokeCron(job.installation, job.name, new Date(slot * 1000).toISOString());
    if (outcome.failure === "outdated") {
      // Updated to the deployed build just now: the next tick runs this slot.
      await releasePluginCronRun(db, claim);
      result.deferred += 1;
      continue;
    }
    await finishPluginCronRun(db, claim, { ok: outcome.ok, error: outcome.error, durationMs: Date.now() - runStarted });
    result.ran += 1;
    if (!outcome.ok) result.failed += 1;
  }
  return result;
}

