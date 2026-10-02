// A purchase order's money, worked in integer minor units exactly as the API
// does (`packages/shared/src/money.ts`): each line is quantity × unit cost,
// the subtotal their sum, the total the subtotal plus shipping, other costs
// and tax. Costs keep their paisa: they are not cash amounts.
import { fromMinor, toMinor } from "@scalius/shared/money";

/** A cost in major units to minor units, or null when it isn't a usable cost. */
export function costMinor(amount: number | null | undefined, decimals: number): number | null {
  if (amount === null || amount === undefined || !Number.isFinite(amount) || amount < 0) return null;
  try {
    return toMinor(amount, decimals);
  } catch {
    return null;
  }
}

/** A line's total in major units, or null while its quantity or cost is unusable. */
export function lineTotal(quantity: number | null, unitCost: number | null, decimals: number): number | null {
  const unit = costMinor(unitCost, decimals);
  if (unit === null || quantity === null || !Number.isSafeInteger(quantity) || quantity < 0) return null;
  const total = unit * quantity;
  return Number.isSafeInteger(total) ? fromMinor(total, decimals) : null;
}

export interface DocumentTotals {
  /** Units across every line. */
  units: number;
  subtotal: number;
  total: number;
  /** Every line and extra cost is a usable number. */
  complete: boolean;
}

/**
 * Subtotal and total of the lines that are usable; an empty extra cost counts
 * as nothing. `complete` is false while any line or cost can't be read.
 */
export function documentTotals(
  lines: ReadonlyArray<{ quantity: number | null; unitCost: number | null }>,
  extras: ReadonlyArray<number | null>,
  decimals: number,
): DocumentTotals {
  let complete = true;
  let units = 0;
  let subtotalMinor = 0;
  for (const line of lines) {
    const unit = costMinor(line.unitCost, decimals);
    const quantity = line.quantity;
    if (unit === null || quantity === null || !Number.isSafeInteger(quantity) || quantity < 0) {
      complete = false;
      continue;
    }
    units += quantity;
    subtotalMinor += unit * quantity;
  }
  let extrasMinor = 0;
  for (const extra of extras) {
    if (extra === null) continue;
    const minor = costMinor(extra, decimals);
    if (minor === null) {
      complete = false;
      continue;
    }
    extrasMinor += minor;
  }
  return {
    units,
    subtotal: fromMinor(subtotalMinor, decimals),
    total: fromMinor(subtotalMinor + extrasMinor, decimals),
    complete,
  };
}
