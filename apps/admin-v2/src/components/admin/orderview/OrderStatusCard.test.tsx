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
  id: "ord_1001", orderNumber: 1001, version: 1, status: "pending", paymentStatus: "unpaid", paidAmount: 0,
  customerEmail: null,
  items: [
    { id: "i1", quantity: 2, inventoryTracked: true, shippedQuantity: 0 },
    { id: "i2", quantity: 5, inventoryTracked: false, shippedQuantity: 0 },
  ],
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

  const statusSelect = () => host.querySelector<HTMLSelectElement>(`select[aria-label="${t["status.title"]}"]`);

  /** Returns the status option whose text starts with `label`. */
  async function openOption(label: string) {
    return [...(statusSelect()?.options ?? [])].find((element) => element.textContent?.startsWith(label));
  }

  async function chooseStatus(label: string) {
    const select = statusSelect();
    const option = [...(select?.options ?? [])].find((element) => element.textContent === label);
    expect(option).toBeDefined();
    await act(async () => {
      select!.value = option!.value;
      select!.dispatchEvent(new Event("change", { bubbles: true }));
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
    expect(dialog?.textContent).toContain(t["cancel.title"].replace("{name}", "#1001"));
    expect(dialog?.textContent).toContain(t["cancel.body"]);
    // Only stock-tracked units go back; nobody is told without an email on file.
    expect(dialog?.textContent).toContain(t["cancel.restock"].replace("{count}", "2"));
    expect(dialog?.textContent).not.toContain(t["cancel.notify"]);
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

  it("keeps Cancelled unavailable while units are with the courier, and says why", async () => {
    const partlySent = {
      ...order,
      status: "confirmed",
      items: [
        { id: "i1", quantity: 2, inventoryTracked: true, shippedQuantity: 1 },
        { id: "i2", quantity: 3, inventoryTracked: true, shippedQuantity: 2 },
      ],
    } as unknown as Order;
    await act(async () => root.render(<OrderStatusCard order={partlySent} />));
    const cancelled = await openOption(o["status.cancelled"]);
    expect(cancelled?.disabled).toBe(true);
    // The reason follows the greyed-out choice, in the API's words.
    expect(cancelled?.textContent).toBe(`${o["status.cancelled"]} — ${t["cancel.shippedMany"].replace("{count}", "3")}`);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("words one unit with the courier in the singular", async () => {
    const oneSent = { ...order, status: "confirmed", items: [{ id: "i1", quantity: 2, inventoryTracked: true, shippedQuantity: 1 }] } as unknown as Order;
    await act(async () => root.render(<OrderStatusCard order={oneSent} />));
    expect((await openOption(o["status.cancelled"]))?.textContent)
      .toContain("1 item is with the courier. Cancel after it comes back.");
  });

  it("links a part-sent order's blocked cancel to the parcel action it names", async () => {
    const partSent = { ...order, status: "confirmed", items: [{ id: "i1", quantity: 2, inventoryTracked: true, shippedQuantity: 1 }] } as unknown as Order;
    await act(async () => root.render(<OrderStatusCard order={partSent} />));
    const link = host.querySelector<HTMLAnchorElement>('a[href="#order-shipments"]');
    expect(link?.textContent).toBe(t["shipments.cameBack"]);
    expect(link?.parentElement?.textContent).toContain(t["cancel.shippedOne"].replace("{count}", "1"));
  });

  it("points a shipped cash order's blocked cancel at Mark returned", async () => {
    const shipped = {
      ...order, status: "shipped", paymentMethod: "cod", items: [{ id: "i1", quantity: 2, inventoryTracked: true, shippedQuantity: 2 }],
    } as unknown as Order;
    await act(async () => root.render(<OrderStatusCard order={shipped} />));
    expect(host.querySelector('a[href="#order-payment"]')?.textContent).toBe(t["cod.markReturned"]);
  });

  it("shows a paid order's Cancelled as unavailable with the refund reason", async () => {
    const paid = { ...order, status: "confirmed", paymentMethod: "stripe", paymentStatus: "paid", paidAmount: 1800, balanceDue: 0 } as unknown as Order;
    await act(async () => root.render(<OrderStatusCard order={paid} />));
    const cancelled = await openOption(o["status.cancelled"]);
    expect(cancelled?.disabled).toBe(true);
    expect(cancelled?.textContent).toContain(t["status.refundToCancel"]);
  });

  it("never offers Shipped or Delivered: those come from sending and delivering (R3-ORD-01)", async () => {
    const confirmed = { ...order, status: "confirmed" } as unknown as Order;
    await act(async () => root.render(<OrderStatusCard order={confirmed} />));
    const labels = [...(statusSelect()?.options ?? [])].map((option) => option.textContent);
    expect(labels).toEqual([o["status.confirmed"], o["status.cancelled"]]);
  });

  it("lets a Shipped order with nothing actually sent be cancelled", async () => {
    const stuck = { ...order, status: "shipped" } as unknown as Order;
    await act(async () => root.render(<OrderStatusCard order={stuck} />));
    const labels = [...(statusSelect()?.options ?? [])].map((option) => option.textContent);
    expect(labels).toEqual([o["status.shipped"], o["status.cancelled"]]);
    await chooseStatus(o["status.cancelled"]);
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(t["cancel.restock"].replace("{count}", "2"));
  });

  it("says to collect the cash before a delivered cash order can be Completed", async () => {
    const delivered = {
      ...order, status: "delivered", paymentMethod: "cod", paymentStatus: "unpaid", paidAmount: 0, balanceDue: 1800,
      items: [{ id: "i1", quantity: 2, inventoryTracked: true, shippedQuantity: 2 }],
    } as unknown as Order;
    await act(async () => root.render(<OrderStatusCard order={delivered} />));
    const completed = await openOption(o["status.completed"]);
    expect(completed?.disabled).toBe(true);
    expect(completed?.textContent).toContain(t["statusBlock.cashFirst"]);
  });

  it("asks before confirming an order the customer asked to cancel", async () => {
    const requested = {
      ...order,
      supportRequests: [{ id: "req_1", type: "cancel_pre_shipment", active: true, status: "submitted" }],
    } as unknown as Order;
    await act(async () => root.render(<OrderStatusCard order={requested} />));
    await chooseStatus(o["status.confirmed"]);
    expect(mocks.mutate).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain(t["cancelRequest.confirm"]);

    const confirm = [...dialog!.querySelectorAll("button")].find((button) => button.textContent === t["primary.confirm"]);
    await act(async () => confirm?.click());
    expect(mocks.mutate).toHaveBeenCalledWith({ orderId: "ord_1001", status: "confirmed" });
  });

  it("shows a final status as plain text, not a menu", async () => {
    await act(async () => root.render(<OrderStatusCard order={{ ...order, status: "cancelled" }} />));
    expect(host.querySelector(`[aria-label="${t["status.title"]}"]`)).toBeNull();
    expect(host.textContent).toContain(o["status.cancelled"]);
    expect(host.textContent).toContain(t["status.cancelledFinal"]);
  });
});
