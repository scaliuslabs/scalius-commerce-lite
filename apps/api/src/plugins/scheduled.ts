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
import { claimSystemKv, deleteSystemKv } from "@scalius/core/utils/system-kv";
import { planLimits } from "@scalius/shared/plan-limits";
import { workerCacheHint } from "@scalius/shared/worker-cache-hint";

const BUNDLED_SYNCED_FOR_VERSION_KEY = "plugins:bundled-synced-for-version";

/**
 * A new deployment brings its bundled apps in step on the first tick after it
 * goes live, not on plugin maintenance's turn in the sweep rotation (about
 * every 23 minutes): until then an app whose manifest changed reads as
 * unreadable and does nothing (its payment methods leave checkout). Once per
 * Worker version, claimed in system_kv; the per-colo hint makes every later
 * tick free. A failed sync releases the claim, so the next tick retries. Each
 * tick syncs at most the plan's `bundledAppSyncsPerTick` apps (an install fills
 * most of a Free tick's 50 D1 queries) and releases the claim while any app is
 * still behind, so the following ticks finish the rest.
 */
export async function syncBundledPluginsOncePerDeploy(db: Database, env: Env): Promise<BundledSyncResult | null> {
  const version = env.CF_VERSION_METADATA?.id;
  if (typeof version !== "string" || version === "") return null;
  const hint = workerCacheHint(env, "bundled-sync", 86_400);
  if ((await hint?.get("synced").catch(() => null)) === "1") return null;
  if (!(await claimSystemKv(db, BUNDLED_SYNCED_FOR_VERSION_KEY, version))) {
    await hint?.put("synced", "1").catch(() => undefined);
    return null;
  }
  try {
    const result = await syncBundledPlugins(db, undefined, planLimits().background.bundledAppSyncsPerTick);
    if (result.pending) {
      await deleteSystemKv(db, BUNDLED_SYNCED_FOR_VERSION_KEY);
      return result;
    }
    await hint?.put("synced", "1").catch(() => undefined);
    return result;
  } catch (error) {
    await deleteSystemKv(db, BUNDLED_SYNCED_FOR_VERSION_KEY).catch(() => undefined);
    throw error;
  }
}

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
