// "Adjust stock" (products.adjust_stock) at the API edge: product and SKU
// writes that set an on-hand quantity are refused without it, like costs
// (cost-access.ts). Staff kept it with products.edit (migration 0158); an app
// holds it only through the write_inventory scope, so write_products never
// changes stock.
import type { Context } from "hono";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { ForbiddenError } from "../../utils/api-error";

type MaybeStocked = { stock?: number | null; expectedStockVersion?: number | null } | null | undefined;

/**
 * A row that sets a quantity: a saved SKU's quantity edit (`stock` with the
 * `expectedStockVersion` it was based on) or a new SKU's starting stock above
 * zero. A new SKU at 0 moves no stock.
 */
export function rowSetsStock(row: MaybeStocked): boolean {
  if (!row || row.stock === undefined || row.stock === null) return false;
  return (row.expectedStockVersion !== undefined && row.expectedStockVersion !== null) || row.stock > 0;
}

/** A product, option matrix or SKU write that sets any quantity. */
export function writeSetsStock(body: object): boolean {
  const write = body as MaybeStocked & {
    defaultSku?: MaybeStocked;
    optionMatrix?: { variants?: readonly MaybeStocked[] } | null;
    variants?: readonly MaybeStocked[];
  };
  return rowSetsStock(write)
    || rowSetsStock(write.defaultSku)
    || (write.optionMatrix?.variants ?? []).some(rowSetsStock)
    || (Array.isArray(write.variants) ? write.variants : []).some(rowSetsStock);
}

export function canAdjustStock(c: Context): boolean {
  return (c.get("adminPermissions") as ReadonlySet<string> | undefined)?.has(PERMISSIONS.PRODUCTS_ADJUST_STOCK) ?? false;
}

/** Setting an on-hand quantity needs the Adjust stock permission. */
export function assertCanWriteStock(c: Context, writesStock: boolean): void {
  if (writesStock && !canAdjustStock(c)) {
    throw new ForbiddenError("Setting a quantity needs the Adjust stock permission. Leave stock out to keep it.");
  }
}
