// Bundled plugins in the database (docs/platform/PLUGINS.md, "Lifecycle"):
// every plugin compiled into this Worker (bundled.gen.ts) has an installation
// row, kept in step with the deployed code. Idempotent and stateless: it runs
// when the Apps page or API lists plugins, on the scheduled tick, and when the
// host meets an installation whose version the deployment no longer carries.
//
//   - not installed            → installed (nothing runs until a Super Admin activates it)
//   - same version and SHA-256 → nothing (no module is loaded)
//   - new version or SHA-256   → updated in place: an active (or failed) plugin
//     stays active when its approved grant covers the new manifest, else it
//     waits for approval (`pluginNeedsApproval`); others keep their status.
//
// A plugin id installed from another source (registry, upload) is left alone.
// Uninstalling a bundled plugin resets it: it appears again as installed.
// Remove it from the deployment with `pnpm plugin remove`: after the deploy,
// its bundled installation is uninstalled keeping its data (records, KV,
// logs, custom fields), so the Apps page lists only apps this deployment
// can run. Its settings and approval go with the installation.

import type { Database } from "@scalius/database/client";
import {
  PluginError,
  installPlugin,
  listPluginInstallations,
  requirePluginInstallation,
  uninstallPlugin,
  updatePluginInstallation,
  type PluginInstallation,
} from "@scalius/core/modules/plugins";
import { pluginDefinitionOf } from "@scalius/shared/plugins/handlers";
import { BUNDLED_PLUGINS } from "./bundled.gen";
import type { BundledPluginEntry } from "./loaders/bundled";

export type BundledPluginRegistry = Readonly<Record<string, BundledPluginEntry>>;

export interface BundledSyncResult {
  installed: string[];
  updated: string[];
  /** Bundled installations whose code this deployment no longer carries: uninstalled, data kept. */
  removed: string[];
  /** Plugins whose code could not be loaded or whose manifest is not installable (logged, skipped). */
  failed: Array<{ pluginId: string; reason: string }>;
}

async function bundledManifest(entry: BundledPluginEntry): Promise<unknown> {
  const definition = pluginDefinitionOf(await entry.load());
  return definition?.manifest;
}

function needsSync(entry: BundledPluginEntry, installation: PluginInstallation | undefined): boolean {
  if (!installation) return true;
  if (installation.source !== "bundled") return false;
  return installation.version !== entry.version || installation.bundleSha256 !== entry.sha256;
}

async function syncOne(
  db: Database,
  pluginId: string,
  entry: BundledPluginEntry,
  installation: PluginInstallation | undefined,
  result: BundledSyncResult,
): Promise<void> {
  try {
    const manifest = await bundledManifest(entry);
    if (!installation) {
      try {
        await installPlugin(db, { manifest, source: "bundled", bundleSha256: entry.sha256 });
        result.installed.push(pluginId);
      } catch (error) {
        // A concurrent sync installed it first.
        if (!(error instanceof PluginError && error.pluginCode === "installation.exists")) throw error;
      }
      return;
    }
    await updatePluginInstallation(db, pluginId, {
      manifest,
      source: "bundled",
      bundleSha256: entry.sha256,
      expectedRevision: installation.revision,
    });
    result.updated.push(pluginId);
  } catch (error) {
    if (error instanceof PluginError && error.pluginCode === "installation.revision_conflict") return; // another sync won
    const reason = error instanceof Error ? error.message.slice(0, 300) : "unknown error";
    console.warn(`[plugins] Bundled plugin ${pluginId} could not be synced: ${reason}`);
    result.failed.push({ pluginId, reason });
  }
}

/** Brings every bundled plugin's installation in step with the deployed code. */
export async function syncBundledPlugins(
  db: Database,
  registry: BundledPluginRegistry = BUNDLED_PLUGINS,
): Promise<BundledSyncResult> {
  const result: BundledSyncResult = { installed: [], updated: [], removed: [], failed: [] };
  const ids = Object.keys(registry);
  const installations = new Map((await listPluginInstallations(db)).map((installation) => [installation.pluginId, installation]));
  for (const installation of installations.values()) {
    if (installation.source !== "bundled" || Object.prototype.hasOwnProperty.call(registry, installation.pluginId)) continue;
    try {
      await uninstallPlugin(db, installation.pluginId, { keepData: true, expectedRevision: installation.revision });
      result.removed.push(installation.pluginId);
    } catch (error) {
      if (error instanceof PluginError && error.pluginCode === "installation.revision_conflict") continue; // another sync won
      throw error;
    }
  }
  for (const pluginId of ids.sort()) {
    const entry = registry[pluginId]!;
    const installation = installations.get(pluginId);
    if (!needsSync(entry, installation)) continue;
    await syncOne(db, pluginId, entry, installation, result);
  }
  return result;
}

/**
 * One bundled plugin, when the host found its installation behind the
 * deployed code. Returns the fresh installation, or null when the plugin is
 * not bundled here or could not be synced.
 */
export async function syncBundledPlugin(
  db: Database,
  pluginId: string,
  registry: BundledPluginRegistry = BUNDLED_PLUGINS,
): Promise<PluginInstallation | null> {
  const entry = Object.prototype.hasOwnProperty.call(registry, pluginId) ? registry[pluginId] : undefined;
  if (!entry) return null;
  const current = await requirePluginInstallation(db, pluginId).catch(() => undefined);
  const result: BundledSyncResult = { installed: [], updated: [], removed: [], failed: [] };
  if (needsSync(entry, current)) await syncOne(db, pluginId, entry, current, result);
  if (result.failed.length > 0) return null;
  return requirePluginInstallation(db, pluginId).catch(() => null);
}
