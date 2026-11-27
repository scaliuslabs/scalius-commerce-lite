// Installation lifecycle with the plugin's hooks (packages/plugin-sdk/docs/apps.md,
// "Lifecycle"). Plugin code runs only under an approved grant, so:
//
//   activate    approve the grant (Super Admin; core records the approver and
//               grant key), then `install` on the first activation and
//               `activate` every time;
//   feature on  approve that feature's access (Super Admin), then `enable`
//               with `{ feature }`, then put its payment or SMS service to use
//               (`provider-adoption.ts`; activation does the same for the
//               features it approves, so no lane needs a second step);
//   feature off `disable` with `{ feature }` while it is still on, then revoke;
//   deactivate  `deactivate` while still active, then stop;
//   uninstall   `uninstall` (with the keep/delete choice) when the plugin is
//               active, then remove it with or without its data. Uninstalling
//               a plugin that is not active runs none of its code.
//
// A hook that fails or times out never blocks the merchant's decision: it is
// logged in the plugin's log and reported back.

import type { Database } from "@scalius/database/client";
import {
  PluginError,
  activatePlugin,
  assertAppDataDeletable,
  deactivatePlugin,
  markPluginFailed,
  requirePluginInstallation,
  restorePluginRelease,
  setPluginFeature,
  uninstallPlugin,
  updatePluginInstallation,
  type PluginInstallation,
} from "@scalius/core/modules/plugins";
import type { PluginManifest } from "@scalius/shared/plugins";
import { deleteAppDataAround } from "./app-data";
import { PluginHost, type PluginHostOptions } from "./host";
import { putServicesToUse } from "./provider-adoption";

export interface LifecycleContext {
  db: Database;
  env: Env;
  ctx: ExecutionContext;
  loaderFor?: PluginHostOptions["loaderFor"];
}

function hostFor(context: LifecycleContext): PluginHost {
  return new PluginHost({ env: context.env, ctx: context.ctx, db: context.db, ...(context.loaderFor ? { loaderFor: context.loaderFor } : {}) });
}

export async function activatePluginWithHooks(
  context: LifecycleContext,
  pluginId: string,
  options: { actorUserId: string; expectedRevision: number; expectedGrantKey: string; features?: readonly string[] },
): Promise<{ installation: PluginInstallation; hookError: string | null }> {
  const before = await requirePluginInstallation(context.db, pluginId);
  let installation: PluginInstallation;
  try {
    installation = await activatePlugin(context.db, pluginId, options);
  } catch (error) {
    if (!(error instanceof PluginError) || error.pluginCode !== "installation_objects_invalid") throw error;
    const failed = await requirePluginInstallation(context.db, pluginId);
    const restored = startsWaitingRelease(before)
      ? await rollBackWaitingRelease(context, failed, error.message) : null;
    return { installation: restored ?? failed, hookError: restored ? `The update was undone. ${error.message}` : error.message };
  }
  const turnedOn = installation.features.filter((feature) => !before.features.includes(feature));
  const host = hostFor(context);
  // Starting an app that was not running: its code loads and its data
  // updates run now. A release it was updated to while it was off (and never
  // ran) is put back on failure; any other failure marks it failed. A running
  // app already started its release at the update.
  if (startsWaitingRelease(before)) {
    const failure = await startNewRelease(host, installation);
    if (failure) {
      const restored = await rollBackWaitingRelease(context, installation, failure);
      if (restored) return { installation: restored, hookError: `The update was undone. ${failure}` };
      await markPluginFailed(context.db, pluginId, failure);
      return { installation: await requirePluginInstallation(context.db, pluginId), hookError: failure };
    }
    // It started: the release it replaced can no longer come back.
    await forgetRollbackPoint(context.env, pluginId);
  }
  let hookError: string | null = null;
  if (before.activatedAt === null) {
    const install = await host.invokeLifecycle(installation, "install");
    if (!install.ok) hookError = install.error;
  }
  const activate = await host.invokeLifecycle(installation, "activate");
  if (!activate.ok) hookError ??= activate.error;
  // Features approved with the activation start like ones turned on later.
  for (const feature of turnedOn) {
    const enabled = await host.invokeLifecycle(installation, "enable", { feature });
    if (!enabled.ok) hookError ??= enabled.error;
  }
  const running = await requirePluginInstallation(context.db, pluginId);
  // Approved features adopt like ones turned on later (provider-adoption.ts).
  await putServicesToUse(context, running, turnedOn);
  return { installation: running, hookError };
}

/** An activation that starts stored code the app was not running (bundled code starts with the deployment). */
function startsWaitingRelease(before: PluginInstallation): boolean {
  return before.status !== "active" && before.source !== "bundled";
}

export async function setPluginFeatureWithHooks(
  context: LifecycleContext,
  pluginId: string,
  options: { feature: string; enabled: boolean; expectedRevision: number; expectedGrantKey?: string; actorUserId?: string },
): Promise<{ installation: PluginInstallation; changed: boolean; hookError: string | null }> {
  let hookError: string | null = null;
  if (!options.enabled) {
    const current = await requirePluginInstallation(context.db, pluginId);
    // The hook runs while the feature still has its access (to tidy up at its provider).
    if (current.status === "active" && current.revision === options.expectedRevision && current.features.includes(options.feature)) {
      const outcome = await hostFor(context).invokeLifecycle(current, "disable", { feature: options.feature });
      if (!outcome.ok) hookError = outcome.error;
    }
  }
  const result = await setPluginFeature(context.db, pluginId, options);
  if (options.enabled && result.changed) {
    const outcome = await hostFor(context).invokeLifecycle(result.installation, "enable", { feature: options.feature });
    if (!outcome.ok) hookError = outcome.error;
    const running = await requirePluginInstallation(context.db, pluginId);
    // Its payment providers join checkout, a ready SMS provider becomes the SMS service (provider-adoption.ts).
    await putServicesToUse(context, running, [options.feature]);
    return { installation: running, changed: true, hookError };
  }
  return { ...result, hookError };
}

export async function deactivatePluginWithHooks(
  context: LifecycleContext,
  pluginId: string,
  options: { expectedRevision: number },
): Promise<{ installation: PluginInstallation; hookError: string | null }> {
  const current = await requirePluginInstallation(context.db, pluginId);
  let hookError: string | null = null;
  if (current.status === "active" && current.revision === options.expectedRevision) {
    const outcome = await hostFor(context).invokeLifecycle(current, "deactivate");
    if (!outcome.ok) hookError = outcome.error;
  }
  const installation = await deactivatePlugin(context.db, pluginId, options);
  return { installation, hookError };
}

/**
 * Updates an installed registry or upload app to a verified, stored release
 * (WordPress-style update with automatic rollback):
 *
 *   1. the new code and manifest replace the old (`updatePluginInstallation`):
 *      a running app keeps running under the grant it had; what the release
 *      asks beyond it stays off until a Super Admin approves it;
 *   2. an app that is active loads the new code (`checkLoads`) and runs its
 *      pending data updates at once (a stopped app does so when it starts);
 *   3. when either fails, the previous release comes back as it was
 *      (`restorePluginRelease`) and the reason is reported. Completed data
 *      updates stay recorded; object types absent from the restored release
 *      and their records are removed.
 */
export async function updatePluginToRelease(
  context: LifecycleContext,
  current: PluginInstallation,
  release: { manifest: PluginManifest; sha256: string; signerKeyId: string | null; source: "registry" | "upload" },
  options: { expectedRevision: number },
): Promise<{ installation: PluginInstallation; rolledBack: boolean; error: string | null }> {
  if (current.source === "bundled") {
    throw new PluginError("installation_source_conflict", `${current.manifest.name} is compiled into this deployment: update it with pnpm plugin add, then deploy.`);
  }
  let updated: PluginInstallation;
  try {
    updated = await updatePluginInstallation(context.db, current.pluginId, {
      manifest: release.manifest,
      source: release.source,
      bundleSha256: release.sha256,
      expectedRevision: options.expectedRevision,
      signerKeyId: release.signerKeyId,
    });
  } catch (error) {
    if (!(error instanceof PluginError) || error.pluginCode !== "installation_objects_invalid") throw error;
    const restored = await restorePluginRelease(context.db, current, {
      undoing: release.sha256,
      reason: `Update to ${release.manifest.version} was rolled back. ${error.message}`,
    });
    return { installation: restored, rolledBack: true, error: error.message };
  }
  if (updated.status !== "active") {
    // An app that is not running starts the release later: keep the one it last ran, guarding exactly this release.
    await saveRollbackPoint(context.env, current, updated.bundleSha256);
    return { installation: updated, rolledBack: false, error: null };
  }
  // It runs now: no saved release can come back over it.
  await forgetRollbackPoint(context.env, current.pluginId);
  const host = hostFor(context);
  const failure = await startNewRelease(host, updated);
  if (!failure) {
    return { installation: await requirePluginInstallation(context.db, current.pluginId), rolledBack: false, error: null };
  }
  const restored = await restorePluginRelease(context.db, current, {
    undoing: updated.bundleSha256,
    reason: `Update to ${release.manifest.version} was rolled back. ${failure}`,
  });
  return { installation: restored, rolledBack: true, error: failure };
}

/** Loads a new release without running it, then runs its pending data updates; the failure in plain words, or null. */
async function startNewRelease(host: PluginHost, installation: PluginInstallation): Promise<string | null> {
  const loads = await host.checkLoads(installation);
  if (!loads.ok) return `The new version could not start: ${loads.error ?? "unknown error"}`;
  const migrated = await host.runPendingMigrations(installation);
  return migrated.ok ? null : `Data update ${migrated.version} failed: ${migrated.error}`;
}

/** Where the release a waiting update replaced is kept (R2, private prefix; its bundle stays beside it). */
export function pluginRollbackKey(pluginId: string): string {
  return `private/plugins/${pluginId}/rollback.json`;
}

/**
 * The release an app last ran (`previous`) and the release that replaced it
 * while the app was off (`replacedBy`, its bundle hash): it comes back only
 * while that exact release is installed and has not started.
 */
interface RollbackPoint {
  previous: PluginInstallation;
  replacedBy: string;
}

async function readRollbackPoint(env: Env, pluginId: string): Promise<RollbackPoint | null> {
  const object = await env.BUCKET.get(pluginRollbackKey(pluginId));
  if (!object || !("arrayBuffer" in object)) return null;
  const point = JSON.parse(new TextDecoder().decode(await object.arrayBuffer())) as Partial<RollbackPoint>;
  return point.previous && typeof point.replacedBy === "string" && point.previous.pluginId === pluginId ? point as RollbackPoint : null;
}

async function saveRollbackPoint(env: Env, current: PluginInstallation, replacedBy: string): Promise<void> {
  try {
    // Updated again before it ever started: the release it last ran is still the one to put back.
    const kept = await readRollbackPoint(env, current.pluginId).catch(() => null);
    const previous = kept && kept.replacedBy === current.bundleSha256 ? kept.previous : current;
    const point: RollbackPoint = { previous, replacedBy };
    await env.BUCKET.put(pluginRollbackKey(current.pluginId), JSON.stringify(point), { httpMetadata: { contentType: "application/json" } });
  } catch {
    console.warn(`[plugins] ${current.pluginId} rollback point not saved`);
  }
}

async function forgetRollbackPoint(env: Env, pluginId: string): Promise<void> {
  try {
    await env.BUCKET.delete(pluginRollbackKey(pluginId));
  } catch {
    console.warn(`[plugins] ${pluginId} rollback point not removed`);
  }
}

/** Puts back the release saved when this exact release replaced it while the app was off; null when none matches. */
async function rollBackWaitingRelease(context: LifecycleContext, installation: PluginInstallation, failure: string): Promise<PluginInstallation | null> {
  try {
    const point = await readRollbackPoint(context.env, installation.pluginId);
    if (!point) return null;
    // A point that guards another release can never apply again.
    if (point.replacedBy !== installation.bundleSha256) {
      await forgetRollbackPoint(context.env, installation.pluginId);
      return null;
    }
    const restored = await restorePluginRelease(context.db, point.previous, {
      undoing: installation.bundleSha256,
      reason: `Update to ${installation.version} was rolled back. ${failure}`,
    });
    await forgetRollbackPoint(context.env, installation.pluginId);
    return restored;
  } catch {
    return null;
  }
}

export async function uninstallPluginWithHooks(
  context: LifecycleContext,
  pluginId: string,
  options: { expectedRevision: number; keepData: boolean },
): Promise<{ hookError: string | null; catalogDeleted: number; catalogKept: number }> {
  const current = await requirePluginInstallation(context.db, pluginId);
  // Refused before the app's uninstall hook runs, so a refusal changes nothing.
  if (!options.keepData) await assertAppDataDeletable(context.db, pluginId);
  let hookError: string | null = null;
  if (current.status === "active" && current.revision === options.expectedRevision) {
    const outcome = await hostFor(context).invokeLifecycle(current, "uninstall", { keepData: options.keepData });
    if (!outcome.ok) hookError = outcome.error;
  }
  if (options.keepData) {
    await uninstallPlugin(context.db, pluginId, options);
    return { hookError, catalogDeleted: 0, catalogKept: 0 };
  }
  const deleted = await deleteAppDataAround(context.db, context.env, pluginId, () => uninstallPlugin(context.db, pluginId, options));
  return { hookError, ...deleted };
}
