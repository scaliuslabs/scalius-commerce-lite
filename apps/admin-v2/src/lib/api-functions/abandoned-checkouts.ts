import { createAdminApiFunction as createServerFn } from "../admin-api-function";
import type { AbandonedCheckout } from "~/types/api-responses";
import { apiDelete, apiGet } from "../api";

export interface AbandonedCheckoutsQueryInput {
  [key: string]: string | number | undefined;
  page?: number;
  limit?: number;
  search?: string;
  sort?: string;
  order?: string;
}

export interface AbandonedCheckoutsListPayload {
  checkouts: AbandonedCheckout[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface DeleteAbandonedCheckoutsInput {
  ids: string[];
}

function toAbandonedCheckoutParams(
  input: AbandonedCheckoutsQueryInput,
): Record<string, string> {
  const params: Record<string, string> = {};
  if (input.page) params.page = String(input.page);
  if (input.limit) params.limit = String(input.limit);
  if (input.search) params.search = input.search;
  if (input.sort) params.sort = input.sort;
  if (input.order) params.order = input.order;
  return params;
}

export const getAbandonedCheckouts = createServerFn({ method: "GET" })
  .validator((data: AbandonedCheckoutsQueryInput) => data)
  .handler(async ({ data }) => apiGet<AbandonedCheckoutsListPayload>(
    "/abandoned-checkouts",
    toAbandonedCheckoutParams(data),
  ));

export const deleteAbandonedCheckouts = createServerFn({ method: "POST" })
  .validator((data: DeleteAbandonedCheckoutsInput) => data)
  .handler(async ({ data }) => {
    return apiDelete("/abandoned-checkouts", data);
  });
