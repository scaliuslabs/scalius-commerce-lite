// The plugin platform's part of the scheduled tick: bundled installations in
// step with the deployed code, due cron slots, cron history retention, and
// every app's storage size on the nightly tick (the bridge refuses new
// data above the plan's size limit).
// With no bundled plugin and no active cron job it costs one indexed read.
// (Event delivery retries and their retention ride the event sweep,
// events/dispatch.ts.)

import type { Database } from "@scalius/database/client";
import { measureDuePluginStorageStatement, prunePluginCronRunsStatement } from "@scalius/core/modules/plugins";
import { safeBatch } from "@scalius/database/client";
import { syncBundledPlugins, type BundledSyncResult } from "./bundled-sync";
import { runDuePluginCron, type PluginCronTickResult } from "./cron";

export async function runScheduledPluginMaintenance(
  db: Database,
  env: Env,
  ctx: ExecutionContext,
  scheduledAtMs?: number,
  options: { nightly?: boolean } = {},
): Promise<{ bundled: BundledSyncResult; cron: PluginCronTickResult; prunedCronRuns: number; measured: number }> {
  const bundled = await syncBundledPlugins(db);
  const cron = await runDuePluginCron({ db, env, ctx, nowMs: scheduledAtMs ?? Date.now() });
  if (!options.nightly) return { bundled, cron, prunedCronRuns: (await prunePluginCronRunsStatement(db)).length, measured: 0 };
  // Once a day, in the same call as the prune: every app's storage size.
  const [pruned, measured] = await safeBatch(db, [prunePluginCronRunsStatement(db), measureDuePluginStorageStatement(db)] as const);
  return { bundled, cron, prunedCronRuns: pruned.length, measured: measured.length };
}
