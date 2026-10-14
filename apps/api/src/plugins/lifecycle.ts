// Installation lifecycle with the plugin's hooks (docs/platform/PLUGINS.md,
// "Lifecycle"). Plugin code runs only under an approved grant, so:
//
//   activate    approve the grant (Super Admin; core records the approver and
//               grant key), then `install` on the first activation and
//               `activate` every time;
//   feature on  approve that feature's access (Super Admin), then `enable`
//               with `{ feature }`;
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
  deactivatePlugin,
  markPluginFailed,
  pluginNeedsApproval,
  requirePluginInstallation,
  restorePluginRelease,
  setPluginFeature,
  uninstallPlugin,
  updatePluginInstallation,
  type PluginInstallation,
} from "@scalius/core/modules/plugins";
import type { PluginManifest } from "@scalius/shared/plugins";
import { PluginHost, type PluginHostOptions } from "./host";
import { syncPluginMetaobjects } from "./metaobjects";

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
  const installation = await activatePlugin(context.db, pluginId, options);
  const turnedOn = installation.features.filter((feature) => !before.features.includes(feature));
  // The app's content types (manifest.metaobjects), created or updated in its namespace.
  const typeProblems = await syncPluginMetaobjects(context.db, installation);
  const host = hostFor(context);
  // Approving an update that waited for more access: the new code loads and
  // its data updates run now, and a failure puts back the release it replaced.
  if (pluginNeedsApproval(before) && before.source !== "bundled") {
    const failure = await startNewRelease(host, installation);
    if (failure) {
      const restored = await rollBackApprovedUpdate(context, installation, failure);
      if (restored) return { installation: restored, hookError: `The update was undone. ${failure}` };
      await markPluginFailed(context.db, pluginId, failure);
      return { installation: await requirePluginInstallation(context.db, pluginId), hookError: failure };
    }
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
  if (typeProblems) hookError = hookError ? `${typeProblems} ${hookError}` : typeProblems;
  return { installation: await requirePluginInstallation(context.db, pluginId), hookError };
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
    return { installation: await requirePluginInstallation(context.db, pluginId), changed: true, hookError };
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
 *      an update that asks for more access waits for a Super Admin, and its
 *      data updates run when it is approved and first runs;
 *   2. an app that stays active loads the new code (`checkLoads`) and runs its
 *      pending data updates at once;
 *   3. when either fails, the previous release comes back as it was
 *      (`restorePluginRelease`) and the reason is reported. Data updates that
 *      ran stay (a rollback never reverses data).
 */
export async function updatePluginToRelease(
  context: LifecycleContext,
  current: PluginInstallation,
  release: { manifest: PluginManifest; sha256: string; signerKeyId: string | null; source: "registry" | "upload" },
  options: { expectedRevision: number },
): Promise<{ installation: PluginInstallation; rolledBack: boolean; error: string | null }> {
  if (current.source === "bundled") {
    throw new PluginError("installation.source_conflict", `${current.manifest.name} is compiled into this deployment: update it with pnpm plugin add, then deploy.`);
  }
  const updated = await updatePluginInstallation(context.db, current.pluginId, {
    manifest: release.manifest,
    source: release.source,
    bundleSha256: release.sha256,
    expectedRevision: options.expectedRevision,
    signerKeyId: release.signerKeyId,
  });
  if (updated.status !== "active") {
    // It waits for a Super Admin: keep the release it replaced so approval can still roll back.
    if (pluginNeedsApproval(updated)) await saveRollbackPoint(context.env, current);
    return { installation: updated, rolledBack: false, error: null };
  }
  const host = hostFor(context);
  const failure = await startNewRelease(host, updated);
  if (!failure) {
    const typeProblems = await syncPluginMetaobjects(context.db, updated);
    return { installation: await requirePluginInstallation(context.db, current.pluginId), rolledBack: false, error: typeProblems };
  }
  const latest = await requirePluginInstallation(context.db, current.pluginId);
  const restored = await restorePluginRelease(context.db, current, {
    expectedRevision: latest.revision,
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

async function saveRollbackPoint(env: Env, previous: PluginInstallation): Promise<void> {
  try {
    await env.BUCKET.put(pluginRollbackKey(previous.pluginId), JSON.stringify(previous), { httpMetadata: { contentType: "application/json" } });
  } catch {
    console.warn(`[plugins] ${previous.pluginId} rollback point not saved`);
  }
}

/** Puts back the release saved when the update started waiting; null when none matches. */
async function rollBackApprovedUpdate(context: LifecycleContext, installation: PluginInstallation, failure: string): Promise<PluginInstallation | null> {
  try {
    const object = await context.env.BUCKET.get(pluginRollbackKey(installation.pluginId));
    if (!object || !("arrayBuffer" in object)) return null;
    const previous = JSON.parse(new TextDecoder().decode(await object.arrayBuffer())) as PluginInstallation;
    if (previous.pluginId !== installation.pluginId || previous.version === installation.version) return null;
    const latest = await requirePluginInstallation(context.db, installation.pluginId);
    return await restorePluginRelease(context.db, previous, {
      expectedRevision: latest.revision,
      reason: `Update to ${installation.version} was rolled back. ${failure}`,
    });
  } catch {
    return null;
  }
}

export async function uninstallPluginWithHooks(
  context: LifecycleContext,
  pluginId: string,
  options: { expectedRevision: number; keepData: boolean },
): Promise<{ hookError: string | null }> {
  const current = await requirePluginInstallation(context.db, pluginId);
  let hookError: string | null = null;
  if (current.status === "active" && current.revision === options.expectedRevision) {
    const outcome = await hostFor(context).invokeLifecycle(current, "uninstall", { keepData: options.keepData });
    if (!outcome.ok) hookError = outcome.error;
  }
  await uninstallPlugin(context.db, pluginId, options);
  return { hookError };
}
