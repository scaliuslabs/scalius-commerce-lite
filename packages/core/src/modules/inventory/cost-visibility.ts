// What a reader without "View product costs" (products.view_costs) gets:
// the same records with every unit cost, margin, inventory value and
// purchase-order amount left out. Shopify's model: staff who can see a
// product or a purchase order see its quantities, never what it cost.
//
// One place lists the money fields of each record, so an API response, an
// agent operation and an export all leave out the same things.
import { PERMISSIONS } from "../../auth/rbac/permissions";
import type {
  PurchaseOrderDetail,
  PurchaseOrderReceiptResult,
  PurchaseOrderSummary,
} from "./purchase-orders";

/** The caller may see unit costs and everything computed from them. */
export function canViewCosts(permissions: ReadonlySet<string> | undefined | null): boolean {
  return permissions?.has(PERMISSIONS.PRODUCTS_VIEW_COSTS) ?? false;
}

function omit<T extends object, K extends keyof T>(record: T, keys: readonly K[]): Omit<T, K> {
  const copy = { ...record };
  for (const key of keys) delete copy[key];
  return copy;
}

/** A SKU (inventory row, product variant) without its cost per item. */
export function withoutSkuCost<T extends object>(sku: T): Omit<T, "cost" | "costMinor"> {
  const { cost: _cost, costMinor: _costMinor, ...rest } = sku as T & { cost?: unknown; costMinor?: unknown };
  return rest as Omit<T, "cost" | "costMinor">;
}

const SUMMARY_MONEY = ["subtotal", "total"] as const;
const DETAIL_MONEY = [...SUMMARY_MONEY, "shipping", "otherCosts", "tax"] as const;
const LINE_MONEY = ["unitCost", "lineTotal", "currentCost"] as const;
const RECEIPT_LINE_MONEY = ["unitCost", "costBefore", "costAfter"] as const;

type Omitted<T, K extends PropertyKey> = Omit<T, Extract<keyof T, K>>;

export function purchaseOrderSummaryWithoutCosts(summary: PurchaseOrderSummary): Omitted<PurchaseOrderSummary, (typeof SUMMARY_MONEY)[number]> {
  return omit(summary, SUMMARY_MONEY);
}

export function purchaseOrderWithoutCosts(order: PurchaseOrderDetail) {
  return {
    ...omit(order, DETAIL_MONEY),
    lines: order.lines.map((line) => omit(line, LINE_MONEY)),
    receipts: order.receipts.map((receipt) => ({
      ...receipt,
      lines: receipt.lines.map((line) => omit(line, RECEIPT_LINE_MONEY)),
    })),
  };
}

export function purchaseOrderReceiptWithoutCosts(result: PurchaseOrderReceiptResult) {
  return { ...result, lines: result.lines.map((line) => omit(line, RECEIPT_LINE_MONEY)) };
}

/**
 * A location as a stock screen needs it (where units are), without its
 * address and phone: those need "View inventory operations" or "View store
 * settings".
 */
export function canViewLocationDetails(permissions: ReadonlySet<string> | undefined | null): boolean {
  return (permissions?.has(PERMISSIONS.INVENTORY_VIEW) ?? false) ||
    (permissions?.has(PERMISSIONS.SETTINGS_GENERAL_VIEW) ?? false);
}

const LOCATION_DETAILS = ["addressLine1", "addressLine2", "city", "postalCode", "phone"] as const;

export function locationWithoutDetails<T extends object>(location: T): Omitted<T, (typeof LOCATION_DETAILS)[number]> {
  const copy: Record<string, unknown> = { ...(location as Record<string, unknown>) };
  for (const key of LOCATION_DETAILS) delete copy[key];
  return copy as Omitted<T, (typeof LOCATION_DETAILS)[number]>;
}
