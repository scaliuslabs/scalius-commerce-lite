import { createServerFn } from "@tanstack/react-start";
import type {
  GetApiV1AdminCustomersByIdHistoryResponse,
  GetApiV1AdminCustomersByIdResponse,
  GetApiV1AdminCustomersData,
  GetApiV1AdminCustomersResponse,
  PostApiV1AdminCustomersBulkDeleteData,
  PostApiV1AdminCustomersData,
  PostApiV1AdminCustomersResponse,
  PutApiV1AdminCustomersByIdData,
} from "@scalius/api-client/types";
import { apiDelete, apiGet, apiPost, apiPut } from "../api.server";

type JsonSerializable<T> = T extends Array<infer Item>
  ? JsonSerializable<Item>[]
  : T extends object
    ? {
        [Key in keyof T as string extends Key
          ? never
          : number extends Key
            ? never
            : symbol extends Key
              ? never
              : Key]: JsonSerializable<T[Key]>;
      }
    : T;

type ApiData<T> = T extends { success: true; data: infer Data }
  ? JsonSerializable<Data>
  : never;

type ApiBody<T extends { body?: unknown }> = JsonSerializable<
  NonNullable<T["body"]>
>;

type CustomerListQuery = NonNullable<GetApiV1AdminCustomersData["query"]>;

export interface CustomersQueryInput extends Omit<CustomerListQuery, "trashed"> {
  [key: string]: string | number | boolean | null | undefined;
  showTrashed?: boolean;
  trashed?: boolean;
}

export type CustomersListPayload = ApiData<GetApiV1AdminCustomersResponse>;
export type CustomerDto = ApiData<GetApiV1AdminCustomersByIdResponse>;
export type CustomerHistoryPayload =
  ApiData<GetApiV1AdminCustomersByIdHistoryResponse>;
export type CreateCustomerInput = ApiBody<PostApiV1AdminCustomersData>;
export type UpdateCustomerInput = { id: string } &
  ApiBody<PutApiV1AdminCustomersByIdData>;
export type CreateCustomerPayload = ApiData<PostApiV1AdminCustomersResponse>;
export type BulkDeleteCustomersInput =
  ApiBody<PostApiV1AdminCustomersBulkDeleteData>;

function buildCustomersParams(data: CustomersQueryInput): Record<string, string> {
  const params: Record<string, string> = {};
  if (data.page != null) params.page = String(data.page);
  if (data.limit != null) params.limit = String(data.limit);
  if (data.search) params.search = data.search;
  if (data.sort) params.sort = data.sort;
  if (data.order) params.order = data.order;
  if (data.showTrashed || data.trashed) params.trashed = "true";
  return params;
}

export const getCustomers = createServerFn({ method: "GET" })
  .validator((data: CustomersQueryInput) => data)
  .handler(async ({ data }): Promise<CustomersListPayload> => {
    return apiGet<CustomersListPayload>("/customers", buildCustomersParams(data));
  });

export const getCustomer = createServerFn({ method: "GET" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<CustomerDto> => {
    return apiGet<CustomerDto>(`/customers/${data.id}`);
  });

export const getCustomerHistory = createServerFn({ method: "GET" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<CustomerHistoryPayload> => {
    return apiGet<CustomerHistoryPayload>(`/customers/${data.id}/history`);
  });

export const createCustomer = createServerFn({ method: "POST" })
  .validator((data: CreateCustomerInput) => data)
  .handler(async ({ data }): Promise<CreateCustomerPayload> => {
    return apiPost<CreateCustomerPayload>("/customers", data);
  });

export const updateCustomer = createServerFn({ method: "POST" })
  .validator((data: UpdateCustomerInput) => data)
  .handler(async ({ data }): Promise<Record<string, never>> => {
    const { id, ...body } = data;
    return apiPut<Record<string, never>>(`/customers/${id}`, body);
  });

export const deleteCustomer = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiDelete(`/customers/${data.id}`);
  });

export const permanentDeleteCustomer = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiDelete(`/customers/${data.id}/permanent`);
  });

export const restoreCustomer = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiPost<void>(`/customers/${data.id}/restore`);
  });

export const bulkDeleteCustomers = createServerFn({ method: "POST" })
  .validator((data: BulkDeleteCustomersInput) => data)
  .handler(async ({ data }): Promise<void> => {
    return apiPost<void>("/customers/bulk-delete", data);
  });
