// App list columns and filters on the dashboard's products, orders and
// customers lists (core plugins/list-columns.ts). The list routes take
// `appColumns` and `appFilter`; with neither, nothing more is read. With
// them, the active installations are read once (one statement), the filter
// folds into the list's own statements as an index match, and the page's
// values are one statement.
import { z } from "@hono/zod-openapi";
import type { Database } from "@scalius/database/client";
import {
  appListFilterCondition,
  isEmptyAppListRequest,
  parseAppListRequest,
  readActiveInstallationsForLists,
  readAppListValues,
  resolveAppListRequest,
  type AppListValue,
} from "@scalius/core/modules/plugins";
import { PLUGIN_LIST_COLUMNS_PER_REQUEST, type PluginListResource } from "@scalius/shared/plugins";
import type { AnyColumn, SQL } from "drizzle-orm";

/** The list query parameters every app-extensible list takes. */
export const appListQuerySchema = {
  appColumns: z.string().max(600).optional().openapi({
    description: `Comma-separated app columns to add (<app id>/<column id>, at most ${PLUGIN_LIST_COLUMNS_PER_REQUEST}); the active apps' declared columns are in GET /api/v1/admin/apps/surfaces. Their values come back in appValues.`,
  }),
  appFilter: z.union([z.string().max(400), z.array(z.string().max(400)).max(3)]).optional().openapi({
    description: "Filter by an app column the app marks filterable: <app id>/<column id>:<value>, an exact match (up to 3).",
  }),
};

/** The page's app column values: row id → column key → value. */
export const appListValuesSchema = z.record(
  z.string(),
  z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
).optional().openapi({
  description: "Values of the app columns named in appColumns, by row id then <app id>/<column id>. Absent when no app column was asked for.",
});

export interface AppListPlan {
  /** The app filters as a list condition (an index match), or none. */
  condition: SQL | undefined;
  /** The page's values of the requested columns (undefined: none asked for). */
  values(rowIds: readonly string[]): Promise<Record<string, Record<string, AppListValue>> | undefined>;
}

const NONE: AppListPlan = { condition: undefined, values: async () => undefined };

/**
 * What the app columns and filters of one list request read. Unknown
 * columns, columns of another list and filters on a column its app does not
 * index answer 400.
 */
export async function planAppList(
  db: Database,
  resource: PluginListResource,
  idColumn: AnyColumn,
  query: { appColumns?: string; appFilter?: string | string[] },
): Promise<AppListPlan> {
  const request = parseAppListRequest(query.appColumns, query.appFilter);
  if (isEmptyAppListRequest(request)) return NONE;
  const resolved = resolveAppListRequest(await readActiveInstallationsForLists(db), resource, request);
  return {
    condition: appListFilterCondition(idColumn, resolved.filters, resolved.installations),
    values: async (rowIds) => (resolved.columns.length > 0
      ? readAppListValues(db, resource, resolved.columns, rowIds)
      : undefined),
  };
}
