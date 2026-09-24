import { beforeEach, describe, expect, it, vi } from "vitest";

const reactQueryMocks = vi.hoisted(() => {
  const queryClient = { invalidateQueries: vi.fn() };
  return {
    queryClient,
    useMutation: vi.fn((options: unknown) => options),
    useQueryClient: vi.fn(() => queryClient),
  };
});
const toastMocks = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }));
const noticeMocks = vi.hoisted(() => ({ showOrderNotice: vi.fn() }));

vi.mock("@tanstack/react-query", () => ({
  useMutation: reactQueryMocks.useMutation,
  useQueryClient: reactQueryMocks.useQueryClient,
}));
vi.mock("sonner", () => ({ toast: toastMocks }));
vi.mock("../order-notice", () => noticeMocks);

const sdk = vi.hoisted(() => ({
  postApiV1AdminOrdersByIdFulfill: vi.fn(),
  postApiV1AdminOrdersByIdRefund: vi.fn(),
  putApiV1AdminOrdersByIdStatus: vi.fn(),
  putApiV1AdminOrdersByIdSupportRequestsByRequestIdStatus: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("../api", () => ({ apiData: (call: unknown) => call }));

import { translate } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { AdminApiResponseError } from "../admin-api-error";
import { queryKeys } from "../query-keys";
import {
  orderErrorMessage,
  useConfirmManualOrderAmendment,
  useCreateFulfillmentShipment,
  useIssueOrderPaymentRecoveryLink,
  useReceiveOrderReturn,
  useRefundOrder,
  useResolveOrderSupportRequest,
  useUpdateOrderCod,
  useUpdateOrderStatus,
} from "./orders";

const msg = (key: keyof typeof orderDetailMessages.en) => translate(orderDetailMessages, key);

type MutationOptions = {
  mutationFn?: (variables: unknown) => unknown;
  onSuccess?: (data: unknown, variables: Record<string, unknown>) => void;
  onError?: (error: unknown, variables: Record<string, unknown>) => void;
};

beforeEach(() => {
  vi.clearAllMocks();
});

const invalidated = () => reactQueryMocks.queryClient.invalidateQueries.mock.calls.map(([filters]) => filters);

/** Did an invalidation cover `["orders", <kind>, orderId]`? */
function refreshedOrderQuery(kind: string, orderId: string): boolean {
  return invalidated().some((filters: { predicate?: (query: { queryKey: unknown[] }) => boolean }) =>
    filters.predicate?.({ queryKey: ["orders", kind, orderId] }) === true);
}

const refreshedStock = () => invalidated().some((filters: { queryKey?: unknown }) =>
  JSON.stringify(filters.queryKey) === JSON.stringify(queryKeys.inventory.list()));

describe("order mutations refresh every card of the order", () => {
  it("reloads detail, returns, cash and timeline after a status change", () => {
    const mutation = useUpdateOrderStatus() as MutationOptions;
    mutation.onSuccess?.({}, { orderId: "ord_1", status: "confirmed" });

    for (const kind of ["detail", "returns", "cod", "timeline", "shipments", "payments"]) {
      expect(refreshedOrderQuery(kind, "ord_1")).toBe(true);
    }
    expect(refreshedOrderQuery("detail", "ord_2")).toBe(false);
    expect(toastMocks.success).toHaveBeenCalledWith(msg("toast.status.confirmed"));
  });

  it("reloads the Returns card when the courier returns the parcel, without touching stock", () => {
    const mutation = useUpdateOrderCod() as MutationOptions;
    mutation.onSuccess?.({}, { orderId: "ord_1", action: "returned" });

    expect(refreshedOrderQuery("returns", "ord_1")).toBe(true);
    expect(refreshedStock()).toBe(false);
    expect(toastMocks.success).toHaveBeenCalledWith(msg("toast.codReturned"));
  });

  it("refreshes stock only when a receipt puts units back on sale", () => {
    const mutation = useReceiveOrderReturn() as MutationOptions;
    const input = { orderId: "ord_1", returnId: "ret_1", lines: [{ lineId: "l1", receivedQuantity: 1, restockQuantity: 0, damagedQuantity: 1 }] };
    mutation.onSuccess?.({ status: "completed" }, input);
    expect(refreshedStock()).toBe(false);

    mutation.onSuccess?.({ status: "completed" }, { ...input, lines: [{ lineId: "l1", receivedQuantity: 1, restockQuantity: 1, damagedQuantity: 0 }] });
    expect(refreshedStock()).toBe(true);
  });
});

describe("order mutation failures", () => {
  it("reloads a changed order and explains it in the page banner", () => {
    const mutation = useUpdateOrderStatus() as MutationOptions;
    const conflict = new AdminApiResponseError("This order changed. Reload to see the latest.", 409, "CONFLICT");
    mutation.onError?.(conflict, { orderId: "ord_1", status: "confirmed" });

    expect(refreshedOrderQuery("detail", "ord_1")).toBe(true);
    expect(noticeMocks.showOrderNotice).toHaveBeenCalledWith("ord_1", "This order changed. Reload to see the latest.");
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it("leaves dialog errors to the dialog instead of a toast or banner", () => {
    const mutation = useCreateFulfillmentShipment() as MutationOptions;
    mutation.onError?.(new AdminApiResponseError("Choose at least one item to send.", 400), { orderId: "ord_1" });

    expect(noticeMocks.showOrderNotice).not.toHaveBeenCalled();
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it("words server faults and lost connections the same plain way", () => {
    expect(orderErrorMessage(new AdminApiResponseError("API error: 502", 502))).toBe(msg("error.network"));
    expect(orderErrorMessage(new TypeError("Failed to fetch"))).toBe(msg("error.network"));
    expect(orderErrorMessage(new AdminApiResponseError("Only 2 of that item are left to send.", 409))).toBe("Only 2 of that item are left to send.");
  });

  it("keeps the amendment failure for the edit page's review dialog", () => {
    const mutation = useConfirmManualOrderAmendment() as MutationOptions;
    mutation.onError?.(new Error("stale"), { id: "ord_1" });
    expect(toastMocks.error).not.toHaveBeenCalled();
  });
});

describe("order mutation requests", () => {
  it("sends the own-courier retry key and the quantities per line", () => {
    const mutation = useCreateFulfillmentShipment() as MutationOptions;
    mutation.mutationFn?.({ orderId: "ord_1", requestKey: "key-1", items: [{ itemId: "i1", quantity: 2 }] });
    expect(sdk.postApiV1AdminOrdersByIdFulfill).toHaveBeenCalledWith({
      path: { id: "ord_1" },
      body: { requestKey: "key-1", items: [{ itemId: "i1", quantity: 2 }] },
    });
  });

  it("sends the cancel reason with the status", () => {
    const mutation = useUpdateOrderStatus() as MutationOptions;
    mutation.mutationFn?.({ orderId: "ord_1", status: "cancelled", reason: "fake_order" });
    expect(sdk.putApiV1AdminOrdersByIdStatus).toHaveBeenCalledWith({
      path: { id: "ord_1" },
      body: { status: "cancelled", reason: "fake_order" },
    });
  });

  it("records a cash refund as recorded, and warns when the customer wasn't told", () => {
    const mutation = useRefundOrder() as MutationOptions;
    mutation.onSuccess?.(
      { isFullRefund: false, manualSettlementRecorded: true, sideEffectErrors: 1 },
      { orderId: "ord_1", amount: 25, manualSettlementConfirmed: true },
    );
    expect(toastMocks.success).toHaveBeenCalledWith(msg("toast.cashRefundRecorded"));
    expect(toastMocks.warning).toHaveBeenCalledWith(msg("toast.refundFollowUp"), { description: msg("toast.refundFollowUpDetail") });
  });

  it("never toasts a private payment link", () => {
    const mutation = useIssueOrderPaymentRecoveryLink() as MutationOptions;
    mutation.onSuccess?.({ url: "https://shop.test/payment-recovery?orderId=ord_1" }, { orderId: "ord_1" });
    expect(toastMocks.success).not.toHaveBeenCalled();
  });

  it("forwards a customer request answer with its return lines", () => {
    const mutation = useResolveOrderSupportRequest() as MutationOptions;
    const returnRequest = { commandKey: "return:support:1", expectedOrderVersion: 4, reason: "Wrong size", lines: [{ orderItemId: "i1", quantity: 1 }] };
    mutation.mutationFn?.({ orderId: "ord_1", requestId: "req_1", status: "approved", returnRequest });
    expect(sdk.putApiV1AdminOrdersByIdSupportRequestsByRequestIdStatus).toHaveBeenCalledWith({
      path: { id: "ord_1", requestId: "req_1" },
      body: { status: "approved", note: null, returnRequest },
    });
  });
});
