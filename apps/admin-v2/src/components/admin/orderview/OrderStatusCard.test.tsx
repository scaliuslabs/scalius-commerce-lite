// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Order } from "./types";
import { OrderStatusCard } from "./OrderStatusCard";
import { orderDetailMessages } from "~/i18n/order-detail";
import { orderMessages } from "~/i18n/orders";

const t = orderDetailMessages.en;
const o = orderMessages.en;

const mocks = vi.hoisted(() => ({ mutate: vi.fn() }));

vi.mock("~/lib/api-mutations/orders", () => ({
  useUpdateOrderStatus: () => ({ mutate: mocks.mutate, isPending: false }),
}));
vi.mock("~/hooks/use-order-action-permissions", () => ({
  useOrderActionPermissions: () => ({ canChangeOrderStatus: true }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const order = {
  id: "ord_1001", version: 1, status: "pending", paymentStatus: "unpaid", paidAmount: 0, items: [],
} as unknown as Order;

describe("OrderStatusCard", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
  });

  async function chooseStatus(label: string) {
    const trigger = host.querySelector<HTMLButtonElement>(`[aria-label="${t["status.title"]}"]`);
    await act(async () => {
      trigger?.focus();
      trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((element) => element.textContent === label);
    expect(option).toBeDefined();
    await act(async () => {
      option?.focus();
      option?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
  }

  it("changes forward statuses in one step", async () => {
    await act(async () => root.render(<OrderStatusCard order={order} />));
    await chooseStatus(o["status.confirmed"]);

    expect(mocks.mutate).toHaveBeenCalledWith({ orderId: "ord_1001", status: "confirmed" });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("asks before cancelling and only cancels after confirmation", async () => {
    await act(async () => root.render(<OrderStatusCard order={order} />));
    await chooseStatus(o["status.cancelled"]);

    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain(t["cancel.title"].replace("{id}", "ord_1001"));
    expect(mocks.mutate).not.toHaveBeenCalled();

    const keep = [...dialog!.querySelectorAll("button")].find((button) => button.textContent === t["cancel.keep"]);
    await act(async () => keep?.click());
    expect(mocks.mutate).not.toHaveBeenCalled();

    await chooseStatus(o["status.cancelled"]);
    const confirm = [...document.querySelectorAll('[role="alertdialog"] button')]
      .find((button) => button.textContent === t["cancel.confirm"]) as HTMLButtonElement | undefined;
    await act(async () => confirm?.click());
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate).toHaveBeenCalledWith({ orderId: "ord_1001", status: "cancelled" });
  });
});
