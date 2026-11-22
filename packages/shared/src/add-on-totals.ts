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
 * The add-on rows of lines whose subtotal is `subtotalMinor`, in the order
 * they first appear. A free add-on (0) adds no row. Throws when the rows
 * would exceed the subtotal: the lines are not the subtotal's.
 */
export function addOnTotals(
  lines: ReadonlyArray<{ quantity: number; addOns: readonly LineAddOn[] }>,
  subtotalMinor: number,
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
  const list = [...rows.values()];
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
