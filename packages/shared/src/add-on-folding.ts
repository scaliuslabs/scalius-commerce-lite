// The apps' add-ons as summary rows, built where the numbers are: from the
// lines checkout priced (the cart check, the checkout quote) or an order
// froze (each line's add-ons per unit times its units), never from an app's
// live answer. A bundle's add-on rides its anchor at the fee over the
// anchor's units per bundle unit, so its row counts it once per bundle unit.
// The pages read the rows with add-on-totals.ts.
import { LINE_ADJUSTMENT_KEY } from "./line-identity";
import { ADD_ON_ROWS_MAX, ADD_ON_TITLE_MAX, type AddOnTotalRow, type AddOnTotals } from "./add-on-totals";

/** One add-on on each unit of a line, in minor units of the summary's currency. */
export interface LineAddOn {
  appId?: string | null;
  title: string;
  amountMinor: number;
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
