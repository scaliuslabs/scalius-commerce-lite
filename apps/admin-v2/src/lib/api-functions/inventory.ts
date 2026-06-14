import { createServerFn } from "@tanstack/react-start";
import { apiGet, apiPost } from "../api.server";

export interface InventoryVariant {
  id: string;
  productId: string;
  productName: string | null;
  sku: string;
  size: string | null;
  color: string | null;
  price: number;
  stock: number;
  reservedStock: number;
  available: number;
  lowStockThreshold: number | null;
  version: number;
}

export interface InventoryStats {
  totalVariants: number;
  totalOnHand: number;
  totalReserved: number;
  totalAvailable: number;
  outOfStockCount: number;
  lowStockCount: number;
}

export interface InventoryMovement {
  id: string;
  variantId: string;
  orderId: string | null;
  type: string;
  quantity: number;
  previousStock: number;
  newStock: number;
  notes: string | null;
  createdBy: string | null;
  createdAt: string | number;
  variantSku: string | null;
  productName: string | null;
}

export interface InventoryAlert {
  id: string;
  variantId: string;
  productId: string;
  currentQty: number;
  threshold: number;
  alertStatus: string;
  alertSentAt: string | number | null;
  acknowledgedAt: string | number | null;
  resolvedAt: string | number | null;
  productName: string | null;
  variantSku: string | null;
  variantSize: string | null;
  variantColor: string | null;
}

export interface InventoryPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface InventoryOverviewPayload {
  variants?: InventoryVariant[];
  movements?: InventoryMovement[];
  alerts?: InventoryAlert[];
  pagination?: InventoryPagination;
  stats?: InventoryStats;
}

export interface InventoryQueryInput {
  [key: string]: string | number | boolean | undefined;
  page?: number;
  limit?: number;
  search?: string;
  lowStock?: boolean;
  section?: string;
  status?: string;
  alertStatus?: string;
  sort?: "productName" | "sku" | "available" | string;
  order?: "asc" | "desc" | string;
}

export type InventoryAdjustmentReason =
  | "received"
  | "correction"
  | "damage"
  | "theft"
  | "return"
  | "other";

export interface AdjustInventoryInput {
  variantId: string;
  delta: number;
  reason: InventoryAdjustmentReason;
  notes?: string;
  pool?: "stock" | "preorderStock";
}

export interface AdjustInventoryResult {
  variantId: string;
  previousStock: number;
  newStock: number;
  delta: number;
}

export interface StockAdjustInput {
  variantId: string;
  adjustment: number;
  reason?: string;
}

export interface StockSetInput {
  variantId: string;
  newStock: number;
  reason?: string;
}

function toQueryParams(data: InventoryQueryInput): Record<string, string> {
  const params: Record<string, string> = {};
  if (data.page) params.page = String(data.page);
  if (data.limit) params.limit = String(data.limit);
  if (data.search) params.search = data.search;
  if (data.section) params.section = data.section;
  if (data.status) params.status = data.status;
  else if (data.lowStock) params.status = "low";
  if (data.alertStatus) params.alertStatus = data.alertStatus;
  if (data.sort) params.sort = data.sort;
  if (data.order) params.order = data.order;
  return params;
}

export const getInventory = createServerFn({ method: "GET" })
  .validator((data: InventoryQueryInput) => data)
  .handler(async ({ data }) => {
    return apiGet<InventoryOverviewPayload>("/inventory", toQueryParams(data));
  });

export const adjustInventory = createServerFn({ method: "POST" })
  .validator((data: AdjustInventoryInput) => data)
  .handler(async ({ data }) => {
    const { variantId, ...body } = data;
    return apiPost<AdjustInventoryResult>(
      `/inventory/${variantId}/adjust`,
      body,
    );
  });

export const stockAdjust = createServerFn({ method: "POST" })
  .validator((data: StockAdjustInput) => data)
  .handler(async ({ data }) => {
    return apiPost<AdjustInventoryResult>("/inventory/stock-adjust", data);
  });

export const stockSet = createServerFn({ method: "POST" })
  .validator((data: StockSetInput) => data)
  .handler(async ({ data }) => {
    return apiPost<AdjustInventoryResult>("/inventory/stock-set", data);
  });
