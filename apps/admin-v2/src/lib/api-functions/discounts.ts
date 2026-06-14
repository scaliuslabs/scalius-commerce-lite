import { createServerFn } from "@tanstack/react-start";
import { apiDelete, apiGet, apiPost, apiPut } from "../api.server";

type Timestamp = string | number;
type NullableTimestamp = Timestamp | null;

export type DiscountType =
  | "amount_off_products"
  | "amount_off_order"
  | "free_shipping";

export type DiscountValueType = "percentage" | "fixed_amount" | "free";

export interface DiscountRelationIds {
  buy: string[];
  get: string[];
}

export interface DiscountDto {
  id: string;
  code: string;
  type: DiscountType | string;
  valueType: DiscountValueType | string;
  discountValue: number;
  minPurchaseAmount: number | null;
  minQuantity: number | null;
  maxUsesPerOrder: number | null;
  maxUses: number | null;
  limitOnePerCustomer: boolean;
  combineWithProductDiscounts: boolean;
  combineWithOrderDiscounts: boolean;
  combineWithShippingDiscounts: boolean;
  customerSegment: string | null;
  startDate: NullableTimestamp;
  endDate: NullableTimestamp;
  isActive: boolean;
  createdAt: NullableTimestamp;
  updatedAt: NullableTimestamp;
  deletedAt: NullableTimestamp;
  relatedProducts: DiscountRelationIds;
  relatedCollections: DiscountRelationIds;
  usageCount?: number;
  totalDiscountAmount?: number;
}

export interface PaginationPayload {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface DiscountsListPayload {
  discounts: DiscountDto[];
  pagination: PaginationPayload;
}

export interface DiscountsQueryInput {
  [key: string]: string | number | boolean | undefined;
  page?: number;
  limit?: number;
  search?: string;
  type?: DiscountType | string;
  sort?: string;
  order?: string;
  showTrashed?: boolean;
  trashed?: boolean;
}

export interface DiscountWriteInput {
  code: string;
  type: DiscountType;
  valueType: DiscountValueType;
  discountValue: number;
  minPurchaseAmount?: number | null;
  minQuantity?: number | null;
  maxUsesPerOrder?: number | null;
  maxUses?: number | null;
  limitOnePerCustomer: boolean;
  combineWithProductDiscounts?: boolean;
  combineWithOrderDiscounts?: boolean;
  combineWithShippingDiscounts?: boolean;
  customerSegment?: string | null;
  startDate: string | number;
  endDate?: string | number | null;
  isActive: boolean;
  appliesToProducts?: string[];
  appliesToCollections?: string[];
}

export type CreateDiscountInput = DiscountWriteInput;
export type UpdateDiscountInput = { id: string } & DiscountWriteInput;

export interface DiscountIdPayload {
  id: string;
}

export interface ToggleDiscountStatusInput {
  id: string;
  isActive: boolean;
}

export interface ToggleDiscountStatusPayload {
  id: string;
  isActive: boolean;
}

function toDiscountsParams(input: DiscountsQueryInput): Record<string, string> {
  const params: Record<string, string> = {};
  if (input.page) params.page = String(input.page);
  if (input.limit) params.limit = String(input.limit);
  if (input.search) params.search = input.search;
  if (input.type) params.type = input.type;
  if (input.sort) params.sort = input.sort;
  if (input.order) params.order = input.order;
  if (input.showTrashed || input.trashed) params.trashed = "true";
  return params;
}

export const getDiscounts = createServerFn({ method: "GET" })
  .validator((data: DiscountsQueryInput) => data)
  .handler(async ({ data }): Promise<DiscountsListPayload> => {
    return apiGet<DiscountsListPayload>("/discounts", toDiscountsParams(data));
  });

export const getDiscount = createServerFn({ method: "GET" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<DiscountDto> => {
    return apiGet<DiscountDto>(`/discounts/${data.id}`);
  });

export const createDiscount = createServerFn({ method: "POST" })
  .validator((data: CreateDiscountInput) => data)
  .handler(async ({ data }): Promise<DiscountIdPayload> => {
    return apiPost<DiscountIdPayload>("/discounts", data);
  });

export const updateDiscount = createServerFn({ method: "POST" })
  .validator((data: UpdateDiscountInput) => data)
  .handler(async ({ data }): Promise<DiscountIdPayload> => {
    return apiPut<DiscountIdPayload>(`/discounts/${data.id}`, data);
  });

export const deleteDiscount = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiDelete(`/discounts/${data.id}`);
  });

export const permanentDeleteDiscount = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiDelete(`/discounts/${data.id}/permanent`);
  });

export const restoreDiscount = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<Record<string, never>> => {
    return apiPost<Record<string, never>>(`/discounts/${data.id}/restore`);
  });

export const toggleDiscountStatus = createServerFn({ method: "POST" })
  .validator((data: ToggleDiscountStatusInput) => data)
  .handler(async ({ data }): Promise<ToggleDiscountStatusPayload> => {
    return apiPost<ToggleDiscountStatusPayload>(
      `/discounts/${data.id}/toggle-status`,
      { isActive: data.isActive },
    );
  });

export const bulkDeleteDiscounts = createServerFn({ method: "POST" })
  .validator(
    (data: { discountIds: string[]; permanent?: boolean }) => data,
  )
  .handler(async ({ data }): Promise<void> => {
    return apiPost("/discounts/bulk-delete", data);
  });

export const bulkRestoreDiscounts = createServerFn({ method: "POST" })
  .validator((data: { discountIds: string[] }) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiPost("/discounts/bulk-restore", data);
  });
