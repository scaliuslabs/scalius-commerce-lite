import { describe, expect, it, vi } from "vitest";

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
  bulkDeleteOrders: vi.fn(),
  createFulfillmentShipment: vi.fn(),
  createOrder: vi.fn(),
  createOrderShipment: vi.fn(),
  reconcileRefundAttempt: vi.fn(),
  refundOrder: vi.fn(),
  retryOrderNotification: vi.fn(),
  restoreOrder: vi.fn(),
  returnOrder: vi.fn(),
  updateFulfillmentStatus: vi.fn(),
  updateOrder: vi.fn(),
  updateOrderCod: vi.fn(),
  updateOrderStatus: vi.fn(),
}));

import { queryKeys } from "../query-keys";
import {
  useReconcileRefundAttempt,
  useRetryOrderNotification,
  useUpdateOrderCod,
} from "./orders";

type MutationOptions = {
  onSuccess?: (data: unknown, variables: { orderId: string }) => void;
};

describe("order COD mutations", () => {
  it("invalidates order list, detail, payments, and COD queries after successful COD actions", () => {
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
});

describe("order refund recovery mutations", () => {
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
