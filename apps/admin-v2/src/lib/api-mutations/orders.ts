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
    toast.success(`${result.successCount} shipments created successfully.`);
    return;
  }

  const reason = firstBulkShipFailureReason(result);
  if (result.successCount > 0) {
    toast.warning(
      `${result.successCount} of ${result.totalProcessed} shipments created.`,
      {
        description: reason
          ? `${result.failureCount} failed. First issue: ${reason}`
          : `${result.failureCount} selected order(s) still need shipment.`,
      },
    );
    return;
  }

  toast.error("Shipment failed", {
    description: reason ?? "No selected orders could be shipped.",
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
      toast.success("Confirmed order created");
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
      toast.success("Order amendment confirmed");
    },
    onError: (err) => {
      invalidateOrderInventoryQueries(queryClient);
      toast.error(getServerFnError(err, "Failed to confirm amendment"));
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
      toast.success("Order updated");
    },
    onError: (err) => {
      invalidateOrderInventoryQueries(queryClient);
      toast.error(getServerFnError(err, "Failed to update order"));
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
      toast.success(`Order status updated to ${variables.status}`);
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update order status")),
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
      toast.success("Shipment created");
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
      toast.error(getServerFnError(err, "Failed to create shipment"));
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
      toast.error(getServerFnError(err, "Failed to create shipments"));
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
      toast.success("Fulfillment shipment created");
    },
    onError: (err) => {
      invalidateOrderInventoryQueries(queryClient);
      toast.error(
        getServerFnError(err, "Failed to create fulfillment shipment"),
      );
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
      toast.success(
        result.manualSettlementRecorded
          ? "Manual cash refund recorded"
          : "Refund processed",
      );
      if (result.sideEffectErrors > 0) {
        toast.warning("Refund saved; follow-up needs attention", {
          description: "The financial refund is complete, but cache refresh or customer notification should be checked.",
        });
      }
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to process refund")),
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
      toast.error(getServerFnError(err, "Failed to create recovery link")),
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
      if (result.status === "finalized") {
        toast.success("Refund recovery finalized");
      } else if (result.status === "failed") {
        toast.warning("Refund attempt marked failed");
      } else {
        toast.info("Refund recovery checked", {
          description: result.reason
            ? `Current state: ${result.reason.replace(/_/g, " ")}`
            : "The attempt is still waiting for a final outcome.",
        });
      }
      if (result.sideEffectErrors > 0) {
        toast.warning("Recovery side effects need another refresh", {
          description: "Order data was updated, but cache or notification follow-up needs another check.",
        });
      }
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to check refund recovery")),
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
      toast.success("Shipment recovery repaired", {
        description: result.message,
      });
    },
    onError: (err) => {
      invalidateOrderInventoryQueries(queryClient);
      toast.error(getServerFnError(err, "Failed to repair shipment recovery"));
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
      toast.success("Courier shipment confirmed", { description: result.message });
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Courier lookup did not resolve the shipment")),
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
      toast.success("Courier confirmation recorded", { description: result.message });
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to resolve unknown courier outcome")),
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
      toast.success("COD action recorded");
    },
    onError: (err, variables) => {
      if (variables.action === "collected") {
        invalidateOrderInventoryQueries(queryClient);
      }
      toast.error(getServerFnError(err, "Failed to record COD action"));
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
      if (result.enqueued) {
        toast.success("Notification retry queued");
        return;
      }
      toast.info("Notification retry scheduled", {
        description: result.skippedReason
          ? `Current state: ${result.skippedReason.replace(/_/g, " ")}`
          : undefined,
      });
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to retry notification")),
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
      if (result.enqueued) {
        toast.success("Notification resend queued");
        return;
      }
      toast.info("Notification resend scheduled", {
        description: result.skippedReason
          ? `Current state: ${result.skippedReason.replace(/_/g, " ")}`
          : undefined,
      });
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to send notification again")),
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
      toast.success("Customer request updated");
    },
    onError: (err, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(variables.orderId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.returns(variables.orderId),
      });
      toast.error(getServerFnError(err, "Failed to update customer request"));
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
      toast.success("Return requested");
    },
    onError: (err, variables) => {
      invalidateOrderReturnQueries(queryClient, variables.orderId);
      toast.error(getServerFnError(err, "Failed to request return"));
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
      toast.success(result.status === "rejected" ? "Return rejected" : "Return approved");
    },
    onError: (err, variables) => {
      invalidateOrderReturnQueries(queryClient, variables.orderId);
      toast.error(getServerFnError(err, "Failed to decide return"));
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
      toast.success(result.status === "completed" ? "Return received" : "Receipt recorded");
    },
    onError: (err, variables) => {
      invalidateOrderReturnQueries(queryClient, variables.orderId);
      if (variables.lines.some((line) => line.restockQuantity > 0)) {
        invalidateOrderInventoryQueries(queryClient);
      }
      toast.error(getServerFnError(err, "Failed to record receipt"));
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
      toast.success("Return cancelled");
    },
    onError: (err, variables) => {
      invalidateOrderReturnQueries(queryClient, variables.orderId);
      toast.error(getServerFnError(err, "Failed to cancel return"));
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
      toast.success("Receipt recovery completed");
    },
    onError: (err, variables) => {
      invalidateOrderReturnQueries(queryClient, variables.orderId);
      invalidateOrderInventoryQueries(queryClient);
      toast.error(getServerFnError(err, "Failed to recover receipt"));
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
      toast.success("Order restored");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore order")),
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
      toast.success(`${variables.orders.length} order${variables.orders.length === 1 ? "" : "s"} archived`);
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to archive orders")),
  });
}
