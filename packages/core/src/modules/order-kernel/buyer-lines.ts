// The order's lines as the buyer reads them. A kit's item whose share does not
// divide by its quantity is two order lines of one SKU (`kitPart: "heavy"`,
// one unit a step dearer); the buyer bought one item, so every buyer surface
// (receipt, account order, order lookup, messages, invoices, courier items)
// shows them as one row. Staff views and apps keep the real lines.
import { fromMinor } from "@scalius/shared/money";
import { readOrderLineBundle, type OrderLineBundle } from "@scalius/shared/line-properties";

/** What the fold reads of an order line. */
export interface BuyerFoldableLine {
  id: string;
  variantId: string | null;
  quantity: number;
  /** The frozen `order_items.properties` JSON: its `_bundle` entry names the kit. */
  properties: string | null;
  unitPriceMinor: number;
}

/** The keys of `T` holding an amount or a count (`number` or `number | null`). */
export type BuyerLineAmountKey<T> = {
  [K in keyof T]-?: K extends "quantity" | "unitPriceMinor" ? never : T[K] extends number | null ? K : never;
}[keyof T];

export type BuyerOrderLine<T extends BuyerFoldableLine, P extends keyof T = never> =
  Omit<T, "unitPriceMinor" | P> & { [K in P]: number | null } & {
    /** The unit price, exact; null on a folded row whose total does not divide by its quantity (show the line total). */
    unitPriceMinor: number | null;
    /** The units at their unit prices (`unitPriceMinor × quantity`, summed over the row's lines). */
    unitsTotalMinor: number;
    /** The real order lines this row shows, in order: one for a plain line, two for a split kit item. Actions (returns, reviews) address these. */
    lineIds: string[];
    /** The kit or app bundle the row was bought in, its units and per-unit share counted over the row's lines; null for a plain line. */
    bundle: OrderLineBundle | null;
  };

function sumNullable(left: number | null, right: number | null): number | null {
  return left === null && right === null ? null : (left ?? 0) + (right ?? 0);
}

/**
 * The buyer's rows of an order: lines of one SKU in one store kit (the same
 * `_bundle` id, kind `kit`) are one row at the first one's place, their
 * quantity and the `sum` amounts added up. A per-unit amount (the unit price,
 * each `perUnit` key) reads the row's total over its quantity, or null when
 * that is not a whole minor unit: the surface shows the line total. Every
 * other field is the first line's (the lines are copies of one cart line).
 * Nothing else is ever folded.
 */
export function foldBuyerOrderLines<
  T extends BuyerFoldableLine,
  S extends BuyerLineAmountKey<T> = never,
  P extends BuyerLineAmountKey<T> = never,
>(
  lines: readonly T[],
  options: { sum?: readonly S[]; perUnit?: readonly P[] } = {},
): Array<BuyerOrderLine<T, P>> {
  const sum = options.sum ?? [];
  const perUnit = options.perUnit ?? [];
  const groups: Array<{ members: T[]; bundles: Array<OrderLineBundle | null> }> = [];
  const byKey = new Map<string, (typeof groups)[number]>();
  for (const line of lines) {
    const bundle = readOrderLineBundle(line.properties, line.quantity);
    const key = bundle?.kind === "kit" && line.variantId ? `${bundle.id}\u0000${line.variantId}` : null;
    const group = key ? byKey.get(key) : undefined;
    if (group) {
      group.members.push(line);
      group.bundles.push(bundle);
      continue;
    }
    const created = { members: [line], bundles: [bundle] };
    groups.push(created);
    if (key) byKey.set(key, created);
  }
  return groups.map(({ members, bundles }) => {
    const [first, ...rest] = members as [T, ...T[]];
    const quantity = members.reduce((total, line) => total + line.quantity, 0);
    const unitsTotalMinor = members.reduce((total, line) => total + line.unitPriceMinor * line.quantity, 0);
    const row: Record<string, unknown> = {
      ...(first as object),
      quantity,
      unitPriceMinor: rest.length === 0 ? first.unitPriceMinor : wholeUnit(unitsTotalMinor, quantity),
      unitsTotalMinor,
      lineIds: members.map((line) => line.id),
      bundle: rest.length === 0 ? bundles[0] ?? null : foldedBundle(bundles),
    };
    if (rest.length > 0) {
      for (const key of sum) {
        row[key as string] = members.reduce<number | null>((total, line) => sumNullable(total, line[key] as number | null), null);
      }
      for (const key of perUnit) {
        const total = members.reduce<number | null>(
          (sumSoFar, line) => sumSoFar === null || line[key] === null ? null : sumSoFar + (line[key] as number) * line.quantity,
          0,
        );
        row[key as string] = total === null ? null : wholeUnit(total, quantity);
      }
    }
    return row as BuyerOrderLine<T, P>;
  });
}

function wholeUnit(totalMinor: number, quantity: number): number | null {
  return quantity > 0 && totalMinor % quantity === 0 ? totalMinor / quantity : null;
}

/** A split item's bundle: its kits as each line counts them, its share per kit the lines' together. */
function foldedBundle(bundles: ReadonlyArray<OrderLineBundle | null>): OrderLineBundle | null {
  const [first] = bundles;
  if (!first) return null;
  const units = bundles.every((bundle) => bundle?.units !== null && bundle?.units === first.units) ? first.units : null;
  const perUnit = units !== null && bundles.every((bundle) => bundle?.perUnit != null)
    ? bundles.reduce((total, bundle) => total + bundle!.perUnit!, 0)
    : null;
  return {
    ...first,
    anchor: bundles.some((bundle) => bundle?.anchor === true),
    units: perUnit === null ? null : units,
    perUnit,
  };
}

/**
 * The unit price a surface prints beside a quantity, in major units: exact,
 * or the row's total over its quantity (rounded only when formatted) where a
 * folded row has no whole unit price. Prefer the line total where a surface can.
 */
export function buyerLineUnitPrice(
  line: { unitPriceMinor: number | null; unitsTotalMinor: number; quantity: number },
  decimalPlaces: number,
): number {
  return line.unitPriceMinor !== null || line.quantity <= 0
    ? fromMinor(line.unitPriceMinor ?? line.unitsTotalMinor, decimalPlaces)
    : fromMinor(line.unitsTotalMinor, decimalPlaces) / line.quantity;
}
