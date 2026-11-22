// The apps' add-ons as rows of a money summary ("Protection ৳350"): one row
// per app and add-on title, summed over the lines' units, and the subtotal
// of the items without them, so the summary shows Subtotal, the add-on rows,
// delivery, discounts, tax and the total, and the rows add up to the
// subtotal checkout charged. Every surface derives them from the numbers
// checkout priced or the order froze (each line's add-ons per unit times its
// units): the cart check and the checkout quote answer them, and an order's
// views read them from its frozen lines, never from an app's live answer.
// A bundle's add-on rides its anchor at the fee over the anchor's units per
// bundle unit, so its row counts it once per bundle unit. A leaf: the cart
// drawer and the receipt import it without the line-property module.
import { LINE_ADJUSTMENT_KEY } from "./line-identity";

/**
 * The most add-ons one line carries, everywhere: what checkout takes on a
 * line (`LINE_ADJUSTMENTS_PER_LINE_MAX`, refusing past it), what the cart
 * stores and what the page accepts from the cart check and the quote. One
 * number, so the page never refuses a line checkout took.
 */
export const LINE_ADD_ONS_MAX = 5;
/**
 * The most add-on rows one money summary shows: past it the server folds an
 * app's rows into one row under the app's name (`addOnTotals`), so the rows
 * still add up and the page always takes them.
 */
export const ADD_ON_ROWS_MAX = 50;
/** An add-on's title, at most (`cart.line_prices` titles). */
export const ADD_ON_TITLE_MAX = 80;

/** One add-on on each unit of a line, in minor units of the summary's currency. */
export interface LineAddOn {
  appId?: string | null;
  title: string;
  amountMinor: number;
}

/** One row of the summary: every unit's add-on of one app under one title. */
export interface AddOnTotalRow {
  appId: string | null;
  title: string;
  amountMinor: number;
}

export interface AddOnTotals {
  /** The subtotal less every add-on row: what the items alone cost. */
  itemsSubtotalMinor: number;
  rows: AddOnTotalRow[];
}

/**
 * The add-ons a frozen or checked line carries among its entries
 * (`_adjustment`: value is the title, priceMinor each unit's amount). An
 * entry without a key is one of a list of add-ons (a stored cart line's).
 */
export function lineAddOnsOf(entries: ReadonlyArray<{ key?: string; value?: string; displayValue?: string; priceMinor?: number; appId?: string | null }> | null | undefined): LineAddOn[] {
  return (entries ?? []).flatMap((entry) => {
    if (entry.key !== undefined && entry.key !== LINE_ADJUSTMENT_KEY) return [];
    const amountMinor = entry.priceMinor;
    if (typeof amountMinor !== "number" || !Number.isSafeInteger(amountMinor) || amountMinor < 0) return [];
    const title = (entry.value ?? entry.displayValue ?? "").trim();
    return title ? [{ appId: entry.appId ?? null, title, amountMinor }] : [];
  });
}

/**
 * A buyer's bundle line's add-ons: its components' summed by app and title,
 * each `amountMinor` times what the component holds per bundle unit, so the
 * line shows the fee once per bundle unit. Checkout puts every add-on of an
 * expanded bundle on its one anchor and refuses past `LINE_ADD_ONS_MAX`, so
 * the sum never holds more entries than that.
 */
export function aggregateLineAddOns(entries: ReadonlyArray<LineAddOn & { perUnit?: number }>): AddOnTotalRow[] {
  const sums = new Map<string, AddOnTotalRow>();
  for (const entry of entries) {
    const appId = entry.appId ?? null;
    const key = `${appId ?? ""}\u0000${entry.title}`;
    const row = sums.get(key) ?? { appId, title: entry.title, amountMinor: 0 };
    row.amountMinor += entry.amountMinor * (entry.perUnit ?? 1);
    sums.set(key, row);
  }
  return [...sums.values()];
}

/** The neutral title of folded rows when no app name is known (a receipt names no app): the host's words. */
export const ADD_ON_FOLD_WORDS = { en: "Add-ons", bn: "অ্যাড-অন" } as const;
export function addOnFoldLabel(language: string | null | undefined): string {
  return /^bn\b/iu.test(language ?? "") ? ADD_ON_FOLD_WORDS.bn : ADD_ON_FOLD_WORDS.en;
}

/**
 * At most `max` rows with the same sum: first each app with several rows
 * (the most first) becomes one row under its name (`label`), then the rows
 * past the last place join one under the neutral label.
 */
function foldRows(rows: AddOnTotalRow[], max: number, label: (appId: string | null) => string, neutral: string): AddOnTotalRow[] {
  let list = rows;
  while (list.length > max) {
    const counts = new Map<string | null, number>();
    for (const row of list) counts.set(row.appId, (counts.get(row.appId) ?? 0) + 1);
    const [appId, count] = [...counts].sort((left, right) => right[1] - left[1])[0]!;
    if (count < 2) break;
    const first = list.find((row) => row.appId === appId)!;
    const merged = { appId, title: label(appId).slice(0, ADD_ON_TITLE_MAX), amountMinor: list.filter((row) => row.appId === appId).reduce((sum, row) => sum + row.amountMinor, 0) };
    list = list.flatMap((row) => (row === first ? [merged] : row.appId === appId ? [] : [row]));
  }
  if (list.length > max) {
    const kept = list.slice(0, max - 1);
    kept.push({ appId: null, title: neutral.slice(0, ADD_ON_TITLE_MAX), amountMinor: list.slice(max - 1).reduce((sum, row) => sum + row.amountMinor, 0) });
    list = kept;
  }
  return list;
}

/** How a summary names folded rows: an app's name where known, else the neutral label in the reader's language. */
export interface AddOnFolding {
  appName?: (appId: string | null) => string | null | undefined;
  /** `addOnFoldLabel(language)`. */
  foldLabel: string;
}

/**
 * The add-on rows of lines whose subtotal is `subtotalMinor`, in the order
 * they first appear, at most `ADD_ON_ROWS_MAX`: past it each app's rows fold
 * into one row under its name, or the neutral label where no name is known
 * (`folding`). A free add-on (0) adds no row. Rows that would exceed the
 * subtotal (lines that are not the subtotal's) give no rows: the summary is
 * display, so it shows the subtotal alone rather than fail.
 */
export function addOnTotals(
  lines: ReadonlyArray<{ quantity: number; addOns: readonly LineAddOn[] }>,
  subtotalMinor: number,
  folding: AddOnFolding,
): AddOnTotals {
  const rows = new Map<string, AddOnTotalRow>();
  for (const line of lines) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) continue;
    for (const addOn of line.addOns) {
      if (addOn.amountMinor <= 0) continue;
      const appId = addOn.appId ?? null;
      const key = `${appId ?? ""}\u0000${addOn.title}`;
      const row = rows.get(key) ?? { appId, title: addOn.title, amountMinor: 0 };
      row.amountMinor += addOn.amountMinor * line.quantity;
      rows.set(key, row);
    }
  }
  const list = foldRows([...rows.values()], ADD_ON_ROWS_MAX, (appId) => folding.appName?.(appId) || folding.foldLabel, folding.foldLabel);
  const addOnsMinor = list.reduce((total, row) => total + row.amountMinor, 0);
  if (!Number.isSafeInteger(addOnsMinor) || addOnsMinor > subtotalMinor) {
    console.warn("[add-ons] the lines' add-ons exceed their subtotal; the summary shows no add-on rows");
    return { itemsSubtotalMinor: subtotalMinor, rows: [] };
  }
  return { itemsSubtotalMinor: subtotalMinor - addOnsMinor, rows: list };
}

/**
 * An order's add-on rows from what its lines froze (each line's `_adjustment`
 * entries and units as placed), against its saved subtotal: the same rows
 * the buyer saw at checkout, whether or not the app is still installed.
 * No rows when the lines do not add up to it (an order saved without its money).
 */
export function frozenAddOnTotals(
  lines: ReadonlyArray<{ quantity: number; properties?: Parameters<typeof lineAddOnsOf>[0] }>,
  subtotalMinor: number,
  /** The reader's language: rows folded past `ADD_ON_ROWS_MAX` read the neutral label in it (an order names no app). */
  language: string | null | undefined,
): AddOnTotals {
  return addOnTotals(lines.map((line) => ({ quantity: line.quantity, addOns: lineAddOnsOf(line.properties) })), subtotalMinor, { foldLabel: addOnFoldLabel(language) });
}

/**
 * The server's rows over a summary's subtotal: the items' subtotal is what
 * they leave of it. Rows larger than the subtotal (an answer for other
 * lines) give none: the subtotal alone.
 */
export function addOnRowsOver(subtotalMinor: number, rows: readonly AddOnTotalRow[] | undefined): AddOnTotals {
  const list = [...(rows ?? [])];
  const addOnsMinor = list.reduce((sum, row) => sum + row.amountMinor, 0);
  return addOnsMinor > subtotalMinor ? { itemsSubtotalMinor: subtotalMinor, rows: [] } : { itemsSubtotalMinor: subtotalMinor - addOnsMinor, rows: list };
}

/** The rows of a cart check's `addOns` as the page reads them: well-formed rows within the bounds, else none. */
export function readAddOnRows(value: unknown): AddOnTotalRow[] {
  const rows = (value as { rows?: unknown } | null | undefined)?.rows;
  if (!Array.isArray(rows) || rows.length > ADD_ON_ROWS_MAX) return [];
  const read = rows.flatMap((row): AddOnTotalRow[] => {
    const { appId, title, amountMinor } = (row ?? {}) as Record<string, unknown>;
    return typeof title === "string" && title.length > 0 && title.length <= ADD_ON_TITLE_MAX && Number.isSafeInteger(amountMinor) && (amountMinor as number) >= 0
      && (appId === null || typeof appId === "string") ? [{ appId: appId as string | null, title, amountMinor: amountMinor as number }] : [];
  });
  return read.length === rows.length ? read : [];
}
