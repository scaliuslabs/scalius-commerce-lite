// An app update replaces its manifest, and with it the only copy of the
// templates the store's theme may have been applied from. Before it does,
// each of the app's templates the store's theme uses (the live theme, the
// draft or a remembered design) and keeps no base for is recorded as that
// template's base (`theme_template_bases`, source `update`): the release the
// store was on, assumed to be the one it applied, since the store kept no
// record of the apply. A template update then merges against it
// (`planStorefrontTemplateUpdate`); a store that recorded its apply keeps
// that record. Written in the update's own batch, so it records exactly the
// release the update replaces.
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { themeSettings, themeSettingsDrafts, themeTemplateBases, themeTemplateDesigns } from "@scalius/database/schema";
import type { PluginManifest } from "@scalius/shared/plugins";

/** The installation an update replaces: its manifest (null when it no longer reads) and release. */
export interface TemplateBaseRelease {
  manifest: PluginManifest | null;
  version?: string;
}

/**
 * The statements that record, before an app update, the base of each of its
 * templates the store's theme uses and has no base for. Empty when the app
 * ships no template, the store uses none of them, or the replaced manifest
 * no longer reads.
 */
export async function themeTemplateBasesBeforeUpdate(db: Database, pluginId: string, previous: TemplateBaseRelease) {
  const templates = previous.manifest?.storefront.templates ?? [];
  if (templates.length === 0 || !previous.version) return [];
  const keys = templates.map((template) => `${pluginId}/${template.id}`);
  const [used, recorded] = await Promise.all([
    usedTemplateKeys(db),
    db.select({ key: themeTemplateBases.template }).from(themeTemplateBases).where(inArray(themeTemplateBases.template, keys)),
  ]);
  const known = new Set(recorded.map((row) => row.key));
  return templates.flatMap((template) => {
    const key = `${pluginId}/${template.id}`;
    if (!used.has(key) || known.has(key)) return [];
    return [db.insert(themeTemplateBases).values({
      template: key,
      pluginId,
      appVersion: previous.version!,
      themeVersion: template.themeVersion,
      theme: JSON.stringify(template.theme ?? {}),
      source: "update",
      recordedAt: sql`unixepoch()`,
    }).onConflictDoNothing({ target: themeTemplateBases.template })];
  });
}

/** The template keys the store's theme uses: the live theme's, the draft's and each remembered design's. */
async function usedTemplateKeys(db: Database): Promise<Set<string>> {
  const usedKey = (column: typeof themeSettings.colors | typeof themeSettingsDrafts.theme) => sql<string | null>`json_extract(${column}, '$.apps.template')`;
  const [live, draft, designs] = await Promise.all([
    db.select({ key: usedKey(themeSettings.colors) }).from(themeSettings),
    db.select({ key: usedKey(themeSettingsDrafts.theme) }).from(themeSettingsDrafts),
    db.select({ key: themeTemplateDesigns.template }).from(themeTemplateDesigns),
  ]);
  return new Set([...live, ...draft, ...designs].map((row) => row.key).filter((key): key is string => typeof key === "string"));
}

/**
 * When an app is uninstalled, the bases of its templates the store's theme no
 * longer uses go with it (one it still uses stays: a reinstall's update
 * merges against it).
 */
export async function themeTemplateBasesAfterUninstall(db: Database, pluginId: string) {
  const used = [...await usedTemplateKeys(db)];
  return [db.delete(themeTemplateBases).where(and(
    eq(themeTemplateBases.pluginId, pluginId),
    ...(used.length > 0 ? [notInArray(themeTemplateBases.template, used)] : []),
  ))];
}
