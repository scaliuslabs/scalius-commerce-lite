// The plugin platform's part of the scheduled tick: bundled installations in
// step with the deployed code, due cron slots, and cron history retention.
// With no bundled plugin and no active cron job it costs one indexed read.
// (Event delivery retries and their retention ride the event sweep,
// events/dispatch.ts.)

import type { Database } from "@scalius/database/client";
import { prunePluginCronRuns } from "@scalius/core/modules/plugins";
import { syncBundledPlugins, type BundledSyncResult } from "./bundled-sync";
import { runDuePluginCron, type PluginCronTickResult } from "./cron";

export async function runScheduledPluginMaintenance(
  db: Database,
  env: Env,
  ctx: ExecutionContext,
  scheduledAtMs?: number,
): Promise<{ bundled: BundledSyncResult; cron: PluginCronTickResult; prunedCronRuns: number }> {
  const bundled = await syncBundledPlugins(db);
  const cron = await runDuePluginCron({ db, env, ctx, nowMs: scheduledAtMs ?? Date.now() });
  const prunedCronRuns = await prunePluginCronRuns(db);
  return { bundled, cron, prunedCronRuns };
}
