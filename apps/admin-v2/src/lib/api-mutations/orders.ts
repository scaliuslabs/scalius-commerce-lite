import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  bulkDeleteOrders,
  createFulfillmentShipment,
  createOrder,
  createOrderShipment,
  refundOrder,
  restoreOrder,
  returnOrder,
  updateFulfillmentStatus,
  updateOrder,
  updateOrderCod,
  updateOrderStatus,
  type BulkDeleteOrdersInput,
  type CreateFulfillmentShipmentInput,
  type CreateOrderInput,
  type CreateOrderShipmentInput,
  type RefundOrderInput,
  type ReturnOrderInput,
  type UpdateFulfillmentStatusInput,
  type UpdateOrderCodInput,
  type UpdateOrderInput,
  type UpdateOrderStatusInput,
} from "../api-functions/orders";
import {
  getServerFnError,
  invalidateDashboardQueries,
  queryKeys,
} from "./shared";

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
    onSuccess: (_data, variables) => {
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
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create shipment")),
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
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(variables.orderId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.payments(variables.orderId),
      });
      toast.success("Refund processed");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to process refund")),
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

export function useReturnOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: ReturnOrderInput) => returnOrder({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({
        queryKey: queryKeys.orders.detail(variables.orderId),
      });
      toast.success("Return processed");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to process return")),
  });
}

export function useRestoreOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => restoreOrder({ data: { id } }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.detail(id) });
      toast.success("Order restored");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to restore order")),
  });
}

export function useBulkDeleteOrders() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: BulkDeleteOrdersInput) => bulkDeleteOrders({ data }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() });
      invalidateDashboardQueries(queryClient);
      toast.success(
        variables.permanent
          ? `${variables.orderIds.length} orders permanently deleted`
          : `${variables.orderIds.length} orders moved to trash`,
      );
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete orders")),
  });
}
