// "View product costs" (products.view_costs) at the API edge: reads leave
// unit costs out for callers without it, and writes that set a cost are
// refused. Agent connections carry their grant in the same adminPermissions,
// so they get the same answers.
import type { Context } from "hono";
import { canViewCosts, withoutSkuCost } from "@scalius/core/modules/inventory";
import { ForbiddenError } from "../../utils/api-error";

export const costsVisible = (c: Context): boolean => canViewCosts(c.get("adminPermissions"));

/** A SKU's cost per item, or nothing without the permission. */
export function presentSkuCost<T extends object>(c: Context, sku: T): T | Omit<T, "cost" | "costMinor"> {
  return costsVisible(c) ? sku : withoutSkuCost(sku);
}

/** A record's SKUs (`variants`) with their costs, or without them. */
export function presentSkuCosts<T extends { variants: readonly object[] }>(c: Context, record: T): T {
  if (costsVisible(c)) return record;
  return { ...record, variants: record.variants.map((variant) => withoutSkuCost(variant)) };
}

/** Setting a cost per item needs to see costs. */
export function assertCanWriteCosts(c: Context, writesCosts: boolean): void {
  if (writesCosts && !costsVisible(c)) {
    throw new ForbiddenError("Setting a cost per item needs the View product costs permission.");
  }
}

type MaybeCosted = { cost?: unknown } | null | undefined;
const hasCost = (row: MaybeCosted) => row?.cost !== undefined && row.cost !== null;

/** A product create or save that sets any cost per item (its hidden SKU, new option rows, or changed costs). */
export function productWriteSetsCosts(body: object): boolean {
  const write = body as {
    defaultSku?: MaybeCosted;
    optionMatrix?: { variants?: readonly MaybeCosted[] } | null;
    skuCosts?: readonly unknown[] | null;
  };
  return hasCost(write.defaultSku) ||
    (write.optionMatrix?.variants ?? []).some(hasCost) ||
    (write.skuCosts?.length ?? 0) > 0;
}
