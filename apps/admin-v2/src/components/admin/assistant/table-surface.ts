import { useEffect } from "react";
import type { RowSelectionState, Table } from "@tanstack/react-table";

import {
  registerAdminAssistantPageActionHandler,
  type AdminAssistantPageAction,
} from "./page-actions";
import {
  registerAdminAssistantSurface,
  sanitizeAdminAssistantOpaqueRowId,
  sanitizeAdminAssistantText,
  type AdminAssistantSurfaceRegistration,
  type AdminAssistantSurfaceHandle,
} from "./page-state";

const MAX_TABLE_ROW_IDS = 100;
const MAX_TABLE_ROW_ID_LENGTH = 80;
const TABLE_SELECT_ACTION_TYPE = "select_visible_rows" as const;
const TABLE_CLEAR_ACTION_TYPE = "clear_selection" as const;

export interface AdminAssistantTableSurfaceRegistrationInput {
  id: string;
  label: string;
  visibleRowIds: readonly string[];
  selectedRowIds?: readonly string[];
  rowCount?: number;
  selectedCount?: number;
}

export interface AdminAssistantTableSurfaceOptions
  extends AdminAssistantTableSurfaceRegistrationInput {
  onSelectVisibleRows: (rowIds: string[]) => boolean;
  onClearSelection: () => boolean;
}

export interface AdminAssistantTableSurfaceHandle {
  update: (input: AdminAssistantTableSurfaceRegistrationInput) => void;
  unregister: () => void;
}

type AdminAssistantTableSurfaceRegistration =
  AdminAssistantSurfaceRegistration & {
    assistantActions: NonNullable<
      AdminAssistantSurfaceRegistration["assistantActions"]
    >;
  };

export function getAdminAssistantTableActionId(
  tableId: string,
  type: typeof TABLE_SELECT_ACTION_TYPE | typeof TABLE_CLEAR_ACTION_TYPE,
): string {
  return (
    sanitizeAdminAssistantText(`${tableId}:${type}`, MAX_TABLE_ROW_ID_LENGTH) ??
    `${type}:table`
  );
}

export function createAdminAssistantTableSurfaceRegistration(
  input: AdminAssistantTableSurfaceRegistrationInput,
): AdminAssistantTableSurfaceRegistration {
  const tableId =
    sanitizeAdminAssistantText(input.id, MAX_TABLE_ROW_ID_LENGTH) ??
    "assistant-table";
  const visibleRowIds = sanitizeVisibleTableRowIds(input.visibleRowIds);
  const selectedRowIds = sanitizeVisibleTableRowIds(input.selectedRowIds ?? []);

  return {
    id: tableId,
    kind: "table" as const,
    label: sanitizeAdminAssistantText(input.label) ?? "Visible table",
    rowCount: input.rowCount ?? visibleRowIds.length,
    selectedCount: input.selectedCount ?? selectedRowIds.length,
    assistantActions: [
      {
        id: getAdminAssistantTableActionId(tableId, TABLE_SELECT_ACTION_TYPE),
        type: TABLE_SELECT_ACTION_TYPE,
        label: "Select visible rows",
        visibleRowIds,
      },
      {
        id: getAdminAssistantTableActionId(tableId, TABLE_CLEAR_ACTION_TYPE),
        type: TABLE_CLEAR_ACTION_TYPE,
        label: "Clear selection",
      },
    ],
  };
}

export function registerAdminAssistantTableSurface(
  options: AdminAssistantTableSurfaceOptions,
): AdminAssistantTableSurfaceHandle {
  let current = createAdminAssistantTableSurfaceRegistration(options);
  const surfaceHandle: AdminAssistantSurfaceHandle =
    registerAdminAssistantSurface(current);
  const selectHandle = registerAdminAssistantPageActionHandler(
    getAdminAssistantTableActionId(current.id, TABLE_SELECT_ACTION_TYPE),
    (action) => handleSelectVisibleRows(action, current, options),
  );
  const clearHandle = registerAdminAssistantPageActionHandler(
    getAdminAssistantTableActionId(current.id, TABLE_CLEAR_ACTION_TYPE),
    (action) => handleClearSelection(action, current, options),
  );

  return {
    update: (input) => {
      current = createAdminAssistantTableSurfaceRegistration(input);
      surfaceHandle.update(current);
    },
    unregister: () => {
      clearHandle.unregister();
      selectHandle.unregister();
      surfaceHandle.unregister();
    },
  };
}

export function useAdminAssistantTableSurface<TData>(options: {
  id: string;
  label: string;
  table: Table<TData>;
  enabled?: boolean;
}): void {
  const visibleRowKey = options.table
    .getRowModel()
    .rows.map((row) => row.id)
    .join("\u0000");
  const selectedRowKey = options.table
    .getFilteredSelectedRowModel()
    .rows.map((row) => row.id)
    .join("\u0000");

  useEffect(() => {
    if (options.enabled === false) return undefined;

    const visibleRowIds = splitTableRowKey(visibleRowKey);
    const selectedRowIds = splitTableRowKey(selectedRowKey);
    const handle = registerAdminAssistantTableSurface({
      id: options.id,
      label: options.label,
      visibleRowIds,
      selectedRowIds,
      rowCount: visibleRowIds.length,
      selectedCount: selectedRowIds.length,
      onSelectVisibleRows: (rowIds) =>
        selectTanStackVisibleRows(options.table, rowIds),
      onClearSelection: () => clearTanStackSelection(options.table),
    });

    return () => handle.unregister();
  }, [
    options.enabled,
    options.id,
    options.label,
    options.table,
    selectedRowKey,
    visibleRowKey,
  ]);
}

function handleSelectVisibleRows(
  action: AdminAssistantPageAction,
  current: ReturnType<typeof createAdminAssistantTableSurfaceRegistration>,
  options: AdminAssistantTableSurfaceOptions,
): boolean {
  if (
    action.targetId !== current.id ||
    action.type !== TABLE_SELECT_ACTION_TYPE
  ) {
    return false;
  }

  const visibleRowIds =
    current.assistantActions.find(
      (registeredAction) => registeredAction.type === TABLE_SELECT_ACTION_TYPE,
    )?.visibleRowIds ?? [];
  const visibleSet = new Set(visibleRowIds);
  const safeRequestedRowIds = sanitizeVisibleTableRowIds(action.rowIds);
  const safeRowIds = safeRequestedRowIds.filter((rowId) => visibleSet.has(rowId));
  if (safeRowIds.length === 0) return false;

  return options.onSelectVisibleRows(safeRowIds);
}

function handleClearSelection(
  action: AdminAssistantPageAction,
  current: ReturnType<typeof createAdminAssistantTableSurfaceRegistration>,
  options: AdminAssistantTableSurfaceOptions,
): boolean {
  if (
    action.targetId !== current.id ||
    action.type !== TABLE_CLEAR_ACTION_TYPE
  ) {
    return false;
  }

  return options.onClearSelection();
}

function selectTanStackVisibleRows<TData>(
  table: Table<TData>,
  rowIds: readonly string[],
): boolean {
  const currentSelection = table.getState().rowSelection ?? {};
  const safeRowIds = sanitizeVisibleTableRowIds(rowIds);
  const changed = safeRowIds.some((rowId) => currentSelection[rowId] !== true);
  if (!changed) return false;

  table.setRowSelection((previous) => {
    const next: RowSelectionState = { ...previous };
    for (const rowId of safeRowIds) next[rowId] = true;
    return next;
  });
  return true;
}

function clearTanStackSelection<TData>(table: Table<TData>): boolean {
  const currentSelection = table.getState().rowSelection ?? {};
  const hasSelection = Object.values(currentSelection).some(Boolean);
  if (!hasSelection) return false;

  table.resetRowSelection();
  return true;
}

function sanitizeVisibleTableRowIds(rowIds: readonly unknown[]): string[] {
  const safeRowIds: string[] = [];
  for (const rowId of rowIds) {
    const sanitized = sanitizeAdminAssistantOpaqueRowId(
      rowId,
      MAX_TABLE_ROW_ID_LENGTH,
    );
    if (!sanitized || safeRowIds.includes(sanitized)) continue;

    safeRowIds.push(sanitized);
    if (safeRowIds.length >= MAX_TABLE_ROW_IDS) break;
  }
  return safeRowIds;
}

function splitTableRowKey(rowKey: string): string[] {
  return rowKey ? rowKey.split("\u0000") : [];
}
