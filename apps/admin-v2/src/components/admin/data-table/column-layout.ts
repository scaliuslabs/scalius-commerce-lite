import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { getLocale } from "~/i18n";
import type { Column, Table, TableRowData } from "./table-config";

/**
 * Which columns a list shows, in which order: the merchant's choice (saved
 * per list in this browser, like Shopify's column menu) and then what fits.
 * When the table is narrower than the visible columns need, the lowest
 * priority columns step aside until it fits; the checkbox, the title column,
 * the actions column and `meta.keep` columns always stay. A stand-in column
 * (`meta.combines`) takes the place of the columns it combines when they no
 * longer fit side by side.
 */

/** A width that differs by dashboard language (Bangla sets the type a size up). */
export type LocaleWidth = number | { readonly en: number; readonly bn: number };

/** `width` in the dashboard's language now: build columns again when it changes. */
export const localeWidth = (width: LocaleWidth): number => (typeof width === "number" ? width : width[getLocale()]);

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
  /** Never hidden: the checkbox, the title column, the actions and `meta.keep`. */
  locked: boolean;
}

/** A stand-in's layout and the ids of the columns it shows together. */
export interface StandInColumn extends LayoutColumn {
  combines: readonly string[];
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

/**
 * The saved order for the columns that still exist; new columns keep their
 * default place. `pinned` (the title column) always comes first, whatever a
 * saved order says.
 */
export function resolveOrder(defaults: readonly string[], saved: readonly string[] | undefined, pinned?: string): string[] {
  const pin = (order: string[]) =>
    pinned && order.includes(pinned) ? [pinned, ...order.filter((id) => id !== pinned)] : order;
  if (!saved?.length) return pin([...defaults]);
  const known = [...new Set(saved)].filter((id) => defaults.includes(id));
  const result = [...known];
  defaults.forEach((id, index) => {
    if (result.includes(id)) return;
    // Put a new column after the column that precedes it by default.
    const before = defaults.slice(0, index).reverse().find((candidate) => result.includes(candidate));
    result.splice(before ? result.indexOf(before) + 1 : 0, 0, id);
  });
  return pin(result);
}

/**
 * Columns to hide so the rest fit `width`: lowest priority first (the later
 * one on a tie), never a locked column. `extra` hides that many more, for
 * when the rendered content turned out wider than the columns' minimums.
 * Returns an empty set when everything fits or the width is unknown.
 */
export function fitColumns(columns: readonly LayoutColumn[], width: number, extra = 0): Set<string> {
  const hidden = new Set<string>();
  if (!(width > 0)) return hidden;
  let needed = columns.reduce((sum, column) => sum + column.minWidth, 0);
  let more = extra;
  const candidates = columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => !column.locked)
    .sort((left, right) => left.column.priority - right.column.priority || right.index - left.index);
  for (const { column } of candidates) {
    if (needed <= width) {
      if (more <= 0) break;
      more -= 1;
    }
    hidden.add(column.id);
    needed -= column.minWidth;
  }
  return hidden;
}

/**
 * `fitColumns` with stand-ins: when a column a stand-in combines has to step
 * aside, the stand-in replaces all of them (at the first one's place) if that
 * keeps more of them shown. Returns the columns in their final order and the
 * ones to hide.
 */
export function fitWithStandIns(
  columns: readonly LayoutColumn[],
  standIns: readonly StandInColumn[],
  width: number,
  extra = 0,
): { columns: LayoutColumn[]; hidden: Set<string> } {
  let current = [...columns];
  let hidden = fitColumns(current, width, extra);
  for (const standIn of standIns) {
    const parts = standIn.combines;
    if (!parts.every((id) => current.some((column) => column.id === id))) continue;
    if (!parts.some((id) => hidden.has(id))) continue;
    const at = current.findIndex((column) => parts.includes(column.id));
    const merged = current.filter((column) => !parts.includes(column.id));
    merged.splice(at, 0, standIn);
    const mergedHidden = fitColumns(merged, width, extra);
    // A stand-in that has to step aside too is worse than one part shown on its own.
    if (mergedHidden.has(standIn.id) && parts.some((id) => !hidden.has(id))) continue;
    current = merged;
    hidden = mergedHidden;
  }
  return { columns: current, hidden };
}

/** A stand-in column (`meta.combines`): never in the menu, shown only for its columns. */
export function isStandIn<TData extends TableRowData>(column: Column<TData, unknown>): boolean {
  return Boolean(column.columnDef.meta?.combines?.length);
}

/** The title column (`meta.primary`, or the phone card's title line). */
export function isPrimaryColumn<TData extends TableRowData>(column: Column<TData, unknown>): boolean {
  const meta = column.columnDef.meta;
  return Boolean(meta?.primary || meta?.mobile === "primary");
}

/** A column's layout facts; defaults suit a plain text column. */
export function layoutColumnOf<TData extends TableRowData>(column: Column<TData, unknown>): LayoutColumn {
  const meta = column.columnDef.meta;
  const locked = column.id === SELECT_COLUMN || column.id === ACTIONS_COLUMN || isPrimaryColumn(column) || Boolean(meta?.keep);
  return {
    id: column.id,
    priority: locked ? Number.POSITIVE_INFINITY : meta?.priority ?? 50,
    // The row menu is a 28px button with the cell's 6px and the table's 12px edge.
    minWidth: meta?.minWidth ?? (column.id === SELECT_COLUMN ? 40 : column.id === ACTIONS_COLUMN ? 48 : isPrimaryColumn(column) ? 200 : 120),
    locked,
  };
}

/** Whether the merchant may move or hide this column in the column menu. */
export function isConfigurable<TData extends TableRowData>(column: Column<TData, unknown>): boolean {
  return column.id !== SELECT_COLUMN && column.id !== ACTIONS_COLUMN && !isStandIn(column);
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
  /** Whether another column could still step aside to stop sideways scrolling. */
  canHideMore: boolean;
  toggle: (id: string) => void;
  /** Move a configurable column to `index` among the configurable columns; the title column stays first. */
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
  /** More columns to hide after measuring that the table still overflows. */
  extra = 0,
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
  const standIns = all.filter(isStandIn);
  const byId = new Map(all.map((column) => [column.id, column]));
  const primaryId = configurable.find(isPrimaryColumn)?.id;
  const order = resolveOrder(configurable.map((column) => column.id), saved?.order, primaryId);
  const hiddenByChoice = new Set(
    (saved?.hidden ?? []).filter((id) => byId.has(id) && !isPrimaryColumn(byId.get(id)!)),
  );
  const arrangeable = order.map((id) => byId.get(id)!);
  const shown = [
    ...all.filter((column) => column.id === SELECT_COLUMN),
    ...arrangeable.filter((column) => !hiddenByChoice.has(column.id)),
    ...all.filter((column) => column.id === ACTIONS_COLUMN),
  ];
  const layoutKey = [...shown, ...standIns].map((column) => column.id).join("|");
  const fitted = useMemo(
    () => fitWithStandIns(
      shown.map(layoutColumnOf),
      standIns.map((column) => ({ ...layoutColumnOf(column), combines: column.columnDef.meta!.combines! })),
      width,
      extra,
    ),
    // `shown` is rebuilt each render; its ids and the width are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layoutKey, width, extra],
  );
  const autoHidden = fitted.hidden;
  const hideable = fitted.columns.filter((column) => !column.locked).length;

  const save = useCallback(
    (next: SavedLayout | null) => {
      setSaved(next);
      if (key) writeSavedLayout(key, next);
    },
    [key],
  );

  return {
    visible: fitted.columns.flatMap((column) => (autoHidden.has(column.id) ? [] : [byId.get(column.id)!])),
    arrangeable,
    isHiddenByChoice: (id) => hiddenByChoice.has(id),
    autoHidden,
    canHideMore: autoHidden.size < hideable,
    toggle: (id) => {
      const column = byId.get(id);
      if (!column || isPrimaryColumn(column)) return;
      const hidden = new Set(hiddenByChoice);
      if (hidden.has(id)) hidden.delete(id);
      else hidden.add(id);
      save({ order, hidden: [...hidden] });
    },
    move: (id, index) => {
      // The title column stays first: it cannot move, and nothing moves above it.
      if (!order.includes(id) || id === primaryId) return;
      const next = order.filter((candidate) => candidate !== id);
      const first = primaryId ? 1 : 0;
      next.splice(Math.max(first, Math.min(index, next.length)), 0, id);
      save({ order: next, hidden: [...hiddenByChoice] });
    },
    reset: () => save(null),
    customized: saved !== null,
  };
}
