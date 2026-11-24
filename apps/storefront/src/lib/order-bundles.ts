// A placed order's rows as the buyer bought them: a bundle (a store kit or an
// app's bundle: rows sharing `bundle.id`) is one entry with its items under
// it, at its first row's place; every other row is its own entry. The account
// order page draws one bundle once from these, the order cards count it as the
// buyer bought it, and a row's amounts leave out what the apps charged on it,
// because the summary shows those as their own rows (`addOns`). Pure and small:
// the account page's script, the receipt and the order cards share it.
import { LINE_BUNDLE_KEY } from "@scalius/shared/line-identity";

/** A row's bundle as the API sends it (`OrderLineBundle`). */
export interface RowBundle {
  id: string;
  title: string;
  /** The sets bought, when the row's units divide into them. */
  units: number | null;
  /** This row's units in each set. */
  perUnit: number | null;
}

interface BundledRow {
  quantity: number;
  bundle?: RowBundle | null;
}

export type OrderEntry<T> =
  | { kind: "row"; row: T }
  | { kind: "bundle"; bundle: RowBundle; /** Sets bought; null when the rows disagree. */ units: number | null; rows: T[] };

function bundleOf(row: BundledRow): RowBundle | null {
  const bundle = row.bundle;
  return bundle && typeof bundle.id === "string" && bundle.id && typeof bundle.title === "string" ? bundle : null;
}

/** The order's entries in order: a bundle once, where its first row was. */
export function orderEntries<T extends BundledRow>(rows: readonly T[]): Array<OrderEntry<T>> {
  const entries: Array<OrderEntry<T>> = [];
  const bundles = new Map<string, Extract<OrderEntry<T>, { kind: "bundle" }>>();
  for (const row of rows) {
    const bundle = bundleOf(row);
    if (!bundle) {
      entries.push({ kind: "row", row });
      continue;
    }
    const entry = bundles.get(bundle.id);
    if (entry) {
      entry.rows.push(row);
      if (entry.units !== bundle.units) entry.units = null;
      continue;
    }
    const created = { kind: "bundle" as const, bundle, units: bundle.units, rows: [row] };
    bundles.set(bundle.id, created);
    entries.push(created);
  }
  return entries;
}

/** Items as the buyer bought them: a row's quantity, a bundle's sets (one when unknown). */
export function boughtItemCount(rows: readonly BundledRow[]): number {
  return orderEntries(rows).reduce((sum, entry) => sum + (entry.kind === "row" ? entry.row.quantity : entry.units ?? 1), 0);
}

/** A row's frozen entries without its bundle's (the bundle is named once, above its items). */
export function withoutBundleEntry<P extends { key?: unknown }>(properties: readonly P[] | null | undefined): P[] | null {
  return Array.isArray(properties) ? properties.filter((property) => property?.key !== LINE_BUNDLE_KEY) : null;
}

