// An order's add-on summary rows as every order document prints them: the
// receipt, the order emails (HTML and plain text, buyer and staff) and the
// invoice. One reader over the server's rows (`buyerOrderAddOnTotals`, from
// the order's real lines against its saved subtotal), so every document's
// Subtotal is the items alone, its add-on rows read the same title and
// amount, and its rows add up to its total. Server only: no buyer page's
// script imports it.
import { ADD_ON_DETAILS_MAX, ADD_ON_ROWS_MAX, addOnRowsOver, type AddOnTotalRow, type AddOnTotals } from "./add-on-totals";
import { frozenAddOnTotals } from "./add-on-folding";
import { readOrderLineProperties } from "./line-properties";

/**
 * An order's add-on summary rows (`frozenAddOnTotals`) from its REAL lines,
 * before any fold: each line's add-ons times its own units, against the saved
 * subtotal. The receipt, the account order, the order emails and the invoice
 * read them; no page or document computes money from a folded row's entries.
 */
export function buyerOrderAddOnTotals(
  lines: ReadonlyArray<{ quantity: number; properties: string | null }>,
  subtotalMinor: number,
  language: string | null | undefined,
): AddOnTotals {
  return frozenAddOnTotals(lines.map((line) => ({ quantity: line.quantity, properties: readOrderLineProperties(line.properties) })), subtotalMinor, language);
}

/** The detail lines a document prints under one row, and in all (an invoice stays one bounded page). */
export const ADD_ON_DOCUMENT_DETAILS = { perRow: ADD_ON_DETAILS_MAX, total: ADD_ON_ROWS_MAX } as const;

/** One add-on row of a document: the app's title, the amount in the document's money, its detail lines (plain text). */
export interface AddOnDocumentRow {
  title: string;
  amountMinor: number;
  amount: string;
  details: string[];
}

/**
 * The document's Subtotal (the items alone) and its add-on rows, from the
 * server's rows over the saved subtotal. Rows that cannot fit the subtotal
 * give none (`addOnRowsOver`): the document then prints the subtotal alone,
 * as the receipt does. Detail lines are capped per row and in all
 * (`ADD_ON_DOCUMENT_DETAILS`), in row order.
 */
export function addOnDocumentRows(
  subtotalMinor: number,
  rows: readonly AddOnTotalRow[] | undefined,
  money: (minor: number) => string,
): { itemsSubtotalMinor: number; rows: AddOnDocumentRow[] } {
  const over = addOnRowsOver(subtotalMinor, rows);
  let left: number = ADD_ON_DOCUMENT_DETAILS.total;
  return {
    itemsSubtotalMinor: over.itemsSubtotalMinor,
    rows: over.rows.map((row) => {
      const details = (row.details ?? []).slice(0, Math.min(ADD_ON_DOCUMENT_DETAILS.perRow, left));
      left -= details.length;
      return { title: row.title, amountMinor: row.amountMinor, amount: money(row.amountMinor), details };
    }),
  };
}
