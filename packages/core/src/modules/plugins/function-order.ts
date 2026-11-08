// The merchant's order of apps at each checkout function point (Apps →
// Checkout order). An app's rank at a point lives on its installation
// (`function_ranks`, migration 0199), read with every registration, so the
// order costs checkout no read and survives updates, which rewrite the
// registrations. `functionRunOrder` (registry.ts) is the one rule: ranked
// apps first by rank, then the rest by manifest priority, then app id.
//
// Saving an order ranks every app that runs at the point, in the order given;
// resetting removes the point's ranks, so the manifest priority decides again.
// An app installed later runs after the ranked ones until the merchant places
// it. One atomic batch, guarded on each written row's ranks as read: two
// merchants saving at once never interleave two orders (the loser gets 409).

import type { Database } from "@scalius/database/client";
import { buildBatchGuard, isBatchGuardError, safeBatch } from "@scalius/database/client";
import { pluginInstallations } from "@scalius/database/schema";
import { PLUGIN_FUNCTION_COMPOSITION, type PluginFunctionComposition, type PluginFunctionPoint } from "@scalius/shared/plugins";
import { eq, sql } from "drizzle-orm";
import { PluginError } from "./errors";
import { listPluginInstallations, serializeFunctionRanks, type PluginInstallation } from "./installations";
import { functionRunOrder } from "./registry";

/** One app at a function point, as checkout orders it. */
export interface FunctionPointApp {
  installation: PluginInstallation;
  /** The manifest's priority for the point. */
  priority: number;
  /** The merchant's rank, or null when the manifest priority places it. */
  rank: number | null;
  /** Whether it runs at checkout now (active, approved for the point). */
  runs: boolean;
}

export interface FunctionPointOrder {
  point: PluginFunctionPoint;
  composition: PluginFunctionComposition;
  /** Whether the merchant ordered this point (any app has a rank there). */
  ordered: boolean;
  apps: FunctionPointApp[];
}

/** The apps whose running manifest implements `point`, in `functionRunOrder`. */
export function functionPointApps(installations: readonly PluginInstallation[], point: PluginFunctionPoint): FunctionPointApp[] {
  return installations
    .flatMap((installation) => {
      const declaration = installation.manifest.functions.find((fn) => fn.point === point);
      if (!declaration) return [];
      return [{
        installation,
        name: point,
        priority: declaration.priority,
        rank: installation.functionRanks[point] ?? null,
        runs: installation.status === "active" && Boolean(installation.grant?.functions.includes(point)),
      }];
    })
    .sort(functionRunOrder)
    .map(({ name: _name, ...app }) => app);
}

/** Every function point with at least one app, in checkout's order of points. */
export function functionPointOrders(installations: readonly PluginInstallation[]): FunctionPointOrder[] {
  return (Object.keys(PLUGIN_FUNCTION_COMPOSITION) as PluginFunctionPoint[])
    .map((point) => {
      const apps = functionPointApps(installations, point);
      return { point, composition: PLUGIN_FUNCTION_COMPOSITION[point], ordered: apps.some((app) => app.rank !== null), apps };
    })
    .filter((entry) => entry.apps.length > 0);
}

const FUNCTION_ORDER_GUARD = "plugin_function_order_changed";

/**
 * Sets the order at `point`: `appIds` must name every app that implements it,
 * once each; null resets the point to manifest priority. Answers the point's
 * order as saved.
 */
export async function setFunctionPointOrder(
  db: Database,
  point: PluginFunctionPoint,
  appIds: readonly string[] | null,
): Promise<FunctionPointOrder> {
  const installations = await listPluginInstallations(db);
  const current = functionPointApps(installations, point);
  const known = new Set(current.map((app) => app.installation.pluginId));
  if (appIds !== null) {
    const given = new Set(appIds);
    if (given.size !== appIds.length || given.size !== known.size || appIds.some((id) => !known.has(id))) {
      throw new PluginError(
        "function_order_mismatch",
        `Order every app at ${point} once: ${[...known].sort().join(", ") || "none"}.`,
        { point, appIds: [...known].sort() },
      );
    }
  }
  const rankOf = new Map((appIds ?? []).map((id, index) => [id, index]));
  const changes = installations.flatMap((installation) => {
    const before = installation.functionRanks;
    const next: Partial<Record<PluginFunctionPoint, number>> = { ...before };
    const rank = rankOf.get(installation.pluginId);
    if (rank === undefined) delete next[point];
    else next[point] = rank;
    if (before[point] === next[point]) return [];
    return [{ pluginId: installation.pluginId, before: serializeFunctionRanks(before), after: serializeFunctionRanks(next) }];
  });
  if (changes.length > 0) {
    try {
      await safeBatch(db, [
        // Each row still holds the ranks this order was computed from (the
        // platform writes them only in their canonical form, so text compares).
        ...changes.map((change) => buildBatchGuard(
          db,
          sql`EXISTS (SELECT 1 FROM ${pluginInstallations} WHERE ${pluginInstallations.pluginId} = ${change.pluginId} AND ${pluginInstallations.functionRanks} = ${change.before})`,
          FUNCTION_ORDER_GUARD,
        )),
        ...changes.map((change) => db.update(pluginInstallations)
          .set({ functionRanks: change.after })
          .where(eq(pluginInstallations.pluginId, change.pluginId))),
      ] as never);
    } catch (error) {
      if (isBatchGuardError(error, FUNCTION_ORDER_GUARD)) {
        throw new PluginError("function_order_changed", `The order at ${point} changed while it was being saved; reload and try again.`, { point });
      }
      throw error;
    }
  }
  const saved = await listPluginInstallations(db);
  const apps = functionPointApps(saved, point);
  return { point, composition: PLUGIN_FUNCTION_COMPOSITION[point], ordered: apps.some((app) => app.rank !== null), apps };
}
