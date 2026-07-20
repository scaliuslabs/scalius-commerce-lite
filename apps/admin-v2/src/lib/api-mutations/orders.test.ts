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

vi.mock("@tanstack/react-query", () => ({
  useMutation: reactQueryMocks.useMutation,
  useQueryClient: reactQueryMocks.useQueryClient,
}));

vi.mock("sonner", () => ({
  toast: toastMocks,
}));

vi.mock("../api-functions/orders", () => ({
  approveOrderReturn: vi.fn(),
  archiveOrders: vi.fn(),
  bulkShipOrders: vi.fn(),
  cancelOrderReturn: vi.fn(),
  createFulfillmentShipment: vi.fn(),
  createOrder: vi.fn(),
  createOrderReturn: vi.fn(),
  createOrderShipment: vi.fn(),
  issueOrderPaymentRecoveryLink: vi.fn(),
  reconcileRefundAttempt: vi.fn(),
  reconcileOrderReturn: vi.fn(),
  reconcileShipment: vi.fn(),
  receiveOrderReturn: vi.fn(),
  refundOrder: vi.fn(),
  resolveOrderSupportRequest: vi.fn(),
  resendOrderNotification: vi.fn(),
  retryOrderNotification: vi.fn(),
  restoreOrder: vi.fn(),
  updateFulfillmentStatus: vi.fn(),
  updateOrder: vi.fn(),
  updateOrderCod: vi.fn(),
  updateOrderStatus: vi.fn(),
}));

import { queryKeys } from "../query-keys";
import {
  createOrderReturn,
  bulkShipOrders,
  issueOrderPaymentRecoveryLink,
  resolveOrderSupportRequest,
  resendOrderNotification,
} from "../api-functions/orders";
import {
  useBulkShipOrders,
  useCreateOrderReturn,
  useIssueOrderPaymentRecoveryLink,
  useResolveOrderSupportRequest,
  useRefundOrder,
  useReconcileRefundAttempt,
  useResendOrderNotification,
  useRetryOrderNotification,
  useUpdateOrderCod,
} from "./orders";

type MutationOptions = {
  mutationFn?: (variables: unknown) => unknown;
  onSuccess?: (data: unknown, variables: Record<string, unknown>) => void;
  onError?: (error: unknown, variables: Record<string, unknown>) => void;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("order COD mutations", () => {
  it("invalidates every order projection changed by a successful COD action", () => {
    const mutation = useUpdateOrderCod() as MutationOptions;

    mutation.onSuccess?.({}, { orderId: "ord_123" });

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

    expect(bulkShipOrders).toHaveBeenCalledWith({ data: variables });
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
    expect(toastMocks.success).toHaveBeenCalledWith(
      "2 shipments created successfully.",
    );
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
    expect(toastMocks.warning).toHaveBeenCalledWith(
      "1 of 2 shipments created.",
      {
        description:
          "1 failed. First issue: Order has an active refund operation.",
      },
    );
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
    expect(toastMocks.error).toHaveBeenCalledWith("Shipment failed", {
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
    expect(toastMocks.success).toHaveBeenCalledWith("Notification retry queued");
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

    expect(resendOrderNotification).toHaveBeenCalledWith({ data: variables });
    expect(reactQueryMocks.queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.orders.notifications("ord_123"),
    });
    expect(toastMocks.success).toHaveBeenCalledWith("Notification resend queued");
  });
});

describe("order refund recovery mutations", () => {
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
    expect(toastMocks.success).toHaveBeenCalledWith("Refund processed");
    expect(toastMocks.warning).toHaveBeenCalledWith(
      "Refund saved; follow-up needs attention",
      {
        description:
          "The financial refund is complete, but cache refresh or customer notification should be checked.",
      },
    );
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
    expect(toastMocks.success).toHaveBeenCalledWith("Refund recovery finalized");
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

    expect(issueOrderPaymentRecoveryLink).toHaveBeenCalledWith({
      data: variables,
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

    expect(createOrderReturn).toHaveBeenCalledWith({ data: variables });
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

    expect(resolveOrderSupportRequest).toHaveBeenCalledWith({ data: variables });
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
