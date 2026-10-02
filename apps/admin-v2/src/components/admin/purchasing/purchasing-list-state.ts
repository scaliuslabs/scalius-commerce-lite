// The purchasing lists' shareable state: the view tab (and a purchase order
// list's supplier) may sit in the page URL; the search never does.
import type {
  PurchaseOrderListQuery,
  SupplierListQuery,
  TransferListQuery,
} from "~/lib/api-query-options/purchasing";

export const PURCHASE_ORDER_TABS = ["all", "draft", "open", "received", "cancelled"] as const;
export type PurchaseOrderTab = (typeof PURCHASE_ORDER_TABS)[number];

export const TRANSFER_TABS = ["all", "draft", "open", "received", "cancelled"] as const;
export type TransferTab = (typeof TRANSFER_TABS)[number];

export const SUPPLIER_TABS = ["active", "archived"] as const;
export type SupplierTab = (typeof SUPPLIER_TABS)[number];

const RECORD_ID = /^[A-Za-z0-9_-]{1,100}$/;

function pickTab<T extends string>(value: unknown, tabs: readonly T[], skip: T): Exclude<T, typeof skip> | undefined {
  return tabs.find((tab): tab is Exclude<T, typeof skip> => tab !== skip && tab === value);
}

export interface PurchaseOrderListSearch {
  status?: Exclude<PurchaseOrderTab, "all">;
  /** Only this supplier's purchase orders. */
  supplier?: string;
}

export function validatePurchaseOrderListSearch(search: Record<string, unknown>): PurchaseOrderListSearch {
  const status = pickTab(search.status, PURCHASE_ORDER_TABS, "all");
  const supplier = typeof search.supplier === "string" && RECORD_ID.test(search.supplier) ? search.supplier : undefined;
  return { ...(status ? { status } : {}), ...(supplier ? { supplier } : {}) };
}

export function purchaseOrderListQuery(
  tab: PurchaseOrderTab,
  term: string,
  page: number,
  limit: number,
  supplierId?: string,
): PurchaseOrderListQuery {
  return {
    status: tab,
    page,
    limit,
    ...(term.trim() ? { q: term.trim().slice(0, 120) } : {}),
    ...(supplierId ? { supplierId } : {}),
  };
}

export interface TransferListSearch {
  status?: Exclude<TransferTab, "all">;
}

export function validateTransferListSearch(search: Record<string, unknown>): TransferListSearch {
  const status = pickTab(search.status, TRANSFER_TABS, "all");
  return status ? { status } : {};
}

export function transferListQuery(tab: TransferTab, term: string, page: number, limit: number): TransferListQuery {
  return {
    status: tab,
    page,
    limit,
    ...(term.trim() ? { q: term.trim().slice(0, 120) } : {}),
  };
}

export interface SupplierListSearch {
  status?: "archived";
}

export function validateSupplierListSearch(search: Record<string, unknown>): SupplierListSearch {
  return search.status === "archived" ? { status: "archived" } : {};
}

export function supplierListQuery(tab: SupplierTab, term: string, page: number, limit: number): SupplierListQuery {
  return {
    status: tab,
    page,
    limit,
    ...(term.trim() ? { q: term.trim().slice(0, 120) } : {}),
  };
}
