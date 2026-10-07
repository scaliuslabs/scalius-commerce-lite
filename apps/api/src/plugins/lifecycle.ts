// Installation lifecycle with the plugin's hooks (docs/platform/PLUGINS.md,
// "Lifecycle"). Plugin code runs only under an approved grant, so:
//
//   activate    approve the grant (Super Admin; core records the approver and
//               grant key), move the configuration of any retired built-in
//               provider the plugin replaced into its settings
//               (provider-handoff.ts), then `install` on the first activation
//               and `activate` every time;
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
  requirePluginInstallation,
  restorePluginRelease,
  uninstallPlugin,
  updatePluginInstallation,
  type PluginInstallation,
} from "@scalius/core/modules/plugins";
import type { PluginManifest } from "@scalius/shared/plugins";
import { qualifiedSettingLabel } from "@scalius/shared/plugins/settings-layout";
import { getCredentialEncryptionKey } from "../utils/encryption-key";
import { PluginHost, type PluginHostOptions } from "./host";
import { handOffRetiredProviders } from "./provider-handoff";

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
  options: { actorUserId: string; expectedRevision: number; expectedGrantKey: string },
): Promise<{ installation: PluginInstallation; hookError: string | null }> {
  const before = await requirePluginInstallation(context.db, pluginId);
  let installation = await activatePlugin(context.db, pluginId, options);
  let handoffError: string | null = null;
  try {
    const handoff = await handOffRetiredProviders(context.db, pluginId, getCredentialEncryptionKey(context.env as unknown as Record<string, unknown>));
    if (handoff.skipped.length > 0) {
      const label = (key: string) => qualifiedSettingLabel(installation.manifest, key);
      handoffError = `Some saved keys could not be moved. Enter them again in ${installation.manifest.name}'s settings: ${handoff.skipped.map(label).join(", ")}.`;
    }
    if (handoff.moved.length > 0) installation = await requirePluginInstallation(context.db, pluginId);
  } catch (error) {
    console.warn(`[plugins] ${pluginId} could not take over retired providers (${error instanceof Error ? error.name : typeof error})`);
    handoffError = `${installation.manifest.name} could not move the keys saved before it. Activate it again, or enter them in its settings.`;
  }
  const host = hostFor(context);
  let hookError: string | null = null;
  if (before.activatedAt === null) {
    const install = await host.invokeLifecycle(installation, "install");
    if (!install.ok) hookError = install.error;
  }
  const activate = await host.invokeLifecycle(installation, "activate");
  if (!activate.ok) hookError ??= activate.error;
  if (handoffError) hookError = hookError ? `${handoffError} ${hookError}` : handoffError;
  return { installation: await requirePluginInstallation(context.db, pluginId), hookError };
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
  if (updated.status !== "active") return { installation: updated, rolledBack: false, error: null };
  const host = hostFor(context);
  const loads = await host.checkLoads(updated);
  let failure: string | null = loads.ok ? null : `The new version could not start: ${loads.error ?? "unknown error"}`;
  if (!failure) {
    const migrated = await host.runPendingMigrations(updated);
    if (!migrated.ok) failure = `Data update ${migrated.version} failed: ${migrated.error}`;
  }
  if (!failure) return { installation: await requirePluginInstallation(context.db, current.pluginId), rolledBack: false, error: null };
  const latest = await requirePluginInstallation(context.db, current.pluginId);
  const restored = await restorePluginRelease(context.db, current, {
    expectedRevision: latest.revision,
    reason: `Update to ${release.manifest.version} was rolled back. ${failure}`,
  });
  return { installation: restored, rolledBack: true, error: failure };
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
