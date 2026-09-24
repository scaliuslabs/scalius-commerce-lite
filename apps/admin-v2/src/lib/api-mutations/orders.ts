import { useCallback, useRef } from "react";
import {
  useMutation,
  useQueryClient,
  type QueryClient,
  type UseMutationOptions,
} from "@tanstack/react-query";
import { toast } from "sonner";
import {
  deleteApiV1AdminOrdersByIdTimelineByEventId,
  postApiV1AdminOrders,
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
  postApiV1AdminOrdersByIdTimeline,
  putApiV1AdminOrdersByIdDetails,
  putApiV1AdminOrdersByIdStatus,
  putApiV1AdminOrdersByIdSupportRequestsByRequestIdStatus,
} from "@scalius/api-client/sdk";
import { translate } from "~/i18n";
import { orderDetailMessages, type OrderDetailMessageKey } from "~/i18n/order-detail";
import { apiData, type ApiBody } from "../api";
import { showOrderNotice } from "../order-notice";
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

type OrderShipmentRef = { orderId: string; shipmentId: string };
export type UpdateOrderStatusInput = { orderId: string } &
  ApiBody<typeof putApiV1AdminOrdersByIdStatus>;
export type UpdateOrderDetailsInput = { orderId: string } &
  ApiBody<typeof putApiV1AdminOrdersByIdDetails>;
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

/** Toast per status the merchant can pick: noun + past verb (ORD-35). */
const STATUS_TOASTS: Partial<Record<string, OrderDetailMessageKey>> = {
  processing: "toast.status.processing",
  confirmed: "toast.status.confirmed",
  shipped: "toast.status.shipped",
  delivered: "toast.status.delivered",
  completed: "toast.status.completed",
  cancelled: "toast.status.cancelled",
  pending: "toast.status.pending",
};

/**
 * Stock changes are visible in three admin projections: the inventory
 * workspace, product reads (including SKU variants), and the manual-order
 * catalog. Most lifecycle commands only carry an order id, so the affected
 * product ids are not available to narrow this further.
 */
function invalidateOrderInventoryQueries(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: queryKeys.inventory.list() });
  queryClient.invalidateQueries({ queryKey: queryKeys.products.all });
  queryClient.invalidateQueries({ queryKey: ["orders", "catalog-products"] });
}

/**
 * Everything the order page reads about one order (detail, shipments,
 * payments, cash collection, returns, messages, timeline), plus the lists and
 * dashboard that summarise it. One action can move several cards at once,
 * e.g. "Mark returned" changes the status, the balance and the Returns card.
 */
export function invalidateOrder(queryClient: QueryClient, orderId: string): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({
      predicate: (query) => query.queryKey[0] === "orders" && query.queryKey[2] === orderId,
    }),
    queryClient.invalidateQueries({ queryKey: queryKeys.orders.list() }),
    invalidateDashboardQueries(queryClient),
  ]);
}

function errorStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

function cachedOrderVersion(queryClient: QueryClient, orderId: string): number | undefined {
  return queryClient.getQueryData<{ version?: number }>(queryKeys.orders.detail(orderId))?.version;
}

/**
 * A refused order action (400 or 409) usually means this tab is stale: the
 * order moved on elsewhere. Reload every card of the order, and when it did
 * change, say so in the page banner instead of leaving old actions on screen.
 * Actions without their own dialog also show the reason in the banner;
 * dialogs show `mutation.error` inline instead.
 */
async function onOrderError(
  queryClient: QueryClient,
  orderId: string,
  error: unknown,
  { banner, refresh = false }: { banner: boolean; refresh?: boolean },
): Promise<void> {
  if (banner) showOrderNotice(orderId, orderErrorMessage(error));
  const status = errorStatus(error);
  const refused = status === 400 || status === 409;
  if (!refused && !refresh) return;
  const before = cachedOrderVersion(queryClient, orderId);
  await invalidateOrder(queryClient, orderId);
  const after = cachedOrderVersion(queryClient, orderId);
  if (status === 409 || (refused && before !== undefined && after !== undefined && after !== before)) {
    showOrderNotice(orderId, msg("error.orderChanged"));
  }
}

/** Plain words for a failed order action; transport and server faults read "Couldn't reach the server". */
export function orderErrorMessage(error: unknown): string {
  const status = errorStatus(error);
  if (status !== null && status < 500) return getServerFnError(error, msg("error.network"));
  return msg("error.network");
}

/**
 * A mutation that runs once at a time: a second click (or Enter) that lands
 * before React re-renders the disabled button is dropped here. The server
 * still replays a repeated request key, so this only saves the extra trip.
 */
function useSingleFlightMutation<TData, TVariables>(
  options: UseMutationOptions<TData, Error, TVariables>,
) {
  const busy = useRef(false);
  const mutation = useMutation<TData, Error, TVariables>({
    ...options,
    onSettled: (...args) => {
      busy.current = false;
      return options.onSettled?.(...args);
    },
  });
  const { mutate: run } = mutation;
  const mutate = useCallback<typeof run>((variables, callbacks) => {
    if (busy.current) return;
    busy.current = true;
    run(variables, callbacks);
  }, [run]);
  return { ...mutation, mutate };
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

/** The edit page shows a failure inside its review dialog (`mutation.error`). */
export function useConfirmManualOrderAmendment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: ConfirmManualOrderAmendmentInput) =>
      apiData(postApiV1AdminOrdersByIdAmendments({ path: { id }, body })),
    onSuccess: (_result, variables) => {
      invalidateOrder(queryClient, variables.id);
      invalidateOrderInventoryQueries(queryClient);
      toast.success(msg("toast.orderUpdated"));
    },
    onError: () => invalidateOrderInventoryQueries(queryClient),
  });
}

/** Customer and delivery details of an order that hasn't shipped. */
export function useUpdateOrderDetails() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, ...body }: UpdateOrderDetailsInput) =>
      apiData(putApiV1AdminOrdersByIdDetails({ path: { id: orderId }, body })),
    onSuccess: (_result, variables) => {
      invalidateOrder(queryClient, variables.orderId);
      toast.success(msg("toast.detailsSaved"));
    },
    onError: (err, variables) => void onOrderError(queryClient, variables.orderId, err, { banner: false }),
  });
}

/** A staff comment; one request key per draft, so a repeated Post adds it once. */
export function useAddOrderComment() {
  const queryClient = useQueryClient();
  return useSingleFlightMutation({
    mutationFn: ({ orderId, ...body }: { orderId: string } & ApiBody<typeof postApiV1AdminOrdersByIdTimeline>) =>
      apiData(postApiV1AdminOrdersByIdTimeline({ path: { id: orderId }, body })),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: ["orders", "timeline", variables.orderId] });
    },
  });
}

/** Deletes the viewer's own comment. */
export function useDeleteOrderComment() {
  const queryClient = useQueryClient();
  return useSingleFlightMutation({
    mutationFn: ({ orderId, eventId }: { orderId: string; eventId: string }) =>
      apiData(deleteApiV1AdminOrdersByIdTimelineByEventId({ path: { id: orderId, eventId } })),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: ["orders", "timeline", variables.orderId] });
      toast.success(msg("toast.commentDeleted"));
    },
    onError: (err, variables) => void onOrderError(queryClient, variables.orderId, err, { banner: true }),
  });
}

export function useUpdateOrderStatus() {
  const queryClient = useQueryClient();
  return useSingleFlightMutation({
    mutationFn: ({ orderId, ...body }: UpdateOrderStatusInput) =>
      apiData(putApiV1AdminOrdersByIdStatus({ path: { id: orderId }, body })),
    onSuccess: (_result, variables) => {
      invalidateOrder(queryClient, variables.orderId);
      invalidateOrderInventoryQueries(queryClient);
      toast.success(msg(STATUS_TOASTS[variables.status] ?? "toast.orderUpdated"));
    },
    onError: (err, variables) => void onOrderError(queryClient, variables.orderId, err, { banner: true }),
  });
}

/** Courier booking; the Delivery card shows a failure next to the Book button. */
export function useCreateOrderShipment() {
  const queryClient = useQueryClient();
  return useSingleFlightMutation({
    mutationFn: ({ orderId, ...body }: { orderId: string } &
      ApiBody<typeof postApiV1AdminOrdersByIdShipments>) =>
      apiData(postApiV1AdminOrdersByIdShipments({ path: { id: orderId }, body })),
    onSuccess: (_data, variables) => {
      invalidateOrder(queryClient, variables.orderId);
      invalidateOrderInventoryQueries(queryClient);
      toast.success(msg("toast.courierBooked"));
    },
    onError: (err, variables) => {
      // The booking may have reached the courier: always reload the truth.
      void onOrderError(queryClient, variables.orderId, err, { banner: false, refresh: true });
      invalidateOrderInventoryQueries(queryClient);
    },
  });
}

/** Own-courier "Mark as sent"; the dialog shows a failure inline. */
export function useCreateFulfillmentShipment() {
  const queryClient = useQueryClient();
  return useSingleFlightMutation({
    mutationFn: ({ orderId, ...body }: { orderId: string } &
      ApiBody<typeof postApiV1AdminOrdersByIdFulfill>) =>
      apiData(postApiV1AdminOrdersByIdFulfill({ path: { id: orderId }, body })),
    onSuccess: (_data, variables) => {
      invalidateOrder(queryClient, variables.orderId);
      invalidateOrderInventoryQueries(queryClient);
      toast.success(msg("toast.fulfilled"));
    },
    onError: (err, variables) => {
      void onOrderError(queryClient, variables.orderId, err, { banner: false });
      invalidateOrderInventoryQueries(queryClient);
    },
  });
}

/** Refund dialog; a failure stays inside the dialog. */
export function useRefundOrder() {
  const queryClient = useQueryClient();
  return useSingleFlightMutation({
    mutationFn: ({ orderId, ...body }: { orderId: string } &
      ApiBody<typeof postApiV1AdminOrdersByIdRefund>) =>
      apiData(postApiV1AdminOrdersByIdRefund({ path: { id: orderId }, body })),
    onSuccess: (result, variables) => {
      invalidateOrder(queryClient, variables.orderId);
      if (result.isFullRefund) invalidateOrderInventoryQueries(queryClient);
      toast.success(msg(result.manualSettlementRecorded ? "toast.cashRefundRecorded" : "toast.refunded"));
      if (result.sideEffectErrors > 0) {
        toast.warning(msg("toast.refundFollowUp"), { description: msg("toast.refundFollowUpDetail") });
      }
    },
    onError: (err, variables) => void onOrderError(queryClient, variables.orderId, err, { banner: false }),
  });
}

export function useIssueOrderPaymentRecoveryLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId }: { orderId: string }) =>
      apiData(postApiV1AdminOrdersByIdPaymentRecoveryLink({ path: { id: orderId } })),
    onSuccess: (_result, variables) => invalidateOrder(queryClient, variables.orderId),
    onError: (err, variables) => void onOrderError(queryClient, variables.orderId, err, { banner: true }),
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
      invalidateOrder(queryClient, variables.orderId);
      if (result.status === "finalized") {
        invalidateOrderInventoryQueries(queryClient);
        toast.success(msg("toast.refundCheckDone"));
      } else if (result.status === "failed") {
        toast.warning(msg("toast.refundCheckFailed"));
      } else {
        toast.info(msg("toast.refundCheckPending"));
      }
      if (result.sideEffectErrors > 0) {
        toast.warning(msg("toast.refundFollowUp"), { description: msg("toast.refundFollowUpDetail") });
      }
    },
    onError: (err, variables) => void onOrderError(queryClient, variables.orderId, err, { banner: true }),
  });
}

export function useReconcileShipment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, shipmentId }: OrderShipmentRef) =>
      apiData(postApiV1AdminOrdersByIdShipmentsByShipmentIdReconcile({
        path: { id: orderId, shipmentId },
      })),
    onSuccess: (_result, variables) => {
      invalidateOrder(queryClient, variables.orderId);
      invalidateOrderInventoryQueries(queryClient);
      toast.success(msg("toast.shipmentRepaired"));
    },
    onError: (err, variables) => {
      void onOrderError(queryClient, variables.orderId, err, { banner: true });
      invalidateOrderInventoryQueries(queryClient);
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
    onSuccess: (_result, variables) => {
      invalidateOrder(queryClient, variables.orderId);
      invalidateOrderInventoryQueries(queryClient);
      toast.success(msg("toast.courierChecked"));
    },
    onError: (err, variables) => void onOrderError(queryClient, variables.orderId, err, { banner: true }),
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
      invalidateOrder(queryClient, variables.orderId);
      if (result.status === "repaired") invalidateOrderInventoryQueries(queryClient);
      toast.success(msg("toast.courierRecorded"));
    },
    onError: (err, variables) => void onOrderError(queryClient, variables.orderId, err, { banner: false }),
  });
}

/** Cash collected, failed delivery or returned by the courier; dialogs show failures inline. */
export function useUpdateOrderCod() {
  const queryClient = useQueryClient();
  return useSingleFlightMutation({
    mutationFn: ({ orderId, ...body }: { orderId: string } &
      ApiBody<typeof postApiV1AdminOrdersByIdCod>) =>
      apiData(postApiV1AdminOrdersByIdCod({ path: { id: orderId }, body })),
    onSuccess: (_data, variables) => {
      invalidateOrder(queryClient, variables.orderId);
      if (variables.action === "collected") invalidateOrderInventoryQueries(queryClient);
      toast.success(msg(
        variables.action === "collected" ? "toast.codCollected"
          : variables.action === "failed" ? "toast.codFailed" : "toast.codReturned",
      ));
    },
    onError: (err, variables) => {
      void onOrderError(queryClient, variables.orderId, err, { banner: false });
      if (variables.action === "collected") invalidateOrderInventoryQueries(queryClient);
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
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.notifications(variables.orderId) });
      toast.success(msg(result.enqueued ? "toast.messageQueued" : "toast.messageLater"));
    },
    onError: (err, variables) => void onOrderError(queryClient, variables.orderId, err, { banner: true }),
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
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.notifications(variables.orderId) });
      toast.success(msg(result.enqueued ? "toast.messageQueued" : "toast.messageLater"));
    },
    onError: (err, variables) => void onOrderError(queryClient, variables.orderId, err, { banner: true }),
  });
}

/** Customer request review; accepting a cancellation cancels the order on the server. */
export function useResolveOrderSupportRequest() {
  const queryClient = useQueryClient();
  return useSingleFlightMutation({
    mutationFn: ({ orderId, requestId, status, note, returnRequest }: {
      orderId: string;
      requestId: string;
    } & ApiBody<typeof putApiV1AdminOrdersByIdSupportRequestsByRequestIdStatus>) =>
      apiData(putApiV1AdminOrdersByIdSupportRequestsByRequestIdStatus({
        path: { id: orderId, requestId },
        body: { status, note: note ?? null, returnRequest },
      })),
    onSuccess: (_result, variables) => {
      invalidateOrder(queryClient, variables.orderId);
      invalidateOrderInventoryQueries(queryClient);
      toast.success(msg("toast.requestUpdated"));
    },
    onError: (err, variables) => void onOrderError(queryClient, variables.orderId, err, { banner: false, refresh: true }),
  });
}

function useOrderReturnMutation<Input extends { orderId: string }, Result>(
  mutationFn: (input: Input) => Promise<Result>,
  onDone: (queryClient: QueryClient, result: Result, input: Input) => void,
) {
  const queryClient = useQueryClient();
  return useSingleFlightMutation({
    mutationFn,
    onSuccess: (result: Result, input: Input) => {
      void invalidateOrder(queryClient, input.orderId);
      onDone(queryClient, result, input);
    },
    // The return may have changed elsewhere: always reload it.
    onError: (err: unknown, input: Input) => void onOrderError(queryClient, input.orderId, err, { banner: false, refresh: true }),
  });
}

export function useCreateOrderReturn() {
  return useOrderReturnMutation(
    ({ orderId, ...body }: CreateOrderReturnInput) =>
      apiData(postApiV1AdminOrdersByIdReturns({ path: { id: orderId }, body })),
    () => toast.success(msg("toast.returnRequested")),
  );
}

export function useApproveOrderReturn() {
  return useOrderReturnMutation(
    ({ orderId, returnId, ...body }: ApproveOrderReturnInput) =>
      apiData(postApiV1AdminOrdersByIdReturnsByReturnIdApprove({ path: { id: orderId, returnId }, body })),
    (_client, result) => toast.success(msg(result.status === "rejected" ? "toast.returnRejected" : "toast.returnApproved")),
  );
}

export function useReceiveOrderReturn() {
  return useOrderReturnMutation(
    ({ orderId, returnId, ...body }: ReceiveOrderReturnInput) =>
      apiData(postApiV1AdminOrdersByIdReturnsByReturnIdReceive({ path: { id: orderId, returnId }, body })),
    (queryClient, result, input) => {
      if (input.lines.some((line) => line.restockQuantity > 0)) invalidateOrderInventoryQueries(queryClient);
      toast.success(msg(result.status === "completed" ? "toast.returnReceived" : "toast.receiptRecorded"));
    },
  );
}

export function useCancelOrderReturn() {
  return useOrderReturnMutation(
    ({ orderId, returnId, ...body }: CancelOrderReturnInput) =>
      apiData(postApiV1AdminOrdersByIdReturnsByReturnIdCancel({ path: { id: orderId, returnId }, body })),
    () => toast.success(msg("toast.returnCancelled")),
  );
}

export function useReconcileOrderReturn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, returnId }: ReconcileOrderReturnInput) =>
      apiData(postApiV1AdminOrdersByIdReturnsByReturnIdReconcile({ path: { id: orderId, returnId } })),
    onSuccess: (_result, variables) => {
      invalidateOrder(queryClient, variables.orderId);
      invalidateOrderInventoryQueries(queryClient);
      toast.success(msg("toast.receiptRecorded"));
    },
    onError: (err, variables) => {
      void onOrderError(queryClient, variables.orderId, err, { banner: true });
      invalidateOrderInventoryQueries(queryClient);
    },
  });
}

export function useRestoreOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expectedVersion }: { id: string; expectedVersion: number }) =>
      apiData(postApiV1AdminOrdersByIdRestore({ path: { id }, body: { expectedVersion } })),
    onSuccess: (_data, input) => {
      invalidateOrder(queryClient, input.id);
      toast.success(msg("toast.orderRestored"));
    },
    onError: (err, input) => void onOrderError(queryClient, input.id, err, { banner: true }),
  });
}
