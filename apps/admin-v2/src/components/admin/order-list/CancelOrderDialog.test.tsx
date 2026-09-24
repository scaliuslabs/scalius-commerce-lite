// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderListItem } from "@scalius/core/modules/orders/types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const statusMutate = vi.hoisted(() => vi.fn());
vi.mock("~/lib/api-mutations/orders", () => ({
  orderErrorMessage: () => "Failed",
  useUpdateOrderStatus: () => ({ mutate: statusMutate }),
  useRestoreOrder: () => ({ mutate: vi.fn() }),
}));
vi.mock("~/lib/api-query-options/orders", () => ({
  // Two unsent kurtas, one of two attars already with the courier, one untracked gift card.
  getOrderItems: async () => [
    { quantity: 2, shippedQuantity: 0, inventoryTracked: true },
    { quantity: 2, shippedQuantity: 1, inventoryTracked: true },
    { quantity: 1, shippedQuantity: 0, inventoryTracked: false },
  ],
}));

import { orderDetailMessages } from "~/i18n/order-detail";
import type { OrderActionPermissions } from "~/lib/order-action-permissions";
import { OrderRowCancelDialog } from "./CancelOrderDialog";
import { useOrderActions, type OrderSelection } from "./use-order-actions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const d = orderDetailMessages.en;

const order = {
  id: "ord_1088",
  orderNumber: 1088,
  status: "pending",
  customerEmail: "rina@example.com",
  version: 1,
} as unknown as OrderListItem;

let actions: ReturnType<typeof useOrderActions>;

function Harness() {
  const selection = { current: { rows: [], clear: vi.fn(), deselect: vi.fn() } as OrderSelection };
  actions = useOrderActions({ canChangeOrderStatus: true } as OrderActionPermissions, selection);
  return (
    <OrderRowCancelDialog
      order={actions.cancelOrder}
      pending={false}
      onOpenChange={(open) => {
        if (!open) actions.setCancelOrder(null);
      }}
      onConfirm={(target, reason) => actions.changeStatus(target, "cancelled", { confirmed: true, reason })}
    />
  );
}

describe("cancelling from the order list's status menu", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    statusMutate.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(
      <QueryClientProvider client={new QueryClient()}>
        <Harness />
      </QueryClientProvider>,
    ));
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("asks with the order page's dialog, then cancels with the chosen reason", async () => {
    await act(async () => actions.changeStatus(order, "cancelled"));
    expect(statusMutate).not.toHaveBeenCalled();

    const dialog = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>('[role="alertdialog"]');
      expect(found?.textContent).toContain(d["cancel.restock"].replace("{count}", "3"));
      return found!;
    });
    expect(dialog.textContent).toContain(d["cancel.title"].replace("{name}", "#1088"));
    expect(dialog.textContent).toContain(d["cancel.notify"]);

    const reason = dialog.querySelector<HTMLSelectElement>("select")!;
    await act(async () => {
      reason.value = "unreachable";
      reason.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const confirm = [...dialog.querySelectorAll("button")].find((button) => button.textContent === d["cancel.confirm"])!;
    await act(async () => confirm.click());

    expect(statusMutate).toHaveBeenCalledTimes(1);
    expect(statusMutate.mock.calls[0]![0]).toEqual({ orderId: "ord_1088", status: "cancelled", reason: "unreachable" });
    expect(actions.cancelOrder).toBeNull();
  });

  it("changes Confirmed right away", async () => {
    await act(async () => actions.changeStatus(order, "confirmed"));
    expect(statusMutate.mock.calls[0]![0]).toEqual({ orderId: "ord_1088", status: "confirmed" });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });
});
