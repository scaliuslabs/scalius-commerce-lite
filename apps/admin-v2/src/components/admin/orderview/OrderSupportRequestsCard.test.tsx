// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { orderDetailMessages } from "~/i18n/order-detail";
import type { Order, OrderSupportRequest } from "./types";
import { OrderSupportRequestsCard, resolutionsFor } from "./OrderSupportRequestsCard";

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), canChangeOrderStatus: true }));
vi.mock("~/hooks/use-order-action-permissions", () => ({
  useOrderActionPermissions: () => ({ canResolveOrderSupportRequests: true, canChangeOrderStatus: mocks.canChangeOrderStatus }),
}));
vi.mock("~/lib/api-mutations/orders", () => ({
  orderErrorMessage: (error: Error) => error.message,
  useResolveOrderSupportRequest: () => ({ mutate: mocks.mutate, reset: vi.fn(), isPending: false, isError: false }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const en = orderDetailMessages.en;

const request = {
  id: "req_1", orderId: "ord_1", customerId: null, type: "cancel_pre_shipment", status: "submitted", active: true,
  severity: "warning", label: "Cancellation request", actionLabel: "Review", reason: "Ordered by mistake",
  message: null, submittedAt: 1, resolvedAt: null, createdAt: 1, updatedAt: 1,
} as OrderSupportRequest;
const order = {
  id: "ord_1", version: 3, status: "pending", items: [{ id: "i1", quantity: 2, inventoryTracked: true, shippedQuantity: 0 }],
  supportRequests: [request],
} as unknown as Order;

describe("customer requests", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canChangeOrderStatus = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("only lets staff who can cancel orders accept a cancellation", () => {
    expect(resolutionsFor(request, true)).toContain("approved");
    expect(resolutionsFor(request, false)).not.toContain("approved");
    expect(resolutionsFor({ ...request, type: "return" }, false)).toContain("approved");
  });

  it("pre-selects no answer and says that accepting cancels the order", async () => {
    await act(async () => root.render(
      <QueryClientProvider client={new QueryClient()}>
        <OrderSupportRequestsCard order={order} />
      </QueryClientProvider>,
    ));
    const review = [...host.querySelectorAll("button")].find((button) => button.textContent === en["requests.review"])!;
    await act(async () => review.click());

    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('[role="radio"][data-state="checked"]')).toBeNull();
    const save = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    await act(async () => dialog.querySelector<HTMLButtonElement>("#resolution-approved")!.click());
    expect(dialog.textContent).toContain(en["requests.cancelHelp"]);
    const accept = [...dialog.querySelectorAll("button")].find((button) => button.textContent === en["requests.acceptCancel"])!;
    await act(async () => accept.click());
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "ord_1", requestId: "req_1", status: "approved" }),
      expect.anything(),
    );
  });
});
