// Deleting an app's data (docs/platform/PLUGINS.md, "Uninstalling"): one path
// for an uninstall that does not keep data and for "Delete data" on a removed
// app's group. The relational delete is core's (`appDataDeleteStatements`, in
// the uninstall's batch or `deleteRemovedAppData`'s); it commits first. Then
// the catalogue items the app created that sit in the trash go through the
// staff permanent delete (its rules hold: a product with inventory history or
// orders stays), and its files under `private/plugins/<id>/` (bundles,
// storefront files, the rollback point) are removed from R2. A file stored
// after the delete started is a reinstall's and stays.

import type { Database } from "@scalius/database/client";
import { deleteRemovedAppData, listAppCreatedResources } from "@scalius/core/modules/plugins";
import { deleteTrashedAppItems } from "../routes/admin/resources-app-content";

/** R2 pages one delete reads at most (1,000 keys each); an app keeps a handful of files per release. */
const STORAGE_PAGES = 10;

export interface AppDataDeleteResult {
  /** Trashed catalogue items it created that were permanently deleted. */
  catalogDeleted: number;
  /** Trashed ones the store must keep (inventory history, orders, a file still shown). */
  catalogKept: number;
}

async function deleteAppStorage(env: Env, pluginId: string, startedAt: number): Promise<void> {
  const bucket = (env as { BUCKET?: R2Bucket }).BUCKET;
  if (!bucket || typeof bucket.list !== "function") return;
  const prefix = `private/plugins/${pluginId}/`;
  try {
    let cursor: string | undefined;
    for (let page = 0; page < STORAGE_PAGES; page += 1) {
      const listed = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
      const keys = listed.objects.filter((object) => object.uploaded.getTime() < startedAt).map((object) => object.key);
      if (keys.length > 0) await bucket.delete(keys);
      if (!listed.truncated) return;
      cursor = listed.cursor;
    }
  } catch (error) {
    console.warn(`[plugins] ${pluginId} files not removed (${error instanceof Error ? error.name : "error"})`);
  }
}

/**
 * Runs `commit` (the batch that deletes the app's relational data), then the
 * deletes that follow it. The trashed items are read before the batch drops
 * their ownership rows.
 */
export async function deleteAppDataAround(
  db: Database,
  env: Env,
  pluginId: string,
  commit: () => Promise<void>,
): Promise<AppDataDeleteResult> {
  const startedAt = Date.now();
  const created = await listAppCreatedResources(db, pluginId);
  await commit();
  const catalog = await deleteTrashedAppItems(db, env, created);
  await deleteAppStorage(env, pluginId, startedAt);
  return { catalogDeleted: catalog.deleted, catalogKept: catalog.kept };
}

/** "Delete data" for an app that is not installed: `expectedRevision` is the listed revision. */
export function deleteRemovedAppDataWithFiles(
  db: Database,
  env: Env,
  pluginId: string,
  expectedRevision: number,
): Promise<AppDataDeleteResult> {
  return deleteAppDataAround(db, env, pluginId, () => deleteRemovedAppData(db, pluginId, expectedRevision));
}
