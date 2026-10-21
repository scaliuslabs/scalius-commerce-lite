// Apps' columns and filter on the products, orders and customers lists
// (packages/plugin-sdk/docs/apps.md, "Admin data"). The surfaces read already names
// each active app's columns; a list asks for them (`appColumns`) and for one
// filter (`appFilter`) in its own request, and gets the values back in the
// same response. With no app column the list sends neither, so a store
// without apps pays nothing: no extra read, and the code that draws the
// columns loads only when there is one to draw.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePermissions } from "~/contexts/PermissionContext";
import { useLocale } from "~/i18n";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { appSurfacesQueryOptions } from "~/lib/api-query-options/apps";
import type { AppValuesRow } from "~/lib/list-helpers";
import type { ColumnDef, TableRowData } from "~/components/admin/data-table/table-config";
import type { DataColumnSpec, dataColumns } from "~/components/admin/data-table/data-columns";
import { localizedSurfaces } from "../app-text";
import type { AppSurfaces } from "./surfaces";

type DeclaredColumn = AppSurfaces["listColumns"][number];
export type AppListResource = DeclaredColumn["resource"];
/** A column an app declares for a list; `title` is in the dashboard's language. */
export type AppListColumn = DeclaredColumn & { appName: string };

/** A list asks for at most this many app columns (the API refuses more). */
export const APP_LIST_COLUMNS_MAX = 5;

const NO_COLUMNS: readonly AppListColumn[] = [];
const NO_EXTRA: ColumnDef<never, unknown>[] = [];

/** A resource's columns across the active apps, in app order. */
export function appListColumnsOf(apps: readonly AppSurfaces[], resource: AppListResource): AppListColumn[] {
  return apps.flatMap((app) =>
    app.listColumns.filter((column) => column.resource === resource).map((column) => ({ ...column, appName: app.name })));
}

/** The column key a filter value (`<app id>/<column id>:<value>`) names. */
export function appFilterColumnKey(filter: string): string {
  const separator = filter.indexOf(":");
  return separator > 0 ? filter.slice(0, separator) : filter;
}

/** The value part of a filter (`<app id>/<column id>:<value>`). */
export function appFilterValue(filter: string | undefined): string {
  return filter ? filter.slice(filter.indexOf(":") + 1) : "";
}

/**
 * The filter to send. Before the surfaces are known the URL's filter stands
 * (the route already read the list with it); once they are, a filter whose
 * column is gone (an app removed or updated) is dropped, because the API
 * refuses a filter no active app declares.
 */
export function effectiveAppFilter(filter: string | undefined, columns: readonly AppListColumn[], known: boolean): string | undefined {
  if (!filter) return undefined;
  if (!known) return filter;
  const key = appFilterColumnKey(filter);
  return columns.some((column) => column.filterable && column.key === key) ? filter : undefined;
}

/** The spec of one app column; its values ride on the row (`AppValuesRow`). */
export function appColumnSpec<TData>(column: AppListColumn): DataColumnSpec<TData> {
  return {
    id: `app.${column.key}`,
    label: column.title,
    kind: column.type,
    value: (row) => (row as AppValuesRow).appValues?.[column.key],
  };
}

/** Every column the active apps declare for one resource, and whether the surfaces are known yet. */
export function useAppResourceColumns(resource: AppListResource): { all: readonly AppListColumn[]; known: boolean } {
  const { hasPermission } = usePermissions();
  const canView = hasPermission(ADMIN_PERMISSIONS.APPS_VIEW);
  const locale = useLocale();
  const { data, isError } = useQuery({ ...appSurfacesQueryOptions(), enabled: canView });
  const all = useMemo(
    () => (canView && data ? appListColumnsOf(data.map((app) => localizedSurfaces(app, locale)), resource) : NO_COLUMNS),
    [canView, data, locale, resource],
  );
  return { all, known: !canView || data !== undefined || isError };
}

type DataColumnsBuilder = typeof dataColumns;
// Once loaded, later lists get the builder on their first render.
let loadedBuilder: DataColumnsBuilder | null = null;

function loadBuilder(): Promise<DataColumnsBuilder> {
  return import("~/components/admin/data-table/data-columns").then((module) => {
    loadedBuilder = module.dataColumns;
    return module.dataColumns;
  });
}

export interface AppListColumns<TData extends TableRowData> {
  /** The columns to add after the list's own (empty until the code that draws them has loaded). */
  extra: ColumnDef<TData, unknown>[];
  /** `appColumns` for the list request, or undefined when no app has a column here. */
  columnsParam: string | undefined;
  /** `appFilter` for the list request, or undefined. */
  filterParam: string | undefined;
  /** The columns a filter can be set on. */
  filterable: readonly AppListColumn[];
}

/**
 * The active apps' columns for one list, ready for its request and table.
 * `filter` is the list's `appFilter` URL value.
 */
export function useAppListColumns<TData extends TableRowData>(resource: AppListResource, filter?: string): AppListColumns<TData> {
  const { all, known } = useAppResourceColumns(resource);
  const shown = useMemo(() => all.slice(0, APP_LIST_COLUMNS_MAX), [all]);
  const filterable = useMemo(() => all.filter((column) => column.filterable), [all]);

  const [builder, setBuilder] = useState<DataColumnsBuilder | null>(() => loadedBuilder);
  const needsBuilder = shown.length > 0;
  useEffect(() => {
    if (!needsBuilder || builder) return;
    let live = true;
    void loadBuilder().then((loaded) => {
      if (live) setBuilder(() => loaded);
    });
    return () => {
      live = false;
    };
  }, [needsBuilder, builder]);

  const extra = useMemo(
    () => (builder && shown.length > 0 ? builder<TData>(shown.map((column) => appColumnSpec<TData>(column))) : (NO_EXTRA as ColumnDef<TData, unknown>[])),
    [builder, shown],
  );

  return {
    extra,
    columnsParam: shown.length > 0 ? shown.map((column) => column.key).join(",") : undefined,
    filterParam: effectiveAppFilter(filter, all, known),
    filterable,
  };
}
