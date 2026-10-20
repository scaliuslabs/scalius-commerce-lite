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
//   - stored manifest unreadable → updated in place the same way: the deployed
//     code is the authority for a bundled app, its approved grant still decides.
//   - update refused            → a running app is marked failed with the
//     reason (the Apps page shows it); this deployment cannot run its old
//     release, so it never looks active while it draws nothing.
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
  markPluginFailed,
  readPluginInstallation,
  readPluginInstallations,
  requirePluginInstallation,
  uninstallPlugin,
  updatePluginInstallation,
  type PluginInstallation,
  type UnreadablePluginInstallation,
} from "@scalius/core/modules/plugins";
import { pluginDefinitionOf } from "@scalius/shared/plugins/handlers";
import { BUNDLED_PLUGINS } from "./bundled.gen";
import { loadBundledPlugin, type BundledPluginEntry } from "./loaders/bundled";

export type BundledPluginRegistry = Readonly<Record<string, BundledPluginEntry>>;

export interface BundledSyncResult {
  installed: string[];
  updated: string[];
  /** Bundled installations whose code this deployment no longer carries: uninstalled, data kept. */
  removed: string[];
  /** Plugins whose code could not be loaded or whose manifest is not installable (logged, skipped). */
  failed: Array<{ pluginId: string; reason: string }>;
  /** Whether an active app approved for the `fx` port provides exchange rates (the tick then refreshes market rates). */
  fxApps: boolean;
}

async function bundledManifest(pluginId: string, entry: BundledPluginEntry): Promise<unknown> {
  const definition = pluginDefinitionOf(await loadBundledPlugin(pluginId, entry));
  return definition?.manifest;
}

/** An installation row as the sync sees it: readable, or one whose stored manifest no longer reads. */
type StoredInstallation =
  | { readable: true; installation: PluginInstallation }
  | { readable: false; installation: UnreadablePluginInstallation };

function needsSync(entry: BundledPluginEntry, stored: StoredInstallation | undefined): boolean {
  if (!stored) return true;
  if (stored.installation.source !== "bundled") return false;
  if (!stored.readable) return true;
  return stored.installation.version !== entry.version || stored.installation.bundleSha256 !== entry.sha256;
}

async function syncOne(
  db: Database,
  pluginId: string,
  entry: BundledPluginEntry,
  stored: StoredInstallation | undefined,
  result: BundledSyncResult,
): Promise<void> {
  const installation = stored?.installation;
  try {
    const manifest = await bundledManifest(pluginId, entry);
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
    // A running app whose release this deployment cannot install: it cannot
    // run the old one either (its code is gone), so say so where the merchant
    // looks instead of leaving it active and drawing nothing. The next sync
    // that succeeds resumes it (`updatePluginInstallation`).
    if (installation?.status === "active") {
      await markPluginFailed(db, pluginId, `Version ${entry.version} in this deployment could not be installed: ${reason}`)
        .catch(() => undefined);
    }
  }
}

/** Brings every bundled plugin's installation in step with the deployed code. */
export async function syncBundledPlugins(
  db: Database,
  registry: BundledPluginRegistry = BUNDLED_PLUGINS,
): Promise<BundledSyncResult> {
  const result: BundledSyncResult = { installed: [], updated: [], removed: [], failed: [], fxApps: false };
  const ids = Object.keys(registry);
  const read = await readPluginInstallations(db);
  const installations = new Map(read.installations.map((installation) => [installation.pluginId, installation]));
  const stored = new Map<string, StoredInstallation>([
    ...read.unreadable.map((installation) => [installation.pluginId, { readable: false, installation }] as const),
    ...read.installations.map((installation) => [installation.pluginId, { readable: true, installation }] as const),
  ]);
  // Read here, once, so a store without an exchange rate app reads nothing more for rates.
  result.fxApps = [...installations.values()].some((installation) => installation.status === "active"
    && (installation.grant?.providers ?? []).includes("fx")
    && installation.manifest.providers.some((provider) => provider.kind === "fx"));
  for (const { installation } of stored.values()) {
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
    const installation = stored.get(pluginId);
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
  const current = (await readPluginInstallation(db, pluginId)) ?? undefined;
  const result: BundledSyncResult = { installed: [], updated: [], removed: [], failed: [], fxApps: false };
  if (needsSync(entry, current)) await syncOne(db, pluginId, entry, current, result);
  if (result.failed.length > 0) return null;
  return requirePluginInstallation(db, pluginId).catch(() => null);
}
