// The apps' add-ons as rows of a money summary ("Protection ৳350"), as a
// page reads them: one row per app and add-on title, summed over the lines'
// units, and the subtotal of the items without them, so the summary shows
// Subtotal, the add-on rows, delivery, discounts, tax and the total. The
// rows come from the server (the cart check, the checkout quote) or an
// order's frozen lines (add-on-folding.ts builds them); this leaf only reads
// and places them, so the cart drawer and the checkout pages carry no
// folding code, and the product page's first paint none at all (the cart
// store imports the line bound from line-identity.ts).

/**
 * The most add-on rows one money summary shows: past it the server folds an
 * app's rows into one row under the app's name (`addOnTotals`), so the rows
 * still add up and the page always takes them.
 */
export const ADD_ON_ROWS_MAX = 50;
/** An add-on's title, at most (`cart.line_prices` titles). */
export const ADD_ON_TITLE_MAX = 80;

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
