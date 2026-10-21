// App list columns and filters (packages/plugin-sdk/docs/apps.md, "Admin data
// seams"): what an active app declares in `admin.listColumns` for the
// products, orders and customers lists, the indexed filter a column adds, and
// the one bounded statement that reads the page's values.
//
// Cost: nothing unless a list request names app columns or an app filter.
// Then the request reads the active installations (one statement, to verify
// what it asked for against the manifests), the filter is an index match
// folded into the list's own statements, and the values are one statement
// for the page (`json_each` over the page's ids: one bound parameter for
// all of them, three per column, at most PLUGIN_LIST_COLUMNS_PER_REQUEST).

import type { Database } from "@scalius/database/client";
import {
  customFieldDefinitions,
  customFieldValues,
  pluginInstallations,
  objectRecords,
  type PluginInstallationRow,
} from "@scalius/database/schema";
import {
  PLUGIN_LIST_COLUMNS_PER_REQUEST,
  type PluginListColumnType,
  type PluginListResource,
} from "@scalius/shared/plugins";
import { and, eq, inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { ValidationError } from "@scalius/core/errors";
import { toPluginInstallation, type PluginInstallation } from "./installations";
import { planObjectRecordQuery } from "@scalius/core/modules/objects";
import { objectTypeId } from "@scalius/shared/plugins/objects";

/** One app column, as the dashboard shows it. */
export interface AppListColumn {
  /** `<plugin id>/<column id>`: how a request names it. */
  key: string;
  pluginId: string;
  appName: string;
  id: string;
  resource: PluginListResource;
  title: string;
  /** Bangla title, when the app gives one. */
  titleBn: string | null;
  type: PluginListColumnType;
  filterable: boolean;
  source: { kind: "object"; object: string; field: string } | { kind: "customField"; key: string };
}

export type AppListValue = string | number | boolean | null;

/** Every app column of active, approved apps, all lists or one, in app id then manifest order. */
export function appListColumnsOf(installations: Iterable<PluginInstallation>, resource?: PluginListResource): AppListColumn[] {
  const columns: AppListColumn[] = [];
  for (const installation of installations) {
    if (installation.status !== "active" || !installation.grant) continue;
    const titles = installation.manifest.translations?.bn?.listColumns ?? {};
    for (const column of installation.manifest.admin.listColumns) {
      if (resource && column.resource !== resource) continue;
      columns.push({
        key: `${installation.pluginId}/${column.id}`,
        pluginId: installation.pluginId,
        appName: installation.manifest.name,
        id: column.id,
        resource: column.resource,
        title: column.title,
        titleBn: titles[column.id] ?? null,
        type: column.type,
        filterable: column.filterable,
        source: column.source,
      });
    }
  }
  return columns.sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}

/** The active installations, read for one list request (no cache dependency: an admin read). */
export async function readActiveInstallationsForLists(db: Database): Promise<PluginInstallation[]> {
  const rows = await db.select().from(pluginInstallations).where(eq(pluginInstallations.status, "active")).all();
  return (rows as PluginInstallationRow[])
    .map(toPluginInstallation)
    .filter((installation): installation is PluginInstallation => installation !== null);
}

/** What one list request asks for: column keys to show and filters (`key` → value). */
export interface AppListRequest {
  columns: readonly string[];
  filters: ReadonlyArray<{ key: string; value: string }>;
}

/** Parses `appColumns=a/b,c/d` and `appFilter=a/b:value` query values; malformed input is refused. */
export function parseAppListRequest(columns: string | undefined, filters: readonly string[] | string | undefined): AppListRequest {
  const keys = (columns ?? "").split(",").map((key) => key.trim()).filter(Boolean);
  const filterValues = (Array.isArray(filters) ? filters : filters ? [filters] : []).map((entry) => {
    const separator = entry.indexOf(":");
    return separator > 0 ? { key: entry.slice(0, separator).trim(), value: entry.slice(separator + 1) } : null;
  });
  if (keys.length > PLUGIN_LIST_COLUMNS_PER_REQUEST || filterValues.length > 3 || filterValues.some((entry) => entry === null)) {
    throw new ValidationError(`Ask for at most ${PLUGIN_LIST_COLUMNS_PER_REQUEST} app columns and 3 app filters, each filter as <app>/<column>:<value>.`);
  }
  return { columns: [...new Set(keys)], filters: filterValues as Array<{ key: string; value: string }> };
}

export function isEmptyAppListRequest(request: AppListRequest): boolean {
  return request.columns.length === 0 && request.filters.length === 0;
}

/**
 * The columns and filters a request names, checked against the active apps'
 * manifests for this list. An unknown column or one another list owns is
 * refused; a filter must be on a filterable column.
 */
export function resolveAppListRequest(
  installations: Iterable<PluginInstallation>,
  resource: PluginListResource,
  request: AppListRequest,
): { columns: AppListColumn[]; filters: Array<{ column: AppListColumn; value: string }>; installations: Map<string, PluginInstallation> } {
  const byPlugin = new Map([...installations].map((installation) => [installation.pluginId, installation]));
  const declared = new Map(appListColumnsOf(byPlugin.values(), resource).map((column) => [column.key, column]));
  const columns = request.columns.map((key) => {
    const column = declared.get(key);
    if (!column) throw new ValidationError(`No active app adds the column ${key.slice(0, 120)} to this list.`);
    return column;
  });
  const filters = request.filters.map((filter) => {
    const column = declared.get(filter.key);
    if (!column?.filterable) throw new ValidationError(`No active app lets this list filter by ${filter.key.slice(0, 120)}.`);
    if (filter.value.length > 256) throw new ValidationError("An app filter value is at most 256 characters.");
    return { column, value: filter.value };
  });
  return { columns, filters, installations: byPlugin };
}

/** A filter value as the index stores it: a number when the text is one, `true`/`false`, else the text. */
function filterScalar(value: string): string | number | boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  const number = Number(value);
  return value.trim() !== "" && Number.isFinite(number) && String(number) === value.trim() ? number : value;
}

/**
 * The list condition of app filters: each an indexed match on the app's
 * records whose id is the row's id (`id IN (… WHERE idxN = …)`).
 */
export function appListFilterCondition(
  idColumn: AnyColumn,
  filters: ReadonlyArray<{ column: AppListColumn; value: string }>,
  installations: ReadonlyMap<string, PluginInstallation>,
): SQL | undefined {
  const conditions = filters.map(({ column, value }) => {
    if (column.source.kind !== "object") throw new ValidationError("Only object-backed app columns filter a list.");
    const declaration = installations.get(column.pluginId)?.manifest.objects[column.source.object];
    if (!declaration) throw new ValidationError(`${column.key} reads an object type its app no longer declares.`);
    let plan: ReturnType<typeof planObjectRecordQuery>;
    try {
      plan = planObjectRecordQuery(declaration, { where: { [column.source.field]: filterScalar(value) } });
    } catch (error) {
      throw new ValidationError(`${column.key} cannot filter by this value: ${error instanceof Error ? error.message.slice(0, 200) : "invalid"}`);
    }
    return inArray(idColumn, sql`(SELECT ${objectRecords.id} FROM ${objectRecords} WHERE ${and(
      eq(objectRecords.typeId, objectTypeId(column.pluginId, column.source.object)),
      plan.condition,
    )})`);
  });
  return conditions.length === 0 ? undefined : and(...conditions);
}

/**
 * One field of a stored record as a cell of the column's type (SQL gives a
 * JSON boolean as 1 or 0, PostgreSQL may give a number as text). Objects and
 * arrays become null.
 */
function objectCell(value: unknown, type: PluginListColumnType): AppListValue {
  if (value === null || value === undefined) return null;
  if (type === "boolean") return value === true || value === 1 || value === "1" || value === "true" ? true : value === false || value === 0 || value === "0" || value === "false" ? false : null;
  if (type === "number" || type === "money") {
    const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    return Number.isFinite(number) ? number : null;
  }
  if (typeof value === "string") return value.startsWith("{") || value.startsWith("[") ? null : value.slice(0, 500);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The page's values of these columns, in one statement: per row id, per
 * column key. Object columns read the app's record whose id is the row id;
 * custom-field columns the app's own field on the resource.
 */
export async function readAppListValues(
  db: Database,
  resource: PluginListResource,
  columns: readonly AppListColumn[],
  rowIds: readonly string[],
): Promise<Record<string, Record<string, AppListValue>>> {
  const ids = [...new Set(rowIds)].slice(0, 200);
  if (columns.length === 0 || ids.length === 0) return {};
  const cells = columns.map((column, index) => {
    const alias = sql.raw(`c${index}`);
    if (column.source.kind === "object") {
      // A record field as JSON text (json() keeps a string quoted), parsed below.
      return sql`(SELECT json_extract(${objectRecords.dataJson}, ${`$.${column.source.field}`})
        FROM ${objectRecords}
        WHERE ${objectRecords.typeId} = ${objectTypeId(column.pluginId, column.source.object)}
          AND ${objectRecords.id} = row_ids.value) AS ${alias}`;
    }
    return sql`(SELECT ${customFieldValues.value}
      FROM ${customFieldValues}
      INNER JOIN ${customFieldDefinitions} ON ${customFieldDefinitions.id} = ${customFieldValues.definitionId}
      WHERE ${customFieldDefinitions.ownerType} = ${resource}
        AND ${customFieldDefinitions.namespace} = ${column.pluginId}
        AND ${customFieldDefinitions.key} = ${column.source.key}
        AND ${customFieldValues.ownerId} = row_ids.value) AS ${alias}`;
  });
  const rows = await db.all(sql`SELECT CAST(row_ids.value AS TEXT) AS row_id, ${sql.join(cells, sql`, `)}
    FROM json_each(${JSON.stringify(ids)}) AS row_ids`) as unknown[];
  const values: Record<string, Record<string, AppListValue>> = {};
  for (const row of rows) {
    // D1 and Turso return objects; the PostgreSQL proxy value arrays in select-list order.
    const ordered: unknown[] = Array.isArray(row)
      ? row
      : [(row as Record<string, unknown>).row_id, ...columns.map((_, index) => (row as Record<string, unknown>)[`c${index}`])];
    const entry: Record<string, AppListValue> = {};
    columns.forEach((column, index) => {
      const value = ordered[index + 1];
      entry[column.key] = column.source.kind === "customField" ? customFieldCell(value, column.type) : objectCell(value, column.type);
    });
    values[String(ordered[0])] = entry;
  }
  return values;
}

/** A custom field's canonical text as a cell of the column's type. */
function customFieldCell(raw: unknown, type: PluginListColumnType): AppListValue {
  if (raw === null || raw === undefined) return null;
  const text = String(raw);
  if (type === "number" || type === "money") {
    const number = Number(text.split(" ")[0]);
    return Number.isFinite(number) ? number : null;
  }
  if (type === "boolean") return text === "true" ? true : text === "false" ? false : null;
  return text.slice(0, 500);
}
