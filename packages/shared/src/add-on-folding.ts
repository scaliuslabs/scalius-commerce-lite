// The apps' add-ons as summary rows, built where the numbers are: from the
// lines checkout priced (the cart check, the checkout quote) or an order
// froze (each line's add-ons per unit times its units), never from an app's
// live answer. A bundle's add-on rides its anchor at the fee over the
// anchor's units per bundle unit, so its row counts it once per bundle unit.
// The pages read the rows with add-on-totals.ts.
import { LINE_ADJUSTMENT_KEY } from "./line-identity";
import { ADD_ON_DETAILS_MAX, ADD_ON_ROWS_MAX, ADD_ON_TITLE_MAX, addOnFoldLabel, readAddOnDetails, type AddOnTotalRow, type AddOnTotals } from "./add-on-totals";
import { readOrderLineProperties } from "./line-properties";
import type { LineAddOn } from "./plugins/functions";

/** One add-on on each unit of a line, in minor units of the summary's currency. */
export interface UnitAddOn {
  appId?: string | null;
  title: string;
  amountMinor: number;
  /** The app's detail lines for it (at most `ADD_ON_DETAILS_MAX`); absent: none. */
  details?: readonly string[];
}

/** Two lists of detail lines as one, in order, at most `max`. */
function joinDetails(left: readonly string[] | undefined, right: readonly string[] | undefined, max: number = ADD_ON_ROWS_MAX): string[] | undefined {
  if (!right?.length) return left?.length ? [...left] : undefined;
  return [...(left ?? []), ...right].slice(0, max);
}

/**
 * The add-ons a frozen or checked line carries among its entries
 * (`_adjustment`: value is the title, priceMinor each unit's amount). An
 * entry without a key is one of a list of add-ons (a stored cart line's).
 */
export function lineAddOnsOf(entries: ReadonlyArray<{ key?: string; value?: string; displayValue?: string; priceMinor?: number; appId?: string | null; details?: unknown }> | null | undefined): UnitAddOn[] {
  return (entries ?? []).flatMap((entry) => {
    if (entry.key !== undefined && entry.key !== LINE_ADJUSTMENT_KEY) return [];
    const amountMinor = entry.priceMinor;
    if (typeof amountMinor !== "number" || !Number.isSafeInteger(amountMinor) || amountMinor < 0) return [];
    const title = (entry.value ?? entry.displayValue ?? "").trim();
    const details = readAddOnDetails(entry.details, ADD_ON_DETAILS_MAX) ?? [];
    return title ? [{ appId: entry.appId ?? null, title, amountMinor, ...(details.length > 0 ? { details } : {}) }] : [];
  });
}

/**
 * A buyer's bundle line's add-ons: its components' summed by app and title,
 * each `amountMinor` times what the component holds per bundle unit, so the
 * line shows the fee once per bundle unit. Checkout puts every add-on of an
 * expanded bundle on its one anchor and refuses past `LINE_ADD_ONS_MAX`, so
 * the sum never holds more entries than that.
 */
export function aggregateLineAddOns(entries: ReadonlyArray<UnitAddOn & { perUnit?: number }>): AddOnTotalRow[] {
  const sums = new Map<string, AddOnTotalRow>();
  for (const entry of entries) {
    const appId = entry.appId ?? null;
    const key = `${appId ?? ""}\u0000${entry.title}`;
    const row = sums.get(key) ?? { appId, title: entry.title, amountMinor: 0 };
    row.amountMinor += entry.amountMinor * (entry.perUnit ?? 1);
    // A bundle's add-on is one per bundle unit: its components' detail lines join within one add-on's bound.
    const details = joinDetails(row.details, entry.details, ADD_ON_DETAILS_MAX);
    if (details) row.details = details;
    sums.set(key, row);
  }
  return [...sums.values()];
}

export { ADD_ON_FOLD_WORDS, addOnFoldLabel } from "./add-on-totals";

/**
 * At most `max` rows with the same sum: first each app with several rows
 * (the most first) becomes one row under its name (`label`), then the rows
 * past the last place join one under the neutral label.
 */
function foldRows(rows: AddOnTotalRow[], max: number, label: (appId: string | null) => string | null | undefined, neutral: string): AddOnTotalRow[] {
  let list = rows;
  while (list.length > max) {
    const counts = new Map<string | null, number>();
    for (const row of list) counts.set(row.appId, (counts.get(row.appId) ?? 0) + 1);
    const [appId, count] = [...counts].sort((left, right) => right[1] - left[1])[0]!;
    if (count < 2) break;
    const first = list.find((row) => row.appId === appId)!;
    const own = list.filter((row) => row.appId === appId);
    const details = own.reduce<string[] | undefined>((joined, row) => joinDetails(joined, row.details), undefined);
    const name = label(appId);
    const merged: AddOnTotalRow = { appId, title: (name || neutral).slice(0, ADD_ON_TITLE_MAX), amountMinor: own.reduce((sum, row) => sum + row.amountMinor, 0), ...(details ? { details } : {}), ...(name ? {} : { folded: true as const }) };
    list = list.flatMap((row) => (row === first ? [merged] : row.appId === appId ? [] : [row]));
  }
  if (list.length > max) {
    const kept = list.slice(0, max - 1);
    const rest = list.slice(max - 1);
    const details = rest.reduce<string[] | undefined>((joined, row) => joinDetails(joined, row.details), undefined);
    kept.push({ appId: null, title: neutral.slice(0, ADD_ON_TITLE_MAX), amountMinor: rest.reduce((sum, row) => sum + row.amountMinor, 0), ...(details ? { details } : {}), folded: true });
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
  lines: ReadonlyArray<{ quantity: number; addOns: readonly UnitAddOn[] }>,
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
      // The row opens to its lines' detail lines, in line order (`ADD_ON_ROWS_MAX` at most).
      const details = joinDetails(row.details, addOn.details);
      if (details) row.details = details;
      rows.set(key, row);
    }
  }
  const list = foldRows([...rows.values()], ADD_ON_ROWS_MAX, (appId) => folding.appName?.(appId), folding.foldLabel);
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
 * One app add-on of a line or a buyer's row in the one contract shape
 * (`LineAddOn`: exact `totalMinor`, `amountMinor` per unit or per bundle
 * unit when exact, `per`), with the app's detail lines where a surface
 * shows them (the receipt, the account order, the order emails, the invoice).
 */
export type BuyerLineAddOn = LineAddOn & { details?: string[] };

/**
 * The add-ons of one line, or of a buyer row over its real lines, in the one
 * contract shape (`LineAddOn`): what a function's cart line, the cart's and
 * an order's UI slots, the order representation and the buyer's pages carry.
 * Read from what the lines priced or froze (`_adjustment` entries, each per
 * unit), never from a folded row's entries times its quantity. Each
 * add-on's `totalMinor` is its lines' amounts times their units, summed; its
 * `per` is what the line froze (an add-on on a line of an expanded bundle or
 * a kit is the bundle's, once per bundle unit: checkout freezes it on the
 * anchor at the fee over the anchor's units per bundle unit); its
 * `amountMinor` is given only when it is exact for every unit (every line of
 * the row charged the same per unit, or the bundle's units divide the total).
 */
export function buyerLineAddOns(
  lines: ReadonlyArray<{ entries: Parameters<typeof lineAddOnsOf>[0]; quantity: number; bundle: { kind: string } | null }>,
  bundle: { kind: string; units: number | null } | null | undefined,
): BuyerLineAddOn[] {
  const sums = new Map<string, { appId: string | null; title: string; per: "unit" | "bundle"; totalMinor: number; perLine: Map<number, number>; details?: string[] }>();
  const counted = lines.filter((line) => Number.isSafeInteger(line.quantity) && line.quantity > 0);
  counted.forEach((line, lineIndex) => {
    const per = line.bundle && (line.bundle.kind === "expand" || line.bundle.kind === "kit") ? "bundle" : "unit";
    for (const addOn of lineAddOnsOf(line.entries)) {
      const key = `${addOn.appId ?? ""}\u0000${addOn.title}\u0000${per}`;
      const sum = sums.get(key) ?? { appId: addOn.appId ?? null, title: addOn.title, per, totalMinor: 0, perLine: new Map<number, number>() };
      sum.totalMinor += addOn.amountMinor * line.quantity;
      // What each unit of this line pays for it (two entries of one title on one line add up).
      sum.perLine.set(lineIndex, (sum.perLine.get(lineIndex) ?? 0) + addOn.amountMinor);
      const details = joinDetails(sum.details, addOn.details, ADD_ON_DETAILS_MAX);
      if (details) sum.details = details;
      sums.set(key, sum);
    }
  });
  const units = bundle && bundle.kind !== "merge" && bundle.units ? bundle.units : null;
  return [...sums.values()].map((sum) => {
    const amountMinor = sum.per === "bundle"
      ? (units !== null && sum.totalMinor % units === 0 ? sum.totalMinor / units : null)
      : (sum.perLine.size === counted.length && new Set(sum.perLine.values()).size === 1 ? [...sum.perLine.values()][0]! : null);
    return { appId: sum.appId, title: sum.title, totalMinor: sum.totalMinor, amountMinor, per: sum.per, ...(sum.details?.length ? { details: sum.details } : {}) };
  });
}

/**
 * An order's add-on summary rows (`frozenAddOnTotals`) from its REAL lines,
 * before any fold: each line's add-ons times its own units, against the saved
 * subtotal. The receipt, the account order, the order emails and the invoice
 * read them (through `addOnDocumentRows`); no page or document computes money
 * from a folded row's entries.
 */
export function buyerOrderAddOnTotals(
  lines: ReadonlyArray<{ quantity: number; properties: string | null }>,
  subtotalMinor: number,
  language: string | null | undefined,
): AddOnTotals {
  return frozenAddOnTotals(lines.map((line) => ({ quantity: line.quantity, properties: readOrderLineProperties(line.properties) })), subtotalMinor, language);
}
