// An app's content types (manifest.metaobjects): created or updated in its
// namespace when it is activated or updated (core metaobjects module). A
// type that cannot be applied (a field type its entries use) is reported in
// plain words; the rest are applied.
import type { Database } from "@scalius/database/client";
import type { PluginInstallation } from "@scalius/core/modules/plugins";

/** The problems in one sentence, or null when every declared type is in place. */
export async function syncPluginMetaobjects(db: Database, installation: PluginInstallation): Promise<string | null> {
  if (installation.manifest.metaobjects.length === 0) return null;
  const { syncAppMetaobjectDefinitions } = await import("@scalius/core/modules/metaobjects");
  try {
    const problems = await syncAppMetaobjectDefinitions(db, installation.pluginId, installation.manifest.metaobjects);
    return problems.length > 0 ? `Some of ${installation.manifest.name}'s content types were not updated: ${problems.join("; ")}` : null;
  } catch (error) {
    console.warn(`[plugins] ${installation.pluginId} content types could not be synced (${error instanceof Error ? error.name : "error"})`);
    return `${installation.manifest.name}'s content types could not be saved.`;
  }
}
