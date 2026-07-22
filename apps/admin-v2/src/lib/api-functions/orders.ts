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
  PostApiV1AdminOrdersArchiveData,
  PostApiV1AdminOrdersByIdFulfillData,
  PostApiV1AdminOrdersByIdFulfillResponse,
  PostApiV1AdminOrdersByIdRefundData,
  PostApiV1AdminOrdersByIdRefundResponse,
  PostApiV1AdminOrdersByIdRestoreResponse,
  PostApiV1AdminOrdersByIdRestoreData,
  PostApiV1AdminOrdersByIdShipmentsData,
  PostApiV1AdminOrdersByIdShipmentsResponse,
  PostApiV1AdminOrdersByIdShipmentsByShipmentIdReconcileResponse,
  PostApiV1AdminOrdersByIdShipmentsByShipmentIdRefreshResponse,
  PostApiV1AdminOrdersData,
  PostApiV1AdminOrdersResponse,
  PostApiV1AdminOrdersQuoteData,
  PostApiV1AdminOrdersQuoteResponse,
  PutApiV1AdminOrdersByIdData,
  PutApiV1AdminOrdersByIdResponse,
  PutApiV1AdminOrdersByIdSupportRequestsByRequestIdStatusData,
  PutApiV1AdminOrdersByIdSupportRequestsByRequestIdStatusResponse,
  PutApiV1AdminOrdersByIdStatusData,
  PutApiV1AdminOrdersByIdStatusResponse,
  PostApiV1AdminOrdersByIdCodData,
  PostApiV1AdminOrdersByIdCodResponse,
  PostApiV1AdminOrdersByIdNotificationsByOutboxIdResendData,
  PostApiV1AdminOrdersByIdNotificationsByOutboxIdResendResponse,
  PostApiV1AdminOrdersByIdPaymentRecoveryLinkResponse,
  PostApiV1AdminOrdersByIdRefundAttemptsByAttemptIdReconcileResponse,
  PostApiV1AdminOrdersBulkShipData,
  PostApiV1AdminOrdersBulkShipResponse,
} from "@scalius/api-client/types";
import { apiDelete, apiGet, apiPost, apiPut } from "../api.server";
import type {
  PaginationPayload,
  ProductListItemDto,
} from "./products";
import type {
  ApproveOrderReturnInput,
  CancelOrderReturnInput,
  CreateOrderReturnInput,
  OrderReturnCommandResult,
  OrderReturnsPayload,
  ReceiveOrderReturnInput,
  ReconcileOrderReturnInput,
} from "../order-return-workflow";

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

export interface OrdersQueryInput extends Omit<OrderListQuery, "archived"> {
  [key: string]: string | number | boolean | null | undefined;
  showArchived?: boolean;
  statusGroup?: "open" | "in_transit" | "delivered" | "closed";
  paymentRecovery?:
    | "recoverable"
    | "awaiting_payment"
    | "processing"
    | "needs_attention";
}

export type OrdersListPayload = ApiData<GetApiV1AdminOrdersResponse>;
export type OrderListItemDto = OrdersListPayload["orders"][number];
export type OrderDetailDto = ApiData<GetApiV1AdminOrdersByIdResponse>;
export type OrderFormDataPayload =
  ApiData<GetApiV1AdminOrdersByIdFormDataResponse>;
export interface OrderCatalogProductsInput {
  page?: number;
  limit?: number;
  search?: string;
}
export interface OrderCatalogProductsPayload {
  products: ProductListItemDto[];
  pagination: PaginationPayload;
}
export type OrderItemDto = ApiData<GetApiV1AdminOrdersByIdItemsResponse>[number];
export type CreateOrderInput = ApiBody<PostApiV1AdminOrdersData>;
export type QuoteManualOrderInput = ApiBody<PostApiV1AdminOrdersQuoteData>;
export type ManualOrderQuotePayload = ApiData<PostApiV1AdminOrdersQuoteResponse>;
export type UpdateOrderInput = { id: string } &
  ApiBody<PutApiV1AdminOrdersByIdData>;
export type OrderIdPayload = ApiData<PostApiV1AdminOrdersResponse>;
export type MessagePayload =
  | ApiData<PutApiV1AdminOrdersByIdStatusResponse>
  | ApiData<PostApiV1AdminOrdersByIdCodResponse>;
export type UpdateOrderStatusInput = { orderId: string; note?: string } &
  ApiBody<PutApiV1AdminOrdersByIdStatusData>;
export type RefundOrderInput = { orderId: string } &
  ApiBody<PostApiV1AdminOrdersByIdRefundData>;
export type RefundOrderPayload = ApiData<PostApiV1AdminOrdersByIdRefundResponse>;
export interface ReconcileRefundAttemptInput {
  orderId: string;
  attemptId: string;
}
export type ReconcileRefundAttemptPayload =
  ApiData<PostApiV1AdminOrdersByIdRefundAttemptsByAttemptIdReconcileResponse>;
export interface IssueOrderPaymentRecoveryLinkInput {
  orderId: string;
}
export type IssueOrderPaymentRecoveryLinkPayload =
  ApiData<PostApiV1AdminOrdersByIdPaymentRecoveryLinkResponse>;
export type ArchiveOrdersInput = ApiBody<PostApiV1AdminOrdersArchiveData>;
export type BulkShipOrdersInput = ApiBody<PostApiV1AdminOrdersBulkShipData>;
export type BulkShipOrdersPayload =
  ApiData<PostApiV1AdminOrdersBulkShipResponse>;
export type OrderPaymentsPayload =
  ApiData<GetApiV1AdminOrdersByIdPaymentsResponse>;
export interface OrderNotificationReceiptDto {
  id: string;
  receiptKey: string;
  channel: string;
  provider: string;
  recipientMasked: string | null;
  status: string;
  providerMessageId: string | null;
  providerStatus: string | null;
  attempts: number;
  nextAttemptAt: string | number | null;
  lastAttemptAt: string | number | null;
  lastError: string | null;
  acceptedAt: string | number | null;
  deliveredAt: string | number | null;
  failedAt: string | number | null;
  skippedAt: string | number | null;
  createdAt: string | number;
  updatedAt: string | number;
}
export interface OrderNotificationOutboxDto {
  id: string;
  dedupeKey: string;
  orderId: string;
  notificationType: string;
  source: string;
  status: string;
  attempts: number;
  nextAttemptAt: string | number;
  lastError: string | null;
  queuedAt: string | number | null;
  sentAt: string | number | null;
  createdAt: string | number;
  updatedAt: string | number;
  receipts: OrderNotificationReceiptDto[];
}
export interface OrderNotificationsPayload {
  notifications: OrderNotificationOutboxDto[];
}
export interface RetryOrderNotificationPayload {
  outboxId: string;
  dedupeKey: string;
  created: boolean;
  enqueued: boolean;
  skippedReason?: string;
}
export interface ResendOrderNotificationInput {
  orderId: string;
  outboxId: string;
  resendRequestId: ApiBody<PostApiV1AdminOrdersByIdNotificationsByOutboxIdResendData>["resendRequestId"];
}
export type ResendOrderNotificationPayload =
  ApiData<PostApiV1AdminOrdersByIdNotificationsByOutboxIdResendResponse>;
export type ResolveOrderSupportRequestStatus =
  ApiBody<PutApiV1AdminOrdersByIdSupportRequestsByRequestIdStatusData>["status"];
type ResolveOrderSupportRequestBody =
  ApiBody<PutApiV1AdminOrdersByIdSupportRequestsByRequestIdStatusData>;
export interface ResolveOrderSupportRequestInput {
  orderId: string;
  requestId: string;
  status: ResolveOrderSupportRequestStatus;
  note?: string | null;
  returnRequest?: ResolveOrderSupportRequestBody["returnRequest"];
}
export type ResolveOrderSupportRequestPayload =
  ApiData<PutApiV1AdminOrdersByIdSupportRequestsByRequestIdStatusResponse>;
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
export type RefreshShipmentStatusInput = {
  orderId: string;
  shipmentId: string;
};
export type RefreshedShipmentPayload =
  ApiData<PostApiV1AdminOrdersByIdShipmentsByShipmentIdRefreshResponse>;
export type ReconcileShipmentPayload =
  ApiData<PostApiV1AdminOrdersByIdShipmentsByShipmentIdReconcileResponse>;
export type DeleteShipmentInput = {
  orderId: string;
  shipmentId: string;
};
export type DeleteShipmentPayload =
  ApiData<DeleteApiV1AdminOrdersByIdShipmentsByShipmentIdResponse>;
export type ReconcileShipmentInput = {
  orderId: string;
  shipmentId: string;
};

function buildOrdersParams(data: OrdersQueryInput): Record<string, string> {
  const params: Record<string, string> = {};
  if (data.page != null) params.page = String(data.page);
  if (data.limit != null) params.limit = String(data.limit);
  if (data.search) params.search = data.search;
  if (data.status) params.status = data.status;
  if (data.statusGroup) params.statusGroup = data.statusGroup;
  if (data.paymentStatus) params.paymentStatus = data.paymentStatus;
  if (data.paymentMethod) params.paymentMethod = data.paymentMethod;
  if (data.fulfillmentStatus) params.fulfillmentStatus = data.fulfillmentStatus;
  if (data.paymentRecovery) params.paymentRecovery = data.paymentRecovery;
  if (data.sort) params.sort = data.sort;
  if (data.order) params.order = data.order;
  if (data.showArchived) params.archived = "true";
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

export const getOrderCatalogProducts = createServerFn({ method: "GET" })
  .validator((data: OrderCatalogProductsInput) => data)
  .handler(async ({ data }) => {
    const params: Record<string, string> = {};
    if (data.page != null) params.page = String(data.page);
    if (data.limit != null) params.limit = String(data.limit);
    if (data.search) params.search = data.search;
    return apiGet<OrderCatalogProductsPayload>("/orders/catalog-products", params);
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

export const quoteManualOrder = createServerFn({ method: "POST" })
  .validator((data: QuoteManualOrderInput) => data)
  .handler(async ({ data }) => {
    return apiPost<ManualOrderQuotePayload>("/orders/quote", data);
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

export const getOrderReturns = createServerFn({ method: "GET" })
  .validator((data: { orderId: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<OrderReturnsPayload>(`/orders/${data.orderId}/returns`);
  });

export const createOrderReturn = createServerFn({ method: "POST" })
  .validator((data: CreateOrderReturnInput) => data)
  .handler(async ({ data }) => {
    const { orderId, ...body } = data;
    return apiPost<OrderReturnCommandResult>(`/orders/${orderId}/returns`, body);
  });

export const approveOrderReturn = createServerFn({ method: "POST" })
  .validator((data: ApproveOrderReturnInput) => data)
  .handler(async ({ data }) => {
    const { orderId, returnId, ...body } = data;
    return apiPost<OrderReturnCommandResult>(
      `/orders/${orderId}/returns/${returnId}/approve`,
      body,
    );
  });

export const receiveOrderReturn = createServerFn({ method: "POST" })
  .validator((data: ReceiveOrderReturnInput) => data)
  .handler(async ({ data }) => {
    const { orderId, returnId, ...body } = data;
    return apiPost<OrderReturnCommandResult>(
      `/orders/${orderId}/returns/${returnId}/receive`,
      body,
    );
  });

export const cancelOrderReturn = createServerFn({ method: "POST" })
  .validator((data: CancelOrderReturnInput) => data)
  .handler(async ({ data }) => {
    const { orderId, returnId, ...body } = data;
    return apiPost<OrderReturnCommandResult>(
      `/orders/${orderId}/returns/${returnId}/cancel`,
      body,
    );
  });

export const reconcileOrderReturn = createServerFn({ method: "POST" })
  .validator((data: ReconcileOrderReturnInput) => data)
  .handler(async ({ data }) => {
    return apiPost<OrderReturnCommandResult>(
      `/orders/${data.orderId}/returns/${data.returnId}/reconcile`,
    );
  });

export const restoreOrder = createServerFn({ method: "POST" })
  .validator((data: { id: string } & ApiBody<PostApiV1AdminOrdersByIdRestoreData>) => data)
  .handler(async ({ data }) => {
    return apiPost<PostApiV1AdminOrdersByIdRestoreResponse>(
      `/orders/${data.id}/restore`,
      { expectedVersion: data.expectedVersion },
    );
  });

export const archiveOrders = createServerFn({ method: "POST" })
  .validator((data: ArchiveOrdersInput) => data)
  .handler(async ({ data }) => {
    return apiPost<void>("/orders/archive", data);
  });

export const bulkShipOrders = createServerFn({ method: "POST" })
  .validator((data: BulkShipOrdersInput) => data)
  .handler(async ({ data }) => {
    return apiPost<BulkShipOrdersPayload>("/orders/bulk-ship", data);
  });

export const getOrderPayments = createServerFn({ method: "GET" })
  .validator((data: { orderId: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<OrderPaymentsPayload>(`/orders/${data.orderId}/payments`);
  });

export const issueOrderPaymentRecoveryLink = createServerFn({ method: "POST" })
  .validator((data: IssueOrderPaymentRecoveryLinkInput) => data)
  .handler(async ({ data }) => {
    return apiPost<IssueOrderPaymentRecoveryLinkPayload>(
      `/orders/${data.orderId}/payment-recovery-link`,
    );
  });

export const getOrderNotifications = createServerFn({ method: "GET" })
  .validator((data: { orderId: string }) => data)
  .handler(async ({ data }) => {
    return apiGet<OrderNotificationsPayload>(`/orders/${data.orderId}/notifications`);
  });

export const retryOrderNotification = createServerFn({ method: "POST" })
  .validator((data: { orderId: string; outboxId: string }) => data)
  .handler(async ({ data }) => {
    return apiPost<RetryOrderNotificationPayload>(
      `/orders/${data.orderId}/notifications/${data.outboxId}/retry`,
    );
  });

export const resendOrderNotification = createServerFn({ method: "POST" })
  .validator((data: ResendOrderNotificationInput) => data)
  .handler(async ({ data }) => {
    return apiPost<ResendOrderNotificationPayload>(
      `/orders/${data.orderId}/notifications/${data.outboxId}/resend`,
      { resendRequestId: data.resendRequestId },
    );
  });

export const resolveOrderSupportRequest = createServerFn({ method: "POST" })
  .validator((data: ResolveOrderSupportRequestInput) => data)
  .handler(async ({ data }) => {
    return apiPut<ResolveOrderSupportRequestPayload>(
      `/orders/${data.orderId}/support-requests/${data.requestId}/status`,
      {
        status: data.status,
        note: data.note ?? null,
        returnRequest: data.returnRequest,
      },
    );
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

export const reconcileRefundAttempt = createServerFn({ method: "POST" })
  .validator((data: ReconcileRefundAttemptInput) => data)
  .handler(async ({ data }) => {
    return apiPost<ReconcileRefundAttemptPayload>(
      `/orders/${data.orderId}/refund-attempts/${data.attemptId}/reconcile`,
    );
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

export const refreshShipmentStatus = createServerFn({ method: "POST" })
  .validator((data: RefreshShipmentStatusInput) => data)
  .handler(async ({ data }) => {
    return apiPost<RefreshedShipmentPayload>(
      `/orders/${data.orderId}/shipments/${data.shipmentId}/refresh`,
      {},
    );
  });

export const reconcileShipment = createServerFn({ method: "POST" })
  .validator((data: ReconcileShipmentInput) => data)
  .handler(async ({ data }) => {
    return apiPost<ReconcileShipmentPayload>(
      `/orders/${data.orderId}/shipments/${data.shipmentId}/reconcile`,
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
