import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  postApiV1AdminOrders,
  postApiV1AdminOrdersArchive,
  postApiV1AdminOrdersBulkShip,
  postApiV1AdminOrdersByIdAmendments,
  postApiV1AdminOrdersByIdCod,
  postApiV1AdminOrdersByIdFulfill,
  postApiV1AdminOrdersByIdNotificationsByOutboxIdResend,
  postApiV1AdminOrdersByIdNotificationsByOutboxIdRetry,
  postApiV1AdminOrdersByIdPaymentRecoveryLink,
  postApiV1AdminOrdersByIdRefund,
  postApiV1AdminOrdersByIdRefundAttemptsByAttemptIdReconcile,
  postApiV1AdminOrdersByIdRestore,
  postApiV1AdminOrdersByIdReturns,
  postApiV1AdminOrdersByIdReturnsByReturnIdApprove,
  postApiV1AdminOrdersByIdReturnsByReturnIdCancel,
  postApiV1AdminOrdersByIdReturnsByReturnIdReceive,
  postApiV1AdminOrdersByIdReturnsByReturnIdReconcile,
  postApiV1AdminOrdersByIdShipments,
  postApiV1AdminOrdersByIdShipmentsByShipmentIdReconcile,
  postApiV1AdminOrdersByIdShipmentsByShipmentIdResolveUnknown,
  postApiV1AdminOrdersByIdShipmentsByShipmentIdResolveUnknownLookup,
  putApiV1AdminOrdersById,
  putApiV1AdminOrdersByIdStatus,
  putApiV1AdminOrdersByIdSupportRequestsByRequestIdStatus,
} from "@scalius/api-client/sdk";
import { translate } from "~/i18n";
import { orderDetailMessages, type OrderDetailMessageKey } from "~/i18n/order-detail";
import { orderMessages, orderStatusLabel } from "~/i18n/orders";
import { apiData, type ApiBody, type ApiResult } from "../api";
import type {
  ApproveOrderReturnInput,
  CancelOrderReturnInput,
  CreateOrderReturnInput,
  ReceiveOrderReturnInput,
  ReconcileOrderReturnInput,
} from "../order-return-workflow";
import {
  getServerFnError,
  invalidateDashboardQueries,
  queryKeys,
} from "./shared";

type BulkShipOrdersPayload = ApiResult<typeof postApiV1AdminOrdersBulkShip>;
type OrderShipmentRef = { orderId: string; shipmentId: string };
export type UpdateOrderStatusInput = { orderId: string; note?: string } &
  ApiBody<typeof putApiV1AdminOrdersByIdStatus>;
export type ConfirmManualOrderAmendmentInput = { id: string } &
  ApiBody<typeof postApiV1AdminOrdersByIdAmendments>;
type ResolveUnknownShipmentBody =
  ApiBody<typeof postApiV1AdminOrdersByIdShipmentsByShipmentIdResolveUnknown>;
/** Flat dialog command; the outcome decides which contract branch it satisfies. */
export type ResolveUnknownShipmentInput = OrderShipmentRef &
  Omit<ResolveUnknownShipmentBody, "outcome"> & {
    outcome: ResolveUnknownShipmentBody["outcome"];
    externalId?: string;
    trackingId?: string;
  };

const msg = (key: OrderDetailMessageKey, vars?: Record<string, string | number>) =>
  translate(orderDetailMessages, key, vars);

const ORDER_CATALOG_PRODUCTS_QUERY_PREFIX = [
  "orders",
  "catalog-products",
] as const;

/**
 * Stock changes are visible in three admin projections: the inventory
 * workspace, product reads (including SKU variants), and the manual-order
 * catalog. Most lifecycle commands only carry an order id, so the affected
 * product ids are not available to narrow this further.
 */
function invalidateOrderInventoryQueries(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: queryKeys.inventory.list() });
  queryClient.invalidateQueries({ queryKey: queryKeys.products.all });
  queryClient.invalidateQueries({
    queryKey: ORDER_CATALOG_PRODUCTS_QUERY_PREFIX,
  });
}

function invalidateBulkShipOrderQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  orderIds: readonly string[],
) {
  queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
  invalidateDashboardQueries(queryClient);
  for (const orderId of orderIds) {
    queryClient.invalidateQueries({
      queryKey: queryKeys.orders.detail(orderId),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.orders.shipments(orderId),
    });
  }
}

function firstBulkShipFailureReason(result: BulkShipOrdersPayload) {
  const reason = result.results.find((item) => !item.success)?.error;
  if (!reason) return undefined;
  return reason.replace(/\s+/g, " ").slice(0, 180);
}

function toastBulkShipResult(result: BulkShipOrdersPayload) {
  if (result.successCount === result.totalProcessed) {
    toast.success(msg("toast.bulkShipped"), {
      description: msg("toast.bulkShippedDetail", { count: result.successCount }),
    });
    return;
  }

  const reason = firstBulkShipFailureReason(result);
  if (result.successCount > 0) {
    toast.warning(
      msg("toast.bulkShippedSome"),
      {
        description: msg(reason ? "toast.bulkShipFirstIssue" : "toast.bulkShipRemaining", {
          done: result.successCount,
          total: result.totalProcessed,
          count: result.failureCount,
          reason: reason ?? "",
        }),
      },
    );
    return;
  }

  toast.error(msg("toast.bulkShipFailed"), {
    description: reason ?? msg("toast.bulkShipNone"),
  });
}

export function useCreateOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ApiBody<typeof postApiV1AdminOrders>) =>
      apiData(postApiV1AdminOrders({ body })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      invalidateOrderInventoryQueries(queryClient);
      toast.success(msg("toast.orderCreated"));
    },
  });
}

export function useConfirmManualOrderAmendment() {
  const queryClient = useQueryClient();
  const router = useRouter();
  return useMutation({
    mutationFn: ({ id, ...body }: ConfirmManualOrderAmendmentInput) =>
      apiData(postApiV1AdminOrdersByIdAmendments({ path: { id }, body })),
    onSuccess: async (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(variables.id),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.formData(variables.id),
      });
      invalidateDashboardQueries(queryClient);
      invalidateOrderInventoryQueries(queryClient);
      await router.invalidate().catch(() => undefined);
      toast.success(msg("toast.orderUpdated"));
    },
    onError: (err) => {
      invalidateOrderInventoryQueries(queryClient);
      toast.error(getServerFnError(err, msg("toast.saveFailed")));
    },
  });
}

export function useUpdateOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & ApiBody<typeof putApiV1AdminOrdersById>) =>
      apiData(putApiV1AdminOrdersById({ path: { id }, body })),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(variables.id),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.formData(variables.id),
      });
      invalidateOrderInventoryQueries(queryClient);
      toast.success(msg("toast.orderUpdated"));
    },
    onError: (err) => {
      invalidateOrderInventoryQueries(queryClient);
      toast.error(getServerFnError(err, msg("toast.saveFailed")));
    },
  });
}

export function useUpdateOrderStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, status }: UpdateOrderStatusInput) =>
      apiData(putApiV1AdminOrdersByIdStatus({ path: { id: orderId }, body: { status } })),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(variables.orderId),
      });
      invalidateOrderInventoryQueries(queryClient);
      toast.success(msg("toast.statusUpdated"), {
        description: msg("toast.statusDetail", {
          status: orderStatusLabel((key, vars) => translate(orderMessages, key, vars), variables.status),
        }),
      });
    },
    onError: (err) =>
      toast.error(getServerFnError(err, msg("toast.statusFailed"))),
  });
}

export function useCreateOrderShipment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, ...body }: { orderId: string } &
      ApiBody<typeof postApiV1AdminOrdersByIdShipments>) =>
      apiData(postApiV1AdminOrdersByIdShipments({ path: { id: orderId }, body })),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(variables.orderId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.shipments(variables.orderId),
      });
      invalidateOrderInventoryQueries(queryClient);
      toast.success(msg("toast.courierBooked"));
    },
    onError: (err, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(variables.orderId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.shipments(variables.orderId),
      });
      invalidateOrderInventoryQueries(queryClient);
      toast.error(getServerFnError(err, msg("toast.bookFailed")));
    },
  });
}

export function useBulkShipOrders() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ApiBody<typeof postApiV1AdminOrdersBulkShip>) =>
      apiData(postApiV1AdminOrdersBulkShip({ body })),
    onSuccess: (result, variables) => {
      const touchedOrderIds = [
        ...new Set([
          ...variables.orderIds,
          ...result.results.map((item) => item.orderId),
        ]),
      ];
      invalidateBulkShipOrderQueries(queryClient, touchedOrderIds);
      invalidateOrderInventoryQueries(queryClient);
      toastBulkShipResult(result);
    },
    onError: (err, variables) => {
      invalidateBulkShipOrderQueries(queryClient, variables.orderIds);
      invalidateOrderInventoryQueries(queryClient);
      toast.error(getServerFnError(err, msg("toast.bulkShipError")));
    },
  });
}

export function useCreateFulfillmentShipment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, ...body }: { orderId: string } &
      ApiBody<typeof postApiV1AdminOrdersByIdFulfill>) =>
      apiData(postApiV1AdminOrdersByIdFulfill({ path: { id: orderId }, body })),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(variables.orderId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.shipments(variables.orderId),
      });
      invalidateOrderInventoryQueries(queryClient);
      toast.success(msg("toast.fulfilled"));
    },
    onError: (err) => {
      invalidateOrderInventoryQueries(queryClient);
      toast.error(getServerFnError(err, msg("toast.fulfillFailed")));
    },
  });
}

export function useRefundOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, ...body }: { orderId: string } &
      ApiBody<typeof postApiV1AdminOrdersByIdRefund>) =>
      apiData(postApiV1AdminOrdersByIdRefund({ path: { id: orderId }, body })),
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(variables.orderId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.payments(variables.orderId),
      });
      if (result.isFullRefund) {
        invalidateOrderInventoryQueries(queryClient);
      }
      toast.success(msg(result.manualSettlementRecorded ? "toast.cashRefundRecorded" : "toast.refunded"));
      if (result.sideEffectErrors > 0) toast.warning(msg("toast.refundFollowUp"), { description: msg("toast.refundFollowUpDetail") });
    },
    onError: (err) =>
      toast.error(getServerFnError(err, msg("toast.refundFailed"))),
  });
}

export function useIssueOrderPaymentRecoveryLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId }: { orderId: string }) =>
      apiData(postApiV1AdminOrdersByIdPaymentRecoveryLink({ path: { id: orderId } })),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(variables.orderId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.payments(variables.orderId),
      });
    },
    onError: (err) =>
      toast.error(getServerFnError(err, msg("toast.recoveryLinkFailed"))),
  });
}

export function useReconcileRefundAttempt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, attemptId }: { orderId: string; attemptId: string }) =>
      apiData(postApiV1AdminOrdersByIdRefundAttemptsByAttemptIdReconcile({
        path: { id: orderId, attemptId },
      })),
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(variables.orderId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.payments(variables.orderId),
      });
      if (result.status === "finalized") {
        invalidateOrderInventoryQueries(queryClient);
      }
      if (result.status === "finalized") toast.success(msg("toast.refundCheckDone"));
      else if (result.status === "failed") toast.warning(msg("toast.refundCheckFailed"));
      else toast.info(msg("toast.refundCheckPending"));
      if (result.sideEffectErrors > 0) toast.warning(msg("toast.refundFollowUp"), { description: msg("toast.refundFollowUpDetail") });
    },
    onError: (err) =>
      toast.error(getServerFnError(err, msg("toast.refundCheckError"))),
  });
}

export function useReconcileShipment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, shipmentId }: OrderShipmentRef) =>
      apiData(postApiV1AdminOrdersByIdShipmentsByShipmentIdReconcile({
        path: { id: orderId, shipmentId },
      })),
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(variables.orderId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.shipments(variables.orderId),
      });
      invalidateOrderInventoryQueries(queryClient);
      toast.success(msg("toast.shipmentRepaired"), {
        description: result.message,
      });
    },
    onError: (err) => {
      invalidateOrderInventoryQueries(queryClient);
      toast.error(getServerFnError(err, msg("toast.shipmentRepairFailed")));
    },
  });
}

export function useLookupUnknownShipment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, shipmentId, expectedOrderVersion, operationKey }: OrderShipmentRef &
      ApiBody<typeof postApiV1AdminOrdersByIdShipmentsByShipmentIdResolveUnknownLookup>) =>
      apiData(postApiV1AdminOrdersByIdShipmentsByShipmentIdResolveUnknownLookup({
        path: { id: orderId, shipmentId },
        body: { expectedOrderVersion, operationKey },
      })),
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.detail(variables.orderId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.shipments(variables.orderId) });
      invalidateOrderInventoryQueries(queryClient);
      toast.success(msg("toast.courierChecked"), { description: result.message });
    },
    onError: (err) =>
      toast.error(getServerFnError(err, msg("toast.courierCheckFailed"))),
  });
}

export function useResolveUnknownShipment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, shipmentId, ...body }: ResolveUnknownShipmentInput) =>
      apiData(postApiV1AdminOrdersByIdShipmentsByShipmentIdResolveUnknown({
        path: { id: orderId, shipmentId },
        body: body as ResolveUnknownShipmentBody,
      })),
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.detail(variables.orderId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.shipments(variables.orderId) });
      if (result.status === "repaired") invalidateOrderInventoryQueries(queryClient);
      toast.success(msg("toast.courierRecorded"), { description: result.message });
    },
    onError: (err) =>
      toast.error(getServerFnError(err, msg("toast.courierRecordFailed"))),
  });
}

export function useUpdateOrderCod() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, ...body }: { orderId: string } &
      ApiBody<typeof postApiV1AdminOrdersByIdCod>) =>
      apiData(postApiV1AdminOrdersByIdCod({ path: { id: orderId }, body })),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(variables.orderId),
      });
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.payments(variables.orderId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.cod(variables.orderId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.shipments(variables.orderId),
      });
      if (variables.action === "collected") {
        invalidateOrderInventoryQueries(queryClient);
      }
      toast.success(msg(
        variables.action === "collected" ? "toast.codCollected"
          : variables.action === "failed" ? "toast.codFailed" : "toast.codReturned",
      ));
    },
    onError: (err, variables) => {
      if (variables.action === "collected") {
        invalidateOrderInventoryQueries(queryClient);
      }
      toast.error(getServerFnError(err, msg("toast.saveFailedShort")));
    },
  });
}

export function useRetryOrderNotification() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, outboxId }: { orderId: string; outboxId: string }) =>
      apiData(postApiV1AdminOrdersByIdNotificationsByOutboxIdRetry({
        path: { id: orderId, outboxId },
      })),
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.notifications(variables.orderId),
      });
      if (result.enqueued) toast.success(msg("toast.messageQueued"));
      else toast.info(msg("toast.messageLater"));
    },
    onError: (err) =>
      toast.error(getServerFnError(err, msg("toast.messageFailed"))),
  });
}

export function useResendOrderNotification() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, outboxId, resendRequestId }: {
      orderId: string;
      outboxId: string;
      resendRequestId: string;
    }) =>
      apiData(postApiV1AdminOrdersByIdNotificationsByOutboxIdResend({
        path: { id: orderId, outboxId },
        body: { resendRequestId },
      })),
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.notifications(variables.orderId),
      });
      if (result.enqueued) toast.success(msg("toast.messageQueued"));
      else toast.info(msg("toast.messageLater"));
    },
    onError: (err) =>
      toast.error(getServerFnError(err, msg("toast.messageFailed"))),
  });
}

export function useResolveOrderSupportRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, requestId, status, note, returnRequest }: {
      orderId: string;
      requestId: string;
    } & ApiBody<typeof putApiV1AdminOrdersByIdSupportRequestsByRequestIdStatus>) =>
      apiData(putApiV1AdminOrdersByIdSupportRequestsByRequestIdStatus({
        path: { id: orderId, requestId },
        body: { status, note: note ?? null, returnRequest },
      })),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(variables.orderId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.returns(variables.orderId),
      });
      toast.success(msg("toast.requestUpdated"));
    },
    onError: (err, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(variables.orderId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.returns(variables.orderId),
      });
      toast.error(getServerFnError(err, msg("toast.requestFailed")));
    },
  });
}

function invalidateOrderReturnQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  orderId: string,
) {
  queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
  queryClient.invalidateQueries({ queryKey: queryKeys.orders.detail(orderId) });
  queryClient.invalidateQueries({ queryKey: queryKeys.orders.returns(orderId) });
  invalidateDashboardQueries(queryClient);
}

export function useCreateOrderReturn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, ...body }: CreateOrderReturnInput) =>
      apiData(postApiV1AdminOrdersByIdReturns({ path: { id: orderId }, body })),
    onSuccess: (_data, variables) => {
      invalidateOrderReturnQueries(queryClient, variables.orderId);
      toast.success(msg("toast.returnRequested"));
    },
    onError: (err, variables) => {
      invalidateOrderReturnQueries(queryClient, variables.orderId);
      toast.error(getServerFnError(err, msg("toast.returnFailed")));
    },
  });
}

export function useApproveOrderReturn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, returnId, ...body }: ApproveOrderReturnInput) =>
      apiData(postApiV1AdminOrdersByIdReturnsByReturnIdApprove({
        path: { id: orderId, returnId },
        body,
      })),
    onSuccess: (result, variables) => {
      invalidateOrderReturnQueries(queryClient, variables.orderId);
      toast.success(msg(result.status === "rejected" ? "toast.returnRejected" : "toast.returnApproved"));
    },
    onError: (err, variables) => {
      invalidateOrderReturnQueries(queryClient, variables.orderId);
      toast.error(getServerFnError(err, msg("toast.returnFailed")));
    },
  });
}

export function useReceiveOrderReturn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, returnId, ...body }: ReceiveOrderReturnInput) =>
      apiData(postApiV1AdminOrdersByIdReturnsByReturnIdReceive({
        path: { id: orderId, returnId },
        body,
      })),
    onSuccess: (result, variables) => {
      invalidateOrderReturnQueries(queryClient, variables.orderId);
      if (variables.lines.some((line) => line.restockQuantity > 0)) {
        invalidateOrderInventoryQueries(queryClient);
      }
      toast.success(msg(result.status === "completed" ? "toast.returnReceived" : "toast.receiptRecorded"));
    },
    onError: (err, variables) => {
      invalidateOrderReturnQueries(queryClient, variables.orderId);
      if (variables.lines.some((line) => line.restockQuantity > 0)) {
        invalidateOrderInventoryQueries(queryClient);
      }
      toast.error(getServerFnError(err, msg("toast.returnFailed")));
    },
  });
}

export function useCancelOrderReturn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, returnId, ...body }: CancelOrderReturnInput) =>
      apiData(postApiV1AdminOrdersByIdReturnsByReturnIdCancel({
        path: { id: orderId, returnId },
        body,
      })),
    onSuccess: (_result, variables) => {
      invalidateOrderReturnQueries(queryClient, variables.orderId);
      toast.success(msg("toast.returnCancelled"));
    },
    onError: (err, variables) => {
      invalidateOrderReturnQueries(queryClient, variables.orderId);
      toast.error(getServerFnError(err, msg("toast.returnFailed")));
    },
  });
}

export function useReconcileOrderReturn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, returnId }: ReconcileOrderReturnInput) =>
      apiData(postApiV1AdminOrdersByIdReturnsByReturnIdReconcile({
        path: { id: orderId, returnId },
      })),
    onSuccess: (_result, variables) => {
      invalidateOrderReturnQueries(queryClient, variables.orderId);
      invalidateOrderInventoryQueries(queryClient);
      toast.success(msg("toast.receiptRecorded"));
    },
    onError: (err, variables) => {
      invalidateOrderReturnQueries(queryClient, variables.orderId);
      invalidateOrderInventoryQueries(queryClient);
      toast.error(getServerFnError(err, msg("toast.returnFailed")));
    },
  });
}

export function useRestoreOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expectedVersion }: { id: string; expectedVersion: number }) =>
      apiData(postApiV1AdminOrdersByIdRestore({ path: { id }, body: { expectedVersion } })),
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.detail(input.id) });
      toast.success(msg("toast.orderRestored"));
    },
    onError: (err) =>
      toast.error(getServerFnError(err, msg("toast.restoreFailed"))),
  });
}

export function useArchiveOrders() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ApiBody<typeof postApiV1AdminOrdersArchive>) =>
      apiData(postApiV1AdminOrdersArchive({ body })),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      toast.success(msg("toast.archived"), {
        description: msg("toast.archivedDetail", { count: variables.orders.length }),
      });
    },
    onError: (err) =>
      toast.error(getServerFnError(err, msg("toast.archiveFailed"))),
  });
}
