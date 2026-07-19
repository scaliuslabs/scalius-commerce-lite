import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  approveOrderReturn,
  archiveOrders,
  bulkShipOrders,
  cancelOrderReturn,
  createFulfillmentShipment,
  createOrder,
  createOrderReturn,
  createOrderShipment,
  issueOrderPaymentRecoveryLink,
  reconcileRefundAttempt,
  receiveOrderReturn,
  refundOrder,
  reconcileShipment,
  resendOrderNotification,
  resolveOrderSupportRequest,
  retryOrderNotification,
  restoreOrder,
  reconcileOrderReturn,
  updateFulfillmentStatus,
  updateOrder,
  updateOrderCod,
  updateOrderStatus,
  type ArchiveOrdersInput,
  type BulkShipOrdersInput,
  type BulkShipOrdersPayload,
  type CreateFulfillmentShipmentInput,
  type CreateOrderInput,
  type CreateOrderShipmentInput,
  type IssueOrderPaymentRecoveryLinkInput,
  type RefundOrderInput,
  type ReconcileShipmentInput,
  type ReconcileRefundAttemptInput,
  type ResendOrderNotificationInput,
  type ResolveOrderSupportRequestInput,
  type UpdateFulfillmentStatusInput,
  type UpdateOrderCodInput,
  type UpdateOrderInput,
  type UpdateOrderStatusInput,
} from "../api-functions/orders";
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
    mutationFn: (data: CreateOrderInput) => createOrder({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      toast.success("Order created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create order")),
  });
}

export function useUpdateOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateOrderInput) => updateOrder({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(variables.id),
      });
      toast.success("Order updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update order")),
  });
}

export function useUpdateOrderStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateOrderStatusInput) => updateOrderStatus({ data }),
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(variables.orderId),
      });
      toast.success(`Order status updated to ${variables.status}`);
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update order status")),
  });
}

export function useCreateOrderShipment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateOrderShipmentInput) =>
      createOrderShipment({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(variables.orderId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.shipments(variables.orderId),
      });
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
      toast.error(getServerFnError(err, "Failed to create shipment"));
    },
  });
}

export function useBulkShipOrders() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: BulkShipOrdersInput) => bulkShipOrders({ data }),
    onSuccess: (result, variables) => {
      const touchedOrderIds = [
        ...new Set([
          ...variables.orderIds,
          ...result.results.map((item) => item.orderId),
        ]),
      ];
      invalidateBulkShipOrderQueries(queryClient, touchedOrderIds);
      toastBulkShipResult(result);
    },
    onError: (err, variables) => {
      invalidateBulkShipOrderQueries(queryClient, variables.orderIds);
      toast.error(getServerFnError(err, "Failed to create shipments"));
    },
  });
}

export function useCreateFulfillmentShipment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateFulfillmentShipmentInput) =>
      createFulfillmentShipment({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(variables.orderId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.shipments(variables.orderId),
      });
      toast.success("Fulfillment shipment created");
    },
    onError: (err) =>
      toast.error(
        getServerFnError(err, "Failed to create fulfillment shipment"),
      ),
  });
}

export function useUpdateFulfillmentStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateFulfillmentStatusInput) =>
      updateFulfillmentStatus({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(variables.orderId),
      });
      invalidateDashboardQueries(queryClient);
      toast.success("Fulfillment status updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update fulfillment status")),
  });
}

export function useRefundOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: RefundOrderInput) => refundOrder({ data }),
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(variables.orderId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.payments(variables.orderId),
      });
      toast.success("Refund processed");
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
    mutationFn: (data: IssueOrderPaymentRecoveryLinkInput) =>
      issueOrderPaymentRecoveryLink({ data }),
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
    mutationFn: (data: ReconcileRefundAttemptInput) =>
      reconcileRefundAttempt({ data }),
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
    mutationFn: (data: ReconcileShipmentInput) => reconcileShipment({ data }),
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(variables.orderId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.shipments(variables.orderId),
      });
      toast.success("Shipment recovery repaired", {
        description: result.message,
      });
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to repair shipment recovery")),
  });
}

export function useUpdateOrderCod() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateOrderCodInput) => updateOrderCod({ data }),
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
      toast.success("COD action recorded");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to record COD action")),
  });
}

export function useRetryOrderNotification() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { orderId: string; outboxId: string }) =>
      retryOrderNotification({ data }),
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
    mutationFn: (data: ResendOrderNotificationInput) =>
      resendOrderNotification({ data }),
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
    mutationFn: (data: ResolveOrderSupportRequestInput) =>
      resolveOrderSupportRequest({ data }),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(variables.orderId),
      });
      toast.success("Customer request updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update customer request")),
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
    mutationFn: (data: CreateOrderReturnInput) => createOrderReturn({ data }),
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
    mutationFn: (data: ApproveOrderReturnInput) => approveOrderReturn({ data }),
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
    mutationFn: (data: ReceiveOrderReturnInput) => receiveOrderReturn({ data }),
    onSuccess: (result, variables) => {
      invalidateOrderReturnQueries(queryClient, variables.orderId);
      toast.success(result.status === "completed" ? "Return received" : "Receipt recorded");
    },
    onError: (err, variables) => {
      invalidateOrderReturnQueries(queryClient, variables.orderId);
      toast.error(getServerFnError(err, "Failed to record receipt"));
    },
  });
}

export function useCancelOrderReturn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CancelOrderReturnInput) => cancelOrderReturn({ data }),
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
    mutationFn: (data: ReconcileOrderReturnInput) =>
      reconcileOrderReturn({ data }),
    onSuccess: (_result, variables) => {
      invalidateOrderReturnQueries(queryClient, variables.orderId);
      toast.success("Receipt recovery completed");
    },
    onError: (err, variables) => {
      invalidateOrderReturnQueries(queryClient, variables.orderId);
      toast.error(getServerFnError(err, "Failed to recover receipt"));
    },
  });
}

export function useRestoreOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; expectedVersion: number }) =>
      restoreOrder({ data: input }),
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
    mutationFn: (data: ArchiveOrdersInput) => archiveOrders({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      toast.success(`${variables.orders.length} order${variables.orders.length === 1 ? "" : "s"} archived`);
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to archive orders")),
  });
}
