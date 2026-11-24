// An order's add-on summary rows as every order surface shows them: the
// receipt, the account order, the order emails (HTML and plain text, buyer
// and staff), the printable invoice and the dashboard's invoice sheet. One
// decision per order over the server's rows (`buyerOrderAddOnTotals`, from the
// order's real lines against its saved subtotal): either every surface shows
// the rows, Subtotal the items alone and each line its items alone
// (`rowItemsOnly`), or none does and every one shows the saved Subtotal and
// whole lines. So the lines always add up to Subtotal, and Subtotal, the rows,
// delivery, discounts and tax to the total. Small and import-light: the
// account page's script and the dashboard's invoice route read it.
import { ADD_ON_DETAILS_MAX, ADD_ON_ROWS_MAX, addOnFoldLabel, type AddOnTotalRow } from "./add-on-totals";
import { rowAddOnsMinor } from "./buyer-line-add-on-text";

/** The detail lines a document prints under one row, and in all (an invoice stays one bounded page and snapshot). */
export const ADD_ON_DOCUMENT_DETAILS = { perRow: ADD_ON_DETAILS_MAX, total: ADD_ON_ROWS_MAX } as const;

/** The rows with only the detail lines a document prints: at most `perRow` a row and `total` in all, in row order. */
export function capAddOnDetails<R extends AddOnTotalRow>(rows: readonly R[]): R[] {
  let left: number = ADD_ON_DOCUMENT_DETAILS.total;
  return rows.map((row) => {
    if (!row.details?.length) return row;
    const details = row.details.slice(0, Math.min(ADD_ON_DOCUMENT_DETAILS.perRow, left));
    left -= details.length;
    const { details: _all, ...rest } = row;
    return (details.length > 0 ? { ...rest, details } : rest) as R;
  });
}

/**
 * Whether an order shows its add-on rows, decided once for every surface:
 * the rows fit the saved subtotal and every line's own add-ons fit that
 * line's amount (`grossSubtotalMinor`, the amount the surface prints for it;
 * null: unknown). Else no rows anywhere: the saved Subtotal and whole lines.
 */
export function orderAddOnRowsOver<R extends { amountMinor: number }>(
  subtotalMinor: number,
  rows: readonly R[] | undefined,
  lines: ReadonlyArray<{ grossSubtotalMinor: number | null; addOns?: unknown }>,
): { itemsSubtotalMinor: number; rows: R[] } {
  const list = [...(rows ?? [])];
  const addOnsMinor = list.reduce((sum, row) => sum + row.amountMinor, 0);
  const linesFit = lines.every((line) => {
    const own = rowAddOnsMinor(line);
    return own === 0 || (line.grossSubtotalMinor !== null && own <= line.grossSubtotalMinor);
  });
  return list.length === 0 || addOnsMinor > subtotalMinor || !linesFit
    ? { itemsSubtotalMinor: subtotalMinor, rows: [] }
    : { itemsSubtotalMinor: subtotalMinor - addOnsMinor, rows: list };
}

/** One add-on row of a document: the app's title, the amount in the document's money, its detail lines (plain text). */
export interface AddOnDocumentRow {
  title: string;
  amountMinor: number;
  amount: string;
  details: string[];
}

/**
 * The document's Subtotal (the items alone) and its add-on rows, from the
 * server's rows over the saved subtotal and the lines the document prints
 * (`orderAddOnRowsOver`). A row folded under the neutral label is worded in
 * the document's language; detail lines are capped (`capAddOnDetails`).
 */
export function addOnDocumentRows(
  subtotalMinor: number,
  rows: readonly AddOnTotalRow[] | undefined,
  options: {
    money: (minor: number) => string;
    lines: ReadonlyArray<{ grossSubtotalMinor: number | null; addOns?: unknown }>;
    language: string | null | undefined;
  },
): { itemsSubtotalMinor: number; rows: AddOnDocumentRow[] } {
  const over = orderAddOnRowsOver(subtotalMinor, rows, options.lines);
  return {
    itemsSubtotalMinor: over.itemsSubtotalMinor,
    rows: capAddOnDetails(over.rows).map((row) => ({
      title: row.folded ? addOnFoldLabel(options.language) : row.title,
      amountMinor: row.amountMinor,
      amount: options.money(row.amountMinor),
      details: row.details ?? [],
    })),
  };
}
