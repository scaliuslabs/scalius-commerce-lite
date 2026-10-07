// The plugin platform's part of the scheduled tick: bundled installations in
// step with the deployed code, due cron slots, cron history retention, and
// the storage size of one app a tick (each at most once a day; the bridge
// refuses new data above the plan's size limit).
// With no bundled plugin and no active cron job it costs one indexed read.
// (Event delivery retries and their retention ride the event sweep,
// events/dispatch.ts.)

import type { Database } from "@scalius/database/client";
import { measurePluginStorage, pluginDueForStorageMeasurement, prunePluginCronRuns } from "@scalius/core/modules/plugins";
import { syncBundledPlugins, type BundledSyncResult } from "./bundled-sync";
import { runDuePluginCron, type PluginCronTickResult } from "./cron";

export async function runScheduledPluginMaintenance(
  db: Database,
  env: Env,
  ctx: ExecutionContext,
  scheduledAtMs?: number,
): Promise<{ bundled: BundledSyncResult; cron: PluginCronTickResult; prunedCronRuns: number; measured: string | null }> {
  const bundled = await syncBundledPlugins(db);
  const cron = await runDuePluginCron({ db, env, ctx, nowMs: scheduledAtMs ?? Date.now() });
  const prunedCronRuns = await prunePluginCronRuns(db);
  const measured = await pluginDueForStorageMeasurement(db);
  if (measured) await measurePluginStorage(db, measured);
  return { bundled, cron, prunedCronRuns, measured };
}
