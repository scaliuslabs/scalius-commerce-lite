import { beforeEach, describe, expect, it, vi } from "vitest";

const reactQueryMocks = vi.hoisted(() => {
  const queryClient = {
    invalidateQueries: vi.fn(),
  };

  return {
    queryClient,
    useMutation: vi.fn((options: unknown) => options),
    useQueryClient: vi.fn(() => queryClient),
  };
});

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));
const routerMocks = vi.hoisted(() => ({
  invalidate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: reactQueryMocks.useMutation,
  useQueryClient: reactQueryMocks.useQueryClient,
}));

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => routerMocks,
}));

vi.mock("sonner", () => ({
  toast: toastMocks,
}));

const sdk = vi.hoisted(() => ({
  postApiV1AdminOrdersByIdRefund: vi.fn(),
  postApiV1AdminOrdersBulkShip: vi.fn(),
  postApiV1AdminOrdersByIdNotificationsByOutboxIdResend: vi.fn(),
  postApiV1AdminOrdersByIdPaymentRecoveryLink: vi.fn(),
  postApiV1AdminOrdersByIdReturns: vi.fn(),
  putApiV1AdminOrdersByIdSupportRequestsByRequestIdStatus: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("../api", () => ({ apiData: (call: unknown) => call }));

import { translate } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { queryKeys } from "../query-keys";

const msg = (key: keyof typeof orderDetailMessages.en, vars?: Record<string, string | number>) =>
  translate(orderDetailMessages, key, vars);
import {
  useBulkShipOrders,
  useCreateFulfillmentShipment,
  useCreateOrder,
  useConfirmManualOrderAmendment,
  useCreateOrderReturn,
  useIssueOrderPaymentRecoveryLink,
  useReceiveOrderReturn,
  useReconcileOrderReturn,
  useResolveOrderSupportRequest,
  useRefundOrder,
  useReconcileRefundAttempt,
  useResendOrderNotification,
  useRetryOrderNotification,
  useUpdateOrder,
  useUpdateOrderCod,
  useUpdateOrderStatus,
} from "./orders";

type MutationOptions = {
  mutationFn?: (variables: unknown) => unknown;
  onSuccess?: (data: unknown, variables: Record<string, unknown>) => void;
  onError?: (error: unknown, variables: Record<string, unknown>) => void;
};

beforeEach(() => {
  vi.clearAllMocks();
});

function expectInventoryProjectionInvalidations() {
  expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
    queryKey: queryKeys.inventory.list(),
  });
  expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
    queryKey: queryKeys.products.all,
  });
  expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
    queryKey: ["orders", "catalog-products"],
  });
}

function expectNoInventoryProjectionInvalidations() {
  expect(reactQueryMocks.queryClient.invalidateQueries).not.toHaveBeenCalledWith({
    queryKey: queryKeys.inventory.list(),
  });
  expect(reactQueryMocks.queryClient.invalidateQueries).not.toHaveBeenCalledWith({
    queryKey: queryKeys.products.all,
  });
  expect(reactQueryMocks.queryClient.invalidateQueries).not.toHaveBeenCalledWith({
    queryKey: ["orders", "catalog-products"],
  });
}

describe("order inventory projection freshness", () => {
  it("refreshes query and route-loader snapshots after a successful amendment or replay", async () => {
    const mutation = useConfirmManualOrderAmendment() as MutationOptions;

    await mutation.onSuccess?.({}, { id: "ord_123" });

    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.orders.formData("ord_123"),
    });
    expect(routerMocks.invalidate).toHaveBeenCalledTimes(1);
  });

  it("refreshes the permanent order-editor snapshot after an update", () => {
    const mutation = useUpdateOrder() as MutationOptions;

    mutation.onSuccess?.({}, { id: "ord_123" });

    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.orders.formData("ord_123"),
    });
    expectInventoryProjectionInvalidations();
  });

  it("refreshes inventory, product, and manual-order catalog reads after reserving an order", () => {
    const mutation = useCreateOrder() as MutationOptions;

    mutation.onSuccess?.({ id: "ord_123" }, {});

    expectInventoryProjectionInvalidations();
  });

  it("refreshes stock projections after a lifecycle status transition", () => {
    const mutation = useUpdateOrderStatus() as MutationOptions;

    mutation.onSuccess?.(
      { message: "updated" },
      { orderId: "ord_123", status: "cancelled" },
    );

    expectInventoryProjectionInvalidations();
  });

  it("refreshes stock projections after fulfillment can deduct reservations", () => {
    const mutation = useCreateFulfillmentShipment() as MutationOptions;

    mutation.onSuccess?.(
      { shipmentId: "shp_1" },
      { orderId: "ord_123", itemIds: ["item_1"] },
    );

    expectInventoryProjectionInvalidations();
  });
});

describe("order COD mutations", () => {
  it("invalidates every order projection changed by a successful COD action", () => {
    const mutation = useUpdateOrderCod() as MutationOptions;

    mutation.onSuccess?.(
      {},
      {
        orderId: "ord_123",
        action: "collected",
        collectedBy: "Courier",
        collectedAmount: 100,
      },
    );

    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.orders.list(),
    });
    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.orders.detail("ord_123"),
    });
    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.orders.payments("ord_123"),
    });
    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.orders.cod("ord_123"),
    });
    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.orders.shipments("ord_123"),
    });
    expectInventoryProjectionInvalidations();
  });

  it("does not refresh stock projections for a failed-delivery note", () => {
    const mutation = useUpdateOrderCod() as MutationOptions;

    mutation.onSuccess?.(
      {},
      { orderId: "ord_123", action: "failed", reason: "not_home" },
    );

    expectNoInventoryProjectionInvalidations();
  });
});

describe("bulk ship order mutations", () => {
  it("submits one bulk shipment request and invalidates touched orders after full success", () => {
    const mutation = useBulkShipOrders() as MutationOptions;
    const variables = {
      orderIds: ["ord_1", "ord_2"],
      providerId: "provider_1",
      options: {},
    };
    const result = {
      totalProcessed: 2,
      successCount: 2,
      failureCount: 0,
      results: [
        { orderId: "ord_1", success: true },
        { orderId: "ord_2", success: true },
      ],
    };

    mutation.mutationFn?.(variables);
    mutation.onSuccess?.(result, variables);

    expect(sdk.postApiV1AdminOrdersBulkShip).toHaveBeenCalledWith({ body: variables });
    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.orders.list(),
    });
    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.dashboard.all,
    });
    for (const orderId of variables.orderIds) {
      expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: queryKeys.orders.detail(orderId),
      });
      expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: queryKeys.orders.shipments(orderId),
      });
    }
    expectInventoryProjectionInvalidations();
    expect(toastMocks.success).toHaveBeenCalledWith(msg("toast.bulkShipped"), {
      description: msg("toast.bulkShippedDetail", { count: 2 }),
    });
  });

  it("keeps partial failures visible while invalidating every selected order", () => {
    const mutation = useBulkShipOrders() as MutationOptions;
    const variables = {
      orderIds: ["ord_1", "ord_2"],
      providerId: "provider_1",
      options: {},
    };
    const result = {
      totalProcessed: 2,
      successCount: 1,
      failureCount: 1,
      results: [
        { orderId: "ord_1", success: true },
        {
          orderId: "ord_2",
          success: false,
          error: "Order has an active refund operation.",
        },
      ],
    };

    mutation.onSuccess?.(result, variables);

    for (const orderId of variables.orderIds) {
      expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: queryKeys.orders.detail(orderId),
      });
      expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
        queryKey: queryKeys.orders.shipments(orderId),
      });
    }
    expect(toastMocks.warning).toHaveBeenCalledWith(msg("toast.bulkShippedSome"), {
      description: msg("toast.bulkShipFirstIssue", {
        done: 1, total: 2, count: 1, reason: "Order has an active refund operation.",
      }),
    });
  });

  it("reports aggregate total failure with the first safe failure reason", () => {
    const mutation = useBulkShipOrders() as MutationOptions;
    const variables = {
      orderIds: ["ord_1", "ord_2"],
      providerId: "provider_1",
      options: {},
    };
    const result = {
      totalProcessed: 2,
      successCount: 0,
      failureCount: 2,
      results: [
        {
          orderId: "ord_1",
          success: false,
          error: "Delivery provider is not active.",
        },
        { orderId: "ord_2", success: false, error: "Order not found." },
      ],
    };

    mutation.onSuccess?.(result, variables);

    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.orders.list(),
    });
    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.dashboard.all,
    });
    expect(toastMocks.error).toHaveBeenCalledWith(msg("toast.bulkShipFailed"), {
      description: "Delivery provider is not active.",
    });
  });
});

describe("order notification mutations", () => {
  it("invalidates notification history after a retry is queued", () => {
    const mutation = useRetryOrderNotification() as MutationOptions;

    mutation.onSuccess?.(
      { enqueued: true },
      { orderId: "ord_123", outboxId: "outbox_1" } as never,
    );

    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.orders.notifications("ord_123"),
    });
    expect(toastMocks.success).toHaveBeenCalledWith(msg("toast.messageQueued"));
  });

  it("passes a fresh resend request id through the resend mutation and invalidates history", () => {
    const mutation = useResendOrderNotification() as MutationOptions;
    const variables = {
      orderId: "ord_123",
      outboxId: "outbox_1",
      resendRequestId: "req_1",
    };

    mutation.mutationFn?.(variables);
    mutation.onSuccess?.({ enqueued: true }, variables as never);

    expect(sdk.postApiV1AdminOrdersByIdNotificationsByOutboxIdResend).toHaveBeenCalledWith({
      path: { id: "ord_123", outboxId: "outbox_1" },
      body: { resendRequestId: "req_1" },
    });
    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.orders.notifications("ord_123"),
    });
    expect(toastMocks.success).toHaveBeenCalledWith(msg("toast.messageQueued"));
  });
});

describe("order refund recovery mutations", () => {
  it("sends the manual COD settlement confirmation with the refund", () => {
    const mutation = useRefundOrder() as MutationOptions;

    mutation.mutationFn?.({
      orderId: "ord_123",
      amount: 150,
      reason: "Returned in store",
      manualSettlementConfirmed: true,
    });

    expect(sdk.postApiV1AdminOrdersByIdRefund).toHaveBeenCalledWith({
      path: { id: "ord_123" },
      body: { amount: 150, reason: "Returned in store", manualSettlementConfirmed: true },
    });
  });

  it("treats a committed refund as success while surfacing failed follow-up work", () => {
    const mutation = useRefundOrder() as MutationOptions;

    mutation.onSuccess?.(
      {
        success: true,
        gateway: "sslcommerz",
        refundId: "refund_provider_1",
        amount: 100,
        isFullRefund: true,
        notificationCount: 0,
        sideEffectErrors: 2,
      },
      { orderId: "ord_123" } as never,
    );

    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.orders.detail("ord_123"),
    });
    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.orders.payments("ord_123"),
    });
    expectInventoryProjectionInvalidations();
    expect(toastMocks.success).toHaveBeenCalledWith(msg("toast.refunded"));
    expect(toastMocks.warning).toHaveBeenCalledWith(msg("toast.refundFollowUp"), {
      description: msg("toast.refundFollowUpDetail"),
    });
  });

  it("does not refresh stock projections for a partial refund", () => {
    const mutation = useRefundOrder() as MutationOptions;

    mutation.onSuccess?.(
      {
        success: true,
        gateway: "stripe",
        refundId: "refund_provider_1",
        amount: 25,
        isFullRefund: false,
        notificationCount: 0,
        sideEffectErrors: 0,
      },
      { orderId: "ord_123" },
    );

    expectNoInventoryProjectionInvalidations();
  });

  it("reports a confirmed offline COD repayment as recorded rather than processed", () => {
    const mutation = useRefundOrder() as MutationOptions;

    mutation.onSuccess?.(
      {
        success: true,
        gateway: "cod",
        amount: 25,
        isFullRefund: false,
        manualSettlementRecorded: true,
        notificationCount: 1,
        sideEffectErrors: 0,
      },
      {
        orderId: "ord_123",
        amount: 25,
        reason: "requested_by_customer",
        manualSettlementConfirmed: true,
      } as never,
    );

    expect(toastMocks.success).toHaveBeenCalledWith(msg("toast.cashRefundRecorded"));
    expect(toastMocks.success).not.toHaveBeenCalledWith(msg("toast.refunded"));
  });

  it("invalidates order state and payments after a manual recovery check", () => {
    const mutation = useReconcileRefundAttempt() as MutationOptions;

    mutation.onSuccess?.(
      {
        status: "finalized",
        sideEffectErrors: 0,
      },
      { orderId: "ord_123", attemptId: "rfa_1" } as never,
    );

    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.orders.list(),
    });
    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.orders.detail("ord_123"),
    });
    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.orders.payments("ord_123"),
    });
    expectInventoryProjectionInvalidations();
    expect(toastMocks.success).toHaveBeenCalledWith(msg("toast.refundCheckDone"));
  });

  it("does not refresh stock projections while refund recovery is deferred", () => {
    const mutation = useReconcileRefundAttempt() as MutationOptions;

    mutation.onSuccess?.(
      { status: "deferred", sideEffectErrors: 0 },
      { orderId: "ord_123", attemptId: "rfa_1" },
    );

    expectNoInventoryProjectionInvalidations();
  });
});

describe("order payment recovery link mutations", () => {
  it("issues recovery links without success-toasting the private URL", () => {
    const mutation = useIssueOrderPaymentRecoveryLink() as MutationOptions;
    const variables = { orderId: "ord_123" };

    mutation.mutationFn?.(variables);
    mutation.onSuccess?.(
      {
        orderId: "ord_123",
        url: "https://storefront.test/order-success?orderId=ord_123&payment=sslcommerz&result=failed",
        expiresAt: 1_800_000_000,
        accessMode: "existing_browser_receipt",
        note: "This clean recovery URL does not contain private receipt proof.",
      },
      variables,
    );

    expect(sdk.postApiV1AdminOrdersByIdPaymentRecoveryLink).toHaveBeenCalledWith({
      path: { id: "ord_123" },
    });
    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.orders.list(),
    });
    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.orders.detail("ord_123"),
    });
    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.orders.payments("ord_123"),
    });
    expect(toastMocks.success).not.toHaveBeenCalled();
  });
});

describe("item-level return mutations", () => {
  it("submits the plural return command and refreshes return, order, list, and dashboard reads", () => {
    const mutation = useCreateOrderReturn() as MutationOptions;
    const variables = {
      orderId: "ord_123",
      commandKey: "return:create:request-1",
      expectedOrderVersion: 4,
      reason: "Wrong size",
      notes: null,
      lines: [{ orderItemId: "item_1", quantity: 1 }],
    };

    mutation.mutationFn?.(variables);
    mutation.onSuccess?.({ status: "requested" }, variables);

    const { orderId: _orderId, ...returnBody } = variables;
    expect(sdk.postApiV1AdminOrdersByIdReturns).toHaveBeenCalledWith({
      path: { id: "ord_123" },
      body: returnBody,
    });
    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.orders.returns("ord_123"),
    });
    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.orders.detail("ord_123"),
    });
    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.orders.list(),
    });
    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.dashboard.all,
    });
  });

  it("refreshes authoritative order and return state after a conflict", () => {
    const mutation = useCreateOrderReturn() as MutationOptions;

    mutation.onError?.(new Error("conflict"), { orderId: "ord_123" });

    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.orders.returns("ord_123"),
    });
    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.orders.detail("ord_123"),
    });
  });

  it("refreshes stock projections only when a receipt restocks sellable units", () => {
    const mutation = useReceiveOrderReturn() as MutationOptions;
    const variables = {
      orderId: "ord_123",
      returnId: "ret_1",
      commandKey: "return:receive:request-1",
      expectedVersion: 2,
      lines: [{ lineId: "line_1", receivedQuantity: 1, restockQuantity: 1 }],
    };

    mutation.onSuccess?.({ status: "completed" }, variables);
    expectInventoryProjectionInvalidations();

    reactQueryMocks.queryClient.invalidateQueries.mockClear();
    mutation.onSuccess?.(
      { status: "completed" },
      {
        ...variables,
        commandKey: "return:receive:request-2",
        lines: [{ lineId: "line_1", receivedQuantity: 1, restockQuantity: 0 }],
      },
    );
    expectNoInventoryProjectionInvalidations();
  });

  it("refreshes stock projections after receipt reconciliation", () => {
    const mutation = useReconcileOrderReturn() as MutationOptions;

    mutation.onSuccess?.(
      { status: "completed" },
      { orderId: "ord_123", returnId: "ret_1" },
    );

    expectInventoryProjectionInvalidations();
  });
});

describe("customer return request mutations", () => {
  it("forwards the return creation payload and refreshes the linked return workspace", () => {
    const mutation = useResolveOrderSupportRequest() as MutationOptions;
    const variables = {
      orderId: "ord_123",
      requestId: "request_1",
      status: "approved",
      returnRequest: {
        commandKey: "return:support:request-1",
        expectedOrderVersion: 4,
        reason: "Wrong size",
        lines: [{ orderItemId: "item_1", quantity: 1 }],
      },
    };

    mutation.mutationFn?.(variables);
    mutation.onSuccess?.({}, variables);

    expect(sdk.putApiV1AdminOrdersByIdSupportRequestsByRequestIdStatus).toHaveBeenCalledWith({
      path: { id: "ord_123", requestId: "request_1" },
      body: { status: "approved", note: null, returnRequest: variables.returnRequest },
    });
    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.orders.detail("ord_123"),
    });
    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.orders.returns("ord_123"),
    });

    reactQueryMocks.queryClient.invalidateQueries.mockClear();
    mutation.onError?.(new Error("stale order"), variables);
    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.orders.detail("ord_123"),
    });
    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.orders.returns("ord_123"),
    });
  });
});
