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
  activatePlugin,
  deactivatePlugin,
  requirePluginInstallation,
  uninstallPlugin,
  type PluginInstallation,
} from "@scalius/core/modules/plugins";
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
      const labels = new Map(installation.manifest.settings.map((field) => [field.key, field.label]));
      handoffError = `Some saved keys could not be moved. Enter them again in ${installation.manifest.name}'s settings: ${handoff.skipped.map((key) => labels.get(key) ?? key).join(", ")}.`;
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
