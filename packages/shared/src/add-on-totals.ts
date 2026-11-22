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
 * line (`LINE_ADJUSTMENTS_PER_LINE_MAX`), what a buyer's bundle line shows
 * (`aggregateLineAddOns`), what the cart stores and what the page accepts
 * from the cart check and the quote. One number, so no valid cart fails on a count.
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
 * A line's add-ons summed by app and title, in the order they first appear,
 * each `amountMinor` times its `perUnit` (a bundle's components: each one's
 * add-on times what it holds per bundle unit, so the buyer's bundle line
 * shows the fee once per bundle unit), and never more than `max` entries:
 * past it an app's entries fold into its first, then the last entries into
 * one, so the sum is always kept.
 */
export function aggregateLineAddOns(entries: ReadonlyArray<LineAddOn & { perUnit?: number }>, max = LINE_ADD_ONS_MAX): AddOnTotalRow[] {
  const sums = new Map<string, AddOnTotalRow>();
  for (const entry of entries) {
    const appId = entry.appId ?? null;
    const key = `${appId ?? ""}\u0000${entry.title}`;
    const row = sums.get(key) ?? { appId, title: entry.title, amountMinor: 0 };
    row.amountMinor += entry.amountMinor * (entry.perUnit ?? 1);
    sums.set(key, row);
  }
  return foldRows([...sums.values()], max, (row) => row.title);
}

/**
 * At most `max` rows with the same sum: first each app with several rows
 * (the most first) becomes one row named by `appName`, then the rows past
 * the last place join it.
 */
function foldRows(rows: AddOnTotalRow[], max: number, appName: (row: AddOnTotalRow) => string): AddOnTotalRow[] {
  let list = rows;
  while (list.length > max) {
    const counts = new Map<string | null, number>();
    for (const row of list) counts.set(row.appId, (counts.get(row.appId) ?? 0) + 1);
    const [appId, count] = [...counts].sort((left, right) => right[1] - left[1])[0]!;
    if (count < 2) break;
    const first = list.find((row) => row.appId === appId)!;
    const merged = { appId, title: appName(first).slice(0, ADD_ON_TITLE_MAX), amountMinor: list.filter((row) => row.appId === appId).reduce((sum, row) => sum + row.amountMinor, 0) };
    list = list.flatMap((row) => (row === first ? [merged] : row.appId === appId ? [] : [row]));
  }
  if (list.length > max) {
    const kept = list.slice(0, max - 1);
    const rest = list.slice(max - 1);
    kept.push({ appId: null, title: appName(rest[0]!).slice(0, ADD_ON_TITLE_MAX), amountMinor: rest.reduce((sum, row) => sum + row.amountMinor, 0) });
    list = kept;
  }
  return list;
}

/**
 * The add-on rows of lines whose subtotal is `subtotalMinor`, in the order
 * they first appear, at most `ADD_ON_ROWS_MAX`: past it each app's rows fold
 * into one row named `appName(appId)` (its app's name; else its first row's
 * title). A free add-on (0) adds no row. Throws when the rows would exceed
 * the subtotal: the lines are not the subtotal's.
 */
export function addOnTotals(
  lines: ReadonlyArray<{ quantity: number; addOns: readonly LineAddOn[] }>,
  subtotalMinor: number,
  appName?: (appId: string | null) => string | null | undefined,
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
  const list = foldRows([...rows.values()], ADD_ON_ROWS_MAX, (row) => appName?.(row.appId) || row.title);
  const addOnsMinor = list.reduce((total, row) => total + row.amountMinor, 0);
  if (!Number.isSafeInteger(addOnsMinor) || addOnsMinor > subtotalMinor) {
    throw new RangeError("The add-ons exceed the subtotal they are part of.");
  }
  return { itemsSubtotalMinor: subtotalMinor - addOnsMinor, rows: list };
}

/**
 * An order's add-on rows from what its lines froze (each line's `_adjustment`
 * entries and units as placed), against its saved subtotal: the same rows
 * the buyer saw at checkout, whether or not the app is still installed.
 * Null when the lines do not hold them (an order saved without its money).
 */
export function frozenAddOnTotals(
  lines: ReadonlyArray<{ quantity: number; properties?: Parameters<typeof lineAddOnsOf>[0] }>,
  subtotalMinor: number,
): AddOnTotals | null {
  try {
    return addOnTotals(lines.map((line) => ({ quantity: line.quantity, addOns: lineAddOnsOf(line.properties) })), subtotalMinor);
  } catch {
    return null;
  }
}

/** A summary's rows over its subtotal: the items' subtotal is what the rows leave of it. */
export function addOnRowsOver(subtotalMinor: number, rows: readonly AddOnTotalRow[] | undefined): AddOnTotals {
  const list = [...(rows ?? [])];
  return { itemsSubtotalMinor: subtotalMinor - list.reduce((sum, row) => sum + row.amountMinor, 0), rows: list };
}
