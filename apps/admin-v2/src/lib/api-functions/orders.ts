import { createServerFn } from "@tanstack/react-start";
import type {
  DeleteApiV1AdminOrdersByIdShipmentsByShipmentIdResponse,
  GetApiV1AdminOrdersByIdCodResponse,
  GetApiV1AdminOrdersByIdFormDataResponse,
  GetApiV1AdminOrdersByIdItemsResponse,
  GetApiV1AdminOrdersByIdPaymentsResponse,
  GetApiV1AdminOrdersByIdResponse,
  GetApiV1AdminOrdersByIdShipmentsResponse,
  GetApiV1AdminOrdersData,
  GetApiV1AdminOrdersResponse,
  PostApiV1AdminOrdersBulkDeleteData,
  PostApiV1AdminOrdersByIdFulfillData,
  PostApiV1AdminOrdersByIdFulfillResponse,
  PostApiV1AdminOrdersByIdRefundData,
  PostApiV1AdminOrdersByIdRefundResponse,
  PostApiV1AdminOrdersByIdRestoreResponse,
  PostApiV1AdminOrdersByIdReturnData,
  PostApiV1AdminOrdersByIdReturnResponse,
  PostApiV1AdminOrdersByIdShipmentsData,
  PostApiV1AdminOrdersByIdShipmentsResponse,
  PostApiV1AdminOrdersByIdShipmentsByShipmentIdRefreshResponse,
  PostApiV1AdminOrdersData,
  PostApiV1AdminOrdersResponse,
  PutApiV1AdminOrdersByIdData,
  PutApiV1AdminOrdersByIdFulfillmentStatusData,
  PutApiV1AdminOrdersByIdFulfillmentStatusResponse,
  PutApiV1AdminOrdersByIdResponse,
  PutApiV1AdminOrdersByIdStatusData,
  PutApiV1AdminOrdersByIdStatusResponse,
  PostApiV1AdminOrdersByIdCodData,
  PostApiV1AdminOrdersByIdCodResponse,
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

type OrderListQuery = NonNullable<GetApiV1AdminOrdersData["query"]>;

export interface OrdersQueryInput extends Omit<OrderListQuery, "trashed"> {
  [key: string]: string | number | boolean | null | undefined;
  showTrashed?: boolean;
  trashed?: boolean;
  paymentStatus?: string;
  paymentMethod?: string;
  fulfillmentStatus?: string;
}

export type OrdersListPayload = ApiData<GetApiV1AdminOrdersResponse>;
export type OrderListItemDto = OrdersListPayload["orders"][number];
export type OrderDetailDto = ApiData<GetApiV1AdminOrdersByIdResponse>;
export type OrderFormDataPayload =
  ApiData<GetApiV1AdminOrdersByIdFormDataResponse>;
export type OrderItemDto = ApiData<GetApiV1AdminOrdersByIdItemsResponse>[number];
export type CreateOrderInput = ApiBody<PostApiV1AdminOrdersData>;
export type UpdateOrderInput = { id: string } &
  ApiBody<PutApiV1AdminOrdersByIdData>;
export type OrderIdPayload = ApiData<PostApiV1AdminOrdersResponse>;
export type MessagePayload =
  | ApiData<PutApiV1AdminOrdersByIdStatusResponse>
  | ApiData<PostApiV1AdminOrdersByIdCodResponse>
  | ApiData<PutApiV1AdminOrdersByIdFulfillmentStatusResponse>;
export type UpdateOrderStatusInput = { orderId: string; note?: string } &
  ApiBody<PutApiV1AdminOrdersByIdStatusData>;
export type ReturnOrderInput = { orderId: string } &
  ApiBody<PostApiV1AdminOrdersByIdReturnData>;
export type ReturnOrderPayload = ApiData<PostApiV1AdminOrdersByIdReturnResponse>;
export type RefundOrderInput = { orderId: string } &
  ApiBody<PostApiV1AdminOrdersByIdRefundData>;
export type RefundOrderPayload = ApiData<PostApiV1AdminOrdersByIdRefundResponse>;
export type BulkDeleteOrdersInput =
  ApiBody<PostApiV1AdminOrdersBulkDeleteData>;
export type OrderPaymentsPayload =
  ApiData<GetApiV1AdminOrdersByIdPaymentsResponse>;
export type OrderCodPayload = ApiData<GetApiV1AdminOrdersByIdCodResponse>;
export type UpdateOrderCodInput = { orderId: string } &
  ApiBody<PostApiV1AdminOrdersByIdCodData>;
export type OrderShipmentDto =
  ApiData<GetApiV1AdminOrdersByIdShipmentsResponse>[number];
export type CreateOrderShipmentBody =
  ApiBody<PostApiV1AdminOrdersByIdShipmentsData>;
export type CreateOrderShipmentInput =
  | {
      orderId: string;
      shipment: CreateOrderShipmentBody;
      providerId?: never;
      options?: never;
    }
  | {
      orderId: string;
      providerId: string;
      options?: CreateOrderShipmentBody["options"];
      shipment?: never;
    };
export type CreateOrderShipmentPayload =
  ApiData<PostApiV1AdminOrdersByIdShipmentsResponse>;
export type CreateFulfillmentShipmentInput = { orderId: string } &
  ApiBody<PostApiV1AdminOrdersByIdFulfillData>;
export type CreateFulfillmentShipmentPayload =
  ApiData<PostApiV1AdminOrdersByIdFulfillResponse>;
export type UpdateFulfillmentStatusInput = { orderId: string } &
  ApiBody<PutApiV1AdminOrdersByIdFulfillmentStatusData>;
export type RefreshShipmentStatusInput = {
  orderId: string;
  shipmentId: string;
};
export type RefreshedShipmentPayload =
  ApiData<PostApiV1AdminOrdersByIdShipmentsByShipmentIdRefreshResponse>;
export type DeleteShipmentInput = {
  orderId: string;
  shipmentId: string;
};
export type DeleteShipmentPayload =
  ApiData<DeleteApiV1AdminOrdersByIdShipmentsByShipmentIdResponse>;

function buildOrdersParams(data: OrdersQueryInput): Record<string, string> {
  const params: Record<string, string> = {};
  if (data.page != null) params.page = String(data.page);
  if (data.limit != null) params.limit = String(data.limit);
  if (data.search) params.search = data.search;
  if (data.status) params.status = data.status;
  if (data.sort) params.sort = data.sort;
  if (data.order) params.order = data.order;
  if (data.showTrashed || data.trashed) params.trashed = "true";
  if (data.startDate) params.startDate = data.startDate;
  if (data.endDate) params.endDate = data.endDate;
  return params;
}

function buildShipmentBody(
  data: CreateOrderShipmentInput,
): CreateOrderShipmentBody {
  if (data.shipment) return data.shipment;
  return {
    providerId: data.providerId,
    options: data.options,
  };
}

export const getOrders = createServerFn({ method: "GET" })
  .validator((data: OrdersQueryInput) => data)
  .handler(async ({ data }) => {
    return apiGet<OrdersListPayload>("/orders", buildOrdersParams(data));
  });

export const getOrder = createServerFn({ method: "GET" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<OrderDetailDto>(`/orders/${data.id}`);
  });

export const getOrderFormData = createServerFn({ method: "GET" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<OrderFormDataPayload>(`/orders/${data.id}/form-data`);
  });

export const getOrderItems = createServerFn({ method: "GET" })
  .validator((data: { orderId: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<OrderItemDto[]>(`/orders/${data.orderId}/items`);
  });

export const createOrder = createServerFn({ method: "POST" })
  .validator((data: CreateOrderInput) => data)
  .handler(async ({ data }) => {
    return apiPost<OrderIdPayload>("/orders", data);
  });

export const updateOrder = createServerFn({ method: "POST" })
  .validator((data: UpdateOrderInput) => data)
  .handler(async ({ data }) => {
    const { id, ...body } = data;
    return apiPut<ApiData<PutApiV1AdminOrdersByIdResponse>>(
      `/orders/${id}`,
      body,
    );
  });

export const updateOrderStatus = createServerFn({ method: "POST" })
  .validator((data: UpdateOrderStatusInput) => data)
  .handler(async ({ data }) => {
    return apiPut<MessagePayload>(`/orders/${data.orderId}/status`, {
      status: data.status,
    });
  });

export const returnOrder = createServerFn({ method: "POST" })
  .validator((data: ReturnOrderInput) => data)
  .handler(async ({ data }) => {
    return apiPost<ReturnOrderPayload>(`/orders/${data.orderId}/return`, {
      reason: data.reason,
      autoRefund: data.autoRefund,
    });
  });

export const restoreOrder = createServerFn({ method: "POST" })
  .validator((data: { id: string }) => data)
  .handler(async ({ data }) => {
    return apiPost<PostApiV1AdminOrdersByIdRestoreResponse>(
      `/orders/${data.id}/restore`,
    );
  });

export const bulkDeleteOrders = createServerFn({ method: "POST" })
  .validator((data: BulkDeleteOrdersInput) => data)
  .handler(async ({ data }) => {
    return apiPost<void>("/orders/bulk-delete", data);
  });

export const getOrderPayments = createServerFn({ method: "GET" })
  .validator((data: { orderId: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<OrderPaymentsPayload>(`/orders/${data.orderId}/payments`);
  });

export const getOrderCod = createServerFn({ method: "GET" })
  .validator((data: { orderId: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<OrderCodPayload>(`/orders/${data.orderId}/cod`);
  });

export const updateOrderCod = createServerFn({ method: "POST" })
  .validator((data: UpdateOrderCodInput) => data)
  .handler(async ({ data }) => {
    const { orderId, ...body } = data;
    return apiPost<MessagePayload>(`/orders/${orderId}/cod`, body);
  });

export const refundOrder = createServerFn({ method: "POST" })
  .validator((data: RefundOrderInput) => data)
  .handler(async ({ data }) => {
    return apiPost<RefundOrderPayload>(`/orders/${data.orderId}/refund`, {
      amount: data.amount,
      reason: data.reason,
      gateway: data.gateway,
    });
  });

export const getOrderShipments = createServerFn({ method: "GET" })
  .validator((data: { orderId: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<OrderShipmentDto[]>(`/orders/${data.orderId}/shipments`);
  });

export const createOrderShipment = createServerFn({ method: "POST" })
  .validator((data: CreateOrderShipmentInput) => data)
  .handler(async ({ data }) => {
    return apiPost<CreateOrderShipmentPayload>(
      `/orders/${data.orderId}/shipments`,
      buildShipmentBody(data),
    );
  });

export const createFulfillmentShipment = createServerFn({ method: "POST" })
  .validator((data: CreateFulfillmentShipmentInput) => data)
  .handler(async ({ data }) => {
    const { orderId, ...body } = data;
    return apiPost<CreateFulfillmentShipmentPayload>(
      `/orders/${orderId}/fulfill`,
      body,
    );
  });

export const updateFulfillmentStatus = createServerFn({ method: "POST" })
  .validator((data: UpdateFulfillmentStatusInput) => data)
  .handler(async ({ data }) => {
    return apiPut<MessagePayload>(`/orders/${data.orderId}/fulfillment-status`, {
      status: data.status,
    });
  });

export const refreshShipmentStatus = createServerFn({ method: "POST" })
  .validator((data: RefreshShipmentStatusInput) => data)
  .handler(async ({ data }) => {
    return apiPost<RefreshedShipmentPayload>(
      `/orders/${data.orderId}/shipments/${data.shipmentId}/refresh`,
      {},
    );
  });

export const deleteShipment = createServerFn({ method: "POST" })
  .validator((data: DeleteShipmentInput) => data)
  .handler(async ({ data }) => {
    return apiDelete<DeleteShipmentPayload>(
      `/orders/${data.orderId}/shipments/${data.shipmentId}`,
    );
  });
