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
  bulkDeleteOrders: vi.fn(),
  createFulfillmentShipment: vi.fn(),
  createOrder: vi.fn(),
  createOrderShipment: vi.fn(),
  issueOrderPaymentRecoveryLink: vi.fn(),
  reconcileRefundAttempt: vi.fn(),
  refundOrder: vi.fn(),
  resendOrderNotification: vi.fn(),
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
  issueOrderPaymentRecoveryLink,
  resendOrderNotification,
} from "../api-functions/orders";
import {
  useIssueOrderPaymentRecoveryLink,
  useReconcileRefundAttempt,
  useResendOrderNotification,
  useRetryOrderNotification,
  useUpdateOrderCod,
} from "./orders";

type MutationOptions = {
  mutationFn?: (variables: unknown) => unknown;
  onSuccess?: (data: unknown, variables: { orderId: string }) => void;
};

beforeEach(() => {
  vi.clearAllMocks();
});

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
        url: "https://storefront.test/order-success?token=private",
        expiresAt: 1_800_000_000,
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
