// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const toastMocks = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }));
const noticeMocks = vi.hoisted(() => ({ showOrderNotice: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMocks }));
vi.mock("../order-notice", () => noticeMocks);

const sdk = vi.hoisted(() => ({
  deleteApiV1AdminOrdersByIdTimelineByEventId: vi.fn(),
  postApiV1AdminOrdersByIdAmendments: vi.fn(),
  postApiV1AdminOrdersByIdCod: vi.fn(),
  postApiV1AdminOrdersByIdFulfillments: vi.fn(),
  postApiV1AdminOrdersByIdFulfillmentsByFulfillmentIdVoid: vi.fn(),
  postApiV1AdminOrdersByIdPickupReady: vi.fn(),
  postApiV1AdminOrdersByIdPaymentRecoveryLink: vi.fn(),
  postApiV1AdminOrdersByIdRefund: vi.fn(),
  postApiV1AdminOrdersByIdReturnsByReturnIdReceive: vi.fn(),
  postApiV1AdminOrdersByIdTimeline: vi.fn(),
  putApiV1AdminOrdersByIdStatus: vi.fn(),
  putApiV1AdminOrdersByIdSupportRequestsByRequestIdStatus: vi.fn(),
}));
vi.mock("@scalius/api-client/sdk", () => sdk);
// The SDK mocks resolve to the envelope's data (or reject with the API error) directly.
vi.mock("../api", () => ({ apiData: (call: unknown) => call }));

import { translate } from "~/i18n";
import { orderDetailMessages } from "~/i18n/order-detail";
import { AdminApiResponseError } from "../admin-api-error";
import { queryKeys } from "../query-keys";
import {
  orderErrorMessage,
  useAddOrderComment,
  useConfirmManualOrderAmendment,
  useCreateFulfillment,
  useIssueOrderPaymentRecoveryLink,
  useMarkPickupReady,
  useReceiveOrderReturn,
  useRefundOrder,
  useResolveOrderSupportRequest,
  useUpdateOrderCod,
  useUpdateOrderStatus,
  useVoidFulfillment,
} from "./orders";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const msg = (key: keyof typeof orderDetailMessages.en) => translate(orderDetailMessages, key);

let client: QueryClient;
let invalidate: MockInstance<QueryClient["invalidateQueries"]>;
const roots: Root[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  invalidate = vi.spyOn(client, "invalidateQueries");
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  client.clear();
});

/** Renders a mutation hook inside a real QueryClient and returns its latest result. */
function renderMutation<T>(useHook: () => T): { current: T } {
  const result = {} as { current: T };
  function Probe() {
    result.current = useHook();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  act(() => root.render(createElement(QueryClientProvider, { client }, createElement(Probe))));
  return result;
}

async function run<V>(hook: { current: { mutateAsync: (variables: V) => Promise<unknown> } }, variables: V) {
  await act(async () => {
    await hook.current.mutateAsync(variables).catch(() => undefined);
  });
}

type Filters = { predicate?: (query: { queryKey: unknown[] }) => boolean; queryKey?: unknown };
const invalidated = () => invalidate.mock.calls.map(([filters]) => (filters ?? {}) as Filters);

/** Did an invalidation cover `["orders", <kind>, orderId]`? */
function refreshedOrderQuery(kind: string, orderId: string): boolean {
  return invalidated().some((filters) =>
    filters.predicate?.({ queryKey: ["orders", kind, orderId] }) === true);
}

const refreshedStock = () => invalidated().some((filters) =>
  JSON.stringify(filters.queryKey) === JSON.stringify(queryKeys.inventory.list()));

describe("order mutations refresh every card of the order", () => {
  it("reloads detail, returns, cash and timeline after a status change", async () => {
    sdk.putApiV1AdminOrdersByIdStatus.mockResolvedValue({});
    await run(renderMutation(useUpdateOrderStatus), { orderId: "ord_1", status: "confirmed" });

    for (const kind of ["detail", "returns", "cod", "timeline", "shipments", "payments"]) {
      expect(refreshedOrderQuery(kind, "ord_1")).toBe(true);
    }
    expect(refreshedOrderQuery("detail", "ord_2")).toBe(false);
    expect(toastMocks.success).toHaveBeenCalledWith(msg("toast.status.confirmed"));
  });

  it("reloads the Returns card when the courier returns the parcel, without touching stock", async () => {
    sdk.postApiV1AdminOrdersByIdCod.mockResolvedValue({});
    await run(renderMutation(useUpdateOrderCod), { orderId: "ord_1", action: "returned" });

    expect(refreshedOrderQuery("returns", "ord_1")).toBe(true);
    expect(refreshedStock()).toBe(false);
    expect(toastMocks.success).toHaveBeenCalledWith(msg("toast.codReturned"));
  });

  it("refreshes stock only when a receipt puts units back on sale", async () => {
    sdk.postApiV1AdminOrdersByIdReturnsByReturnIdReceive.mockResolvedValue({ status: "completed" });
    const hook = renderMutation(useReceiveOrderReturn);
    const input = {
      orderId: "ord_1", returnId: "ret_1", commandKey: "k1", expectedVersion: 1, notes: null,
      lines: [{ lineId: "l1", receivedQuantity: 1, restockQuantity: 0, damagedQuantity: 1 }],
    };
    await run(hook, input);
    expect(refreshedStock()).toBe(false);

    await run(hook, { ...input, commandKey: "k2", lines: [{ lineId: "l1", receivedQuantity: 1, restockQuantity: 1, damagedQuantity: 0 }] });
    expect(refreshedStock()).toBe(true);
    expect(toastMocks.success).toHaveBeenCalledTimes(2);
  });
});

describe("order mutation failures", () => {
  it("reloads a changed order and says it now shows the latest", async () => {
    const conflict = new AdminApiResponseError("This order changed. Reload to see the latest.", 409, "CONFLICT");
    sdk.putApiV1AdminOrdersByIdStatus.mockRejectedValue(conflict);
    await run(renderMutation(useUpdateOrderStatus), { orderId: "ord_1", status: "confirmed" });

    expect(refreshedOrderQuery("detail", "ord_1")).toBe(true);
    expect(refreshedOrderQuery("payments", "ord_1")).toBe(true);
    expect(refreshedOrderQuery("cod", "ord_1")).toBe(true);
    expect(noticeMocks.showOrderNotice).toHaveBeenLastCalledWith("ord_1", msg("error.orderChanged"));
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it("refreshes a stale tab whose action was refused, and says the order changed", async () => {
    // Another tab already collected the cash; this tab still showed "Mark COD collected".
    client.setQueryData(queryKeys.orders.detail("ord_1"), { id: "ord_1", version: 3 });
    invalidate.mockImplementation(async () => {
      client.setQueryData(queryKeys.orders.detail("ord_1"), { id: "ord_1", version: 4 });
    });
    sdk.postApiV1AdminOrdersByIdCod.mockRejectedValue(
      new AdminApiResponseError("Cash can be recorded once the order is sent with a courier.", 400, "VALIDATION_ERROR"),
    );
    await run(renderMutation(useUpdateOrderCod), { orderId: "ord_1", action: "collected", collectedBy: "Rider", collectedAmount: 500 });

    expect(refreshedOrderQuery("cod", "ord_1")).toBe(true);
    expect(noticeMocks.showOrderNotice).toHaveBeenCalledWith("ord_1", msg("error.orderChanged"));
  });

  it("leaves a plain field error to the dialog when the order didn't change", async () => {
    client.setQueryData(queryKeys.orders.detail("ord_1"), { id: "ord_1", version: 3 });
    sdk.postApiV1AdminOrdersByIdFulfillments.mockRejectedValue(new AdminApiResponseError("Choose at least one item to send.", 400));
    await run(renderMutation(useCreateFulfillment), { orderId: "ord_1", requestKey: "k", kind: "ship", lines: [] });

    expect(noticeMocks.showOrderNotice).not.toHaveBeenCalled();
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it("words server faults and lost connections the same plain way", () => {
    expect(orderErrorMessage(new AdminApiResponseError("API error: 502", 502))).toBe(msg("error.network"));
    expect(orderErrorMessage(new TypeError("Failed to fetch"))).toBe(msg("error.network"));
    expect(orderErrorMessage(new AdminApiResponseError("Only 2 of that item are left to send.", 409))).toBe("Only 2 of that item are left to send.");
  });

  it("keeps the amendment failure for the edit page's review dialog", async () => {
    sdk.postApiV1AdminOrdersByIdAmendments.mockRejectedValue(new Error("stale"));
    await run(renderMutation(useConfirmManualOrderAmendment), { id: "ord_1" } as never);
    expect(toastMocks.error).not.toHaveBeenCalled();
  });
});

describe("order mutation requests", () => {
  it("sends one refund for a double click, carrying the dialog's request key", async () => {
    sdk.postApiV1AdminOrdersByIdRefund.mockReturnValue(new Promise(() => undefined));
    const hook = renderMutation(useRefundOrder);
    const refund = { orderId: "ord_1", requestKey: "refund-key-1", amount: 500.5, reason: "requested_by_customer", manualSettlementConfirmed: true };
    await act(async () => {
      hook.current.mutate(refund);
      hook.current.mutate(refund);
    });

    expect(sdk.postApiV1AdminOrdersByIdRefund).toHaveBeenCalledTimes(1);
    expect(sdk.postApiV1AdminOrdersByIdRefund).toHaveBeenCalledWith({
      path: { id: "ord_1" },
      body: { requestKey: "refund-key-1", amount: 500.5, reason: "requested_by_customer", manualSettlementConfirmed: true },
    });
  });

  it("posts a comment once for a double submit and sends its draft key", async () => {
    sdk.postApiV1AdminOrdersByIdTimeline.mockResolvedValue({ id: "evt_1" });
    const hook = renderMutation(useAddOrderComment);
    await act(async () => {
      hook.current.mutate({ orderId: "ord_1", body: "Customer confirmed on the phone", requestKey: "draft-1" });
      hook.current.mutate({ orderId: "ord_1", body: "Customer confirmed on the phone", requestKey: "draft-1" });
    });
    expect(sdk.postApiV1AdminOrdersByIdTimeline).toHaveBeenCalledTimes(1);
    expect(sdk.postApiV1AdminOrdersByIdTimeline).toHaveBeenCalledWith({
      path: { id: "ord_1" },
      body: { body: "Customer confirmed on the phone", requestKey: "draft-1" },
    });
  });

  it("sends the own-courier retry key and the quantities per line", async () => {
    sdk.postApiV1AdminOrdersByIdFulfillments.mockResolvedValue({});
    await run(renderMutation(useCreateFulfillment), { orderId: "ord_1", requestKey: "key-1", kind: "ship", lines: [{ itemId: "i1", quantity: 2 }] });
    expect(sdk.postApiV1AdminOrdersByIdFulfillments).toHaveBeenCalledWith({
      path: { id: "ord_1" },
      body: { requestKey: "key-1", kind: "ship", lines: [{ itemId: "i1", quantity: 2 }] },
    });
    expect(toastMocks.success).toHaveBeenCalledWith(msg("toast.fulfilled"));
  });

  it("records a pickup with the cash taken at the counter, once for a double click", async () => {
    sdk.postApiV1AdminOrdersByIdFulfillments.mockReturnValue(new Promise(() => undefined));
    const hook = renderMutation(useCreateFulfillment);
    const pickup = { orderId: "ord_1", requestKey: "pickup-1", kind: "pickup" as const, cashReceived: 1200 };
    await act(async () => {
      hook.current.mutate(pickup);
      hook.current.mutate(pickup);
    });
    expect(sdk.postApiV1AdminOrdersByIdFulfillments).toHaveBeenCalledTimes(1);
    expect(sdk.postApiV1AdminOrdersByIdFulfillments).toHaveBeenCalledWith({
      path: { id: "ord_1" },
      body: { requestKey: "pickup-1", kind: "pickup", cashReceived: 1200 },
    });
  });

  it("voids a fulfilment with its confirm key and reloads the order", async () => {
    sdk.postApiV1AdminOrdersByIdFulfillmentsByFulfillmentIdVoid.mockResolvedValue({ quantity: 2 });
    await run(renderMutation(useVoidFulfillment), { orderId: "ord_1", fulfillmentId: "ful_1", requestKey: "void-1" });
    expect(sdk.postApiV1AdminOrdersByIdFulfillmentsByFulfillmentIdVoid).toHaveBeenCalledWith({
      path: { id: "ord_1", fulfillmentId: "ful_1" },
      body: { requestKey: "void-1" },
    });
    expect(toastMocks.success).toHaveBeenCalledWith(msg("toast.fulfillmentVoided"));
    expect(refreshedOrderQuery("detail", "ord_1")).toBe(true);
  });

  it("marks a pickup order ready with its retry key", async () => {
    sdk.postApiV1AdminOrdersByIdPickupReady.mockResolvedValue({ pickupReadyAt: "2026-09-25T10:00:00Z" });
    await run(renderMutation(useMarkPickupReady), { orderId: "ord_1", requestKey: "ready-1" });
    expect(sdk.postApiV1AdminOrdersByIdPickupReady).toHaveBeenCalledWith({ path: { id: "ord_1" }, body: { requestKey: "ready-1" } });
    expect(toastMocks.success).toHaveBeenCalledWith(msg("toast.pickupReady"));
  });

  it("sends the cancel reason with the status", async () => {
    sdk.putApiV1AdminOrdersByIdStatus.mockResolvedValue({});
    await run(renderMutation(useUpdateOrderStatus), { orderId: "ord_1", status: "cancelled", reason: "fake_order" });
    expect(sdk.putApiV1AdminOrdersByIdStatus).toHaveBeenCalledWith({
      path: { id: "ord_1" },
      body: { status: "cancelled", reason: "fake_order" },
    });
  });

  it("records a cash refund as recorded, and warns when the customer wasn't told", async () => {
    sdk.postApiV1AdminOrdersByIdRefund.mockResolvedValue({ isFullRefund: false, manualSettlementRecorded: true, sideEffectErrors: 1 });
    await run(renderMutation(useRefundOrder), { orderId: "ord_1", requestKey: "k", amount: 25, manualSettlementConfirmed: true });
    expect(toastMocks.success).toHaveBeenCalledWith(msg("toast.cashRefundRecorded"));
    expect(toastMocks.warning).toHaveBeenCalledWith(msg("toast.refundFollowUp"), { description: msg("toast.refundFollowUpDetail") });
  });

  it("never toasts a private payment link", async () => {
    sdk.postApiV1AdminOrdersByIdPaymentRecoveryLink.mockResolvedValue({ url: "https://shop.test/payment-recovery?orderId=ord_1" });
    await run(renderMutation(useIssueOrderPaymentRecoveryLink), { orderId: "ord_1" });
    expect(toastMocks.success).not.toHaveBeenCalled();
  });

  it("forwards a customer request answer with its return lines", async () => {
    sdk.putApiV1AdminOrdersByIdSupportRequestsByRequestIdStatus.mockResolvedValue({});
    const returnRequest = { commandKey: "return:support:1", expectedOrderVersion: 4, reason: "Wrong size", lines: [{ orderItemId: "i1", quantity: 1, reason: null }] };
    await run(renderMutation(useResolveOrderSupportRequest), { orderId: "ord_1", requestId: "req_1", status: "approved", returnRequest });
    expect(sdk.putApiV1AdminOrdersByIdSupportRequestsByRequestIdStatus).toHaveBeenCalledWith({
      path: { id: "ord_1", requestId: "req_1" },
      body: { status: "approved", note: null, returnRequest },
    });
  });
});
