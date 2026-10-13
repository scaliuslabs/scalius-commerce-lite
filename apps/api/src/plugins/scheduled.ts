// The plugin platform's part of the sweep rotation: bundled installations in
// step with the deployed code, due cron slots and cron history retention; and,
// on the nightly pass, every app's storage size (the bridge refuses new data
// above the plan's size limit).
// With no bundled plugin and no active cron job it costs one indexed read;
// market exchange rates refresh only while an exchange rate app is active.
// (Event delivery retries and their retention ride the event sweep,
// events/dispatch.ts.)

import type { Database } from "@scalius/database/client";
import { measureDuePluginStorageStatement, prunePluginCronRunsStatement } from "@scalius/core/modules/plugins";
import { safeBatch } from "@scalius/database/client";
import { syncBundledPlugins, type BundledSyncResult } from "./bundled-sync";
import { runDuePluginCron, type PluginCronTickResult } from "./cron";
import type { MarketFxRefreshResult } from "@scalius/core/modules/markets";

export async function runScheduledPluginMaintenance(
  db: Database,
  env: Env,
  ctx: ExecutionContext,
  scheduledAtMs?: number,
  options: { fxDue?: boolean } = {},
): Promise<{ bundled: BundledSyncResult; cron: PluginCronTickResult; prunedCronRuns: number; fx: MarketFxRefreshResult | null }> {
  const bundled = await syncBundledPlugins(db);
  const cron: PluginCronTickResult = await runDuePluginCron({ db, env, ctx, nowMs: scheduledAtMs ?? Date.now() });
  // Exchange rates from apps (markets.fx_rate_source), hourly (the caller
  // says when), only while an exchange rate app is active.
  const fx = bundled.fxApps && options.fxDue
    ? await (await import("./providers/fx")).refreshAppFxRates(db, env)
    : null;
  return { bundled, cron, prunedCronRuns: (await prunePluginCronRunsStatement(db)).length, fx };
}

/** Once a day (the nightly pass): every app's storage size. Returns how many apps were measured. */
export async function measurePluginStorage(db: Database): Promise<number> {
  const [measured] = await safeBatch(db, [measureDuePluginStorageStatement(db)] as const);
  return measured.length;
}
