import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Column, Table, TableRowData } from "./table-config";

/**
 * Which columns a list shows, in which order: the merchant's choice (saved
 * per list in this browser, like Shopify's column menu) and then what fits.
 * When the table is narrower than the visible columns need, the lowest
 * priority columns step aside until it fits; the checkbox, the title column
 * and the actions column always stay.
 */

/** Column ids the kit adds around a list's own columns. */
export const SELECT_COLUMN = "select";
export const ACTIONS_COLUMN = "actions";

/** A column's share of the layout, from its `meta` (see `ServerColumnMeta`). */
export interface LayoutColumn {
  id: string;
  /** Higher stays longer when space runs out. */
  priority: number;
  /** Narrowest width (px) the column reads well at. */
  minWidth: number;
  /** Never hidden: the checkbox, the title column and the actions. */
  locked: boolean;
}

export interface SavedLayout {
  order: string[];
  hidden: string[];
}

const STORAGE_PREFIX = "scalius.table.";

export function readSavedLayout(key: string): SavedLayout | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_PREFIX + key) ?? "null");
    if (!value || typeof value !== "object") return null;
    const { order, hidden } = value as Partial<SavedLayout>;
    const strings = (list: unknown) => (Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []);
    return { order: strings(order), hidden: strings(hidden) };
  } catch {
    return null;
  }
}

export function writeSavedLayout(key: string, layout: SavedLayout | null): void {
  try {
    if (layout) localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(layout));
    else localStorage.removeItem(STORAGE_PREFIX + key);
  } catch {
    // Storage blocked: the choice lasts until the page is left.
  }
}

/** The saved order for the columns that still exist; new columns keep their default place. */
export function resolveOrder(defaults: readonly string[], saved: readonly string[] | undefined): string[] {
  if (!saved?.length) return [...defaults];
  const known = saved.filter((id) => defaults.includes(id));
  const result = [...known];
  defaults.forEach((id, index) => {
    if (result.includes(id)) return;
    // Put a new column after the column that precedes it by default.
    const before = defaults.slice(0, index).reverse().find((candidate) => result.includes(candidate));
    result.splice(before ? result.indexOf(before) + 1 : 0, 0, id);
  });
  return result;
}

/**
 * Columns to hide so the rest fit `width`: lowest priority first (the later
 * one on a tie), never a locked column. Returns an empty set when everything
 * fits or the width is unknown.
 */
export function fitColumns(columns: readonly LayoutColumn[], width: number): Set<string> {
  const hidden = new Set<string>();
  if (!(width > 0)) return hidden;
  let needed = columns.reduce((sum, column) => sum + column.minWidth, 0);
  const candidates = columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => !column.locked)
    .sort((left, right) => left.column.priority - right.column.priority || right.index - left.index);
  for (const { column } of candidates) {
    if (needed <= width) break;
    hidden.add(column.id);
    needed -= column.minWidth;
  }
  return hidden;
}

/** The title column (`meta.primary`, or the phone card's title line). */
export function isPrimaryColumn<TData extends TableRowData>(column: Column<TData, unknown>): boolean {
  const meta = column.columnDef.meta;
  return Boolean(meta?.primary || meta?.mobile === "primary");
}

/** A column's layout facts; defaults suit a plain text column. */
export function layoutColumnOf<TData extends TableRowData>(column: Column<TData, unknown>): LayoutColumn {
  const meta = column.columnDef.meta;
  const locked = column.id === SELECT_COLUMN || column.id === ACTIONS_COLUMN || isPrimaryColumn(column);
  return {
    id: column.id,
    priority: locked ? Number.POSITIVE_INFINITY : meta?.priority ?? 50,
    minWidth: meta?.minWidth ?? (column.id === SELECT_COLUMN ? 40 : column.id === ACTIONS_COLUMN ? 56 : isPrimaryColumn(column) ? 200 : 120),
    locked,
  };
}

/** Whether the merchant may move or hide this column in the column menu. */
export function isConfigurable<TData extends TableRowData>(column: Column<TData, unknown>): boolean {
  return column.id !== SELECT_COLUMN && column.id !== ACTIONS_COLUMN;
}

/** The width of an element, kept current with a ResizeObserver (0 until measured). */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry?.contentRect.width ?? element.clientWidth)));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export interface ColumnLayout<TData extends TableRowData> {
  /** Columns to render, in order. */
  visible: Column<TData, unknown>[];
  /** Every column the merchant can arrange, in the current order. */
  arrangeable: Column<TData, unknown>[];
  isHiddenByChoice: (id: string) => boolean;
  /** Columns stepped aside because the table is too narrow. */
  autoHidden: Set<string>;
  toggle: (id: string) => void;
  /** Move a configurable column to `index` among the configurable columns. */
  move: (id: string, index: number) => void;
  reset: () => void;
  customized: boolean;
}

/**
 * The layout for one list. `key` names the list for the saved choice
 * (`null` keeps it for this page only); `width` is the table container's.
 */
export function useColumnLayout<TData extends TableRowData>(
  table: Table<TData>,
  key: string | null,
  width: number,
): ColumnLayout<TData> {
  const [saved, setSaved] = useState<SavedLayout | null>(() => (key ? readSavedLayout(key) : null));
  const keyRef = useRef(key);
  useEffect(() => {
    if (keyRef.current === key) return;
    keyRef.current = key;
    setSaved(key ? readSavedLayout(key) : null);
  }, [key]);

  const all = table.getAllLeafColumns().filter((column) => column.getIsVisible());
  const configurable = all.filter(isConfigurable);
  const byId = new Map(all.map((column) => [column.id, column]));
  const order = resolveOrder(configurable.map((column) => column.id), saved?.order);
  const hiddenByChoice = new Set(
    (saved?.hidden ?? []).filter((id) => byId.has(id) && !isPrimaryColumn(byId.get(id)!)),
  );
  const arrangeable = order.map((id) => byId.get(id)!);
  const shown = [
    ...all.filter((column) => column.id === SELECT_COLUMN),
    ...arrangeable.filter((column) => !hiddenByChoice.has(column.id)),
    ...all.filter((column) => column.id === ACTIONS_COLUMN),
  ];
  const layoutKey = shown.map((column) => column.id).join("|");
  const autoHidden = useMemo(
    () => fitColumns(shown.map(layoutColumnOf), width),
    // `shown` is rebuilt each render; its ids and the width are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layoutKey, width],
  );

  const save = useCallback(
    (next: SavedLayout | null) => {
      setSaved(next);
      if (key) writeSavedLayout(key, next);
    },
    [key],
  );

  return {
    visible: shown.filter((column) => !autoHidden.has(column.id)),
    arrangeable,
    isHiddenByChoice: (id) => hiddenByChoice.has(id),
    autoHidden,
    toggle: (id) => {
      const column = byId.get(id);
      if (!column || isPrimaryColumn(column)) return;
      const hidden = new Set(hiddenByChoice);
      if (hidden.has(id)) hidden.delete(id);
      else hidden.add(id);
      save({ order, hidden: [...hidden] });
    },
    move: (id, index) => {
      const next = order.filter((candidate) => candidate !== id);
      next.splice(Math.max(0, Math.min(index, next.length)), 0, id);
      save({ order: next, hidden: [...hiddenByChoice] });
    },
    reset: () => save(null),
    customized: saved !== null,
  };
}
