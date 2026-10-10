// Test fixture: the width a list's cell content needs at the dashboard's
// type scale, and the room a list table has at a window width. Layout tests
// run in happy-dom, which lays nothing out, so they budget widths with the
// real glyph advances of the dashboard fonts instead (Inter for Latin, Noto
// Sans Bengali for Bangla; per-mille of the em, read from the shipped font
// files). Shaping (Bangla conjuncts, kerning) only makes real text narrower.
import type { ColumnDef, TableRowData } from "./table-config";
import { ACTIONS_COLUMN, SELECT_COLUMN, fitWithStandIns, type LayoutColumn, type StandInColumn } from "./column-layout";

// Inter, U+0020 to U+007E.
const LATIN = [281,288,466,633,642,982,644,300,365,365,501,662,288,460,288,360,631,407,610,618,646,593,620,566,619,620,288,302,662,662,662,511,966,690,654,730,722,601,590,746,743,269,571,672,565,903,753,765,639,765,644,642,646,744,690,985,682,679,629,365,360,365,471,456,323,562,612,571,612,583,370,613,591,242,242,549,242,876,591,600,612,612,376,528,327,591,562,818,546,562,552,426,333,426,662];
// Noto Sans Bengali, U+0980 to U+09FF.
const BENGALI = [540,0,438,438,600,893,1159,534,689,712,800,846,609,600,600,731,853,600,600,738,874,807,661,646,621,715,538,609,862,797,993,547,541,712,547,620,707,645,553,596,602,600,716,833,596,701,612,626,596,600,731,600,600,600,681,626,623,534,600,600,0,530,266,266,266,0,0,0,0,600,600,361,361,600,600,1137,1137,0,542,600,600,600,600,600,600,600,600,266,600,600,600,600,712,547,600,626,846,692,0,0,600,600,592,592,592,592,592,592,592,592,592,592,596,596,589,592,589,602,679,267,602,483,676,311,537,426,0,600];
const OTHER: Record<string, number> = { " ": 281, " ": 281, "·": 288, "–": 500, "—": 1000, "…": 864, "→": 662 };

export type Locale = "en" | "bn";

const isConsonant = (char: string | undefined) => Boolean(char && /[\u0995-\u09b9\u09dc-\u09df]/.test(char));

/** The type scale (DESIGN.md): Bangla sets the same classes a size up. */
export const TYPE: Record<Locale, { body: number; caption: number }> = {
  en: { body: 14, caption: 12 },
  bn: { body: 15, caption: 13 },
};

/** Pixels `text` needs on one line. Medium (550) runs about 4% wider than the regular advances. */
export function textWidth(text: string, px: number, { medium = false, mono = false } = {}): number {
  let units = 0;
  const chars = [...text];
  for (const [index, char] of chars.entries()) {
    const code = char.codePointAt(0)!;
    if (mono) units += 600;
    // A hasant between two consonants joins them into one conjunct: it has no width of its own.
    else if (char === "\u09cd" && isConsonant(chars[index - 1]) && isConsonant(chars[index + 1])) continue;
    else if (code >= 0x20 && code < 0x7f) units += LATIN[code - 0x20]!;
    else if (code >= 0x980 && code < 0xa00) units += BENGALI[code - 0x980]!;
    else units += OTHER[char] ?? 600;
  }
  return (units / 1000) * px * (medium && !mono ? 1.04 : 1);
}

/** A badge: caption type, medium, 8px each side (`badgeVariants`). */
export const badgeWidth = (label: string, locale: Locale) => textWidth(label, TYPE[locale].caption, { medium: true }) + 16;

/** A cell's 6px each side (Polaris IndexTable, `INDEX_CELL`). */
export const CELL_PADDING = 12;

/** A sortable heading's arrow and its gap. */
export const SORT_ARROW = 18;

/** The narrowest window that shows the navigation panel (`NAV_PANEL_QUERY`, nav-button.ts); narrower ones use the menu drawer. */
export const NAV_PANEL_MIN_WIDTH = 1100;

/**
 * The list table's width in a window this wide: the navigation panel open
 * (240px) from 1100px, else the canvas' 8px inset on its left too; the
 * canvas' 8px inset, the page's 24px padding each side, a 15px scrollbar
 * gutter (Windows) and the page's 1280px cap.
 */
export function tableWidth(viewport: number): number {
  const navigation = viewport >= NAV_PANEL_MIN_WIDTH ? 240 : 8;
  return Math.min(1280, viewport - navigation - 8 - 48 - 15);
}

/** Window widths the lists are checked at; phones get cards. */
export const LAPTOP_VIEWPORTS = [1024, 1280, 1440, 1920] as const;

function layoutOf<TData extends TableRowData>(column: ColumnDef<TData, unknown>): LayoutColumn {
  const id = column.id ?? (column as { accessorKey?: string }).accessorKey!;
  const meta = column.meta;
  const locked = id === SELECT_COLUMN || id === ACTIONS_COLUMN || Boolean(meta?.primary || meta?.mobile === "primary" || meta?.keep || meta?.money);
  return {
    id,
    priority: locked ? Number.POSITIVE_INFINITY : meta?.priority ?? 50,
    minWidth: meta?.minWidth ?? (id === SELECT_COLUMN ? 40 : id === ACTIONS_COLUMN ? 48 : 120),
    locked,
  };
}

/** The columns a list shows at `width` (as `useColumnLayout` fits them) and the width they take. */
export function fitList<TData extends TableRowData>(columns: ColumnDef<TData, unknown>[], width: number): { shown: string[]; used: number } {
  const standIns = columns.filter((column) => column.meta?.combines?.length);
  const plain = columns.filter((column) => !column.meta?.combines?.length);
  const result = fitWithStandIns(
    plain.map(layoutOf),
    standIns.map((column): StandInColumn => ({ ...layoutOf(column), combines: column.meta!.combines! })),
    width,
  );
  const shown = result.columns.filter((column) => !result.hidden.has(column.id));
  return { shown: shown.map((column) => column.id), used: shown.reduce((sum, column) => sum + column.minWidth, 0) };
}

/** A column's id as the layout sees it. */
export const columnId = <TData extends TableRowData>(column: ColumnDef<TData, unknown>) =>
  column.id ?? (column as { accessorKey?: string }).accessorKey!;
