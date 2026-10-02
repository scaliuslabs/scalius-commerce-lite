// Installation lifecycle with the plugin's hooks (docs/platform/PLUGINS.md,
// "Lifecycle"). Plugin code runs only under an approved grant, so:
//
//   activate    approve the grant (Super Admin; core records the approver and
//               grant key), then `install` on the first activation and
//               `activate` every time;
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
import { PluginHost, type PluginHostOptions } from "./host";

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
  const installation = await activatePlugin(context.db, pluginId, options);
  const host = hostFor(context);
  let hookError: string | null = null;
  if (before.activatedAt === null) {
    const install = await host.invokeLifecycle(installation, "install");
    if (!install.ok) hookError = install.error;
  }
  const activate = await host.invokeLifecycle(installation, "activate");
  if (!activate.ok) hookError ??= activate.error;
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
