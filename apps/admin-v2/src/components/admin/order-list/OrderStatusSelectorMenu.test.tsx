// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { orderListMessages } from "~/i18n/order-list";
import { orderMessages } from "~/i18n/orders";
import type { AdminOrderStatusFacts } from "~/lib/admin-order-status-policy";
import { rowClickHandler } from "~/components/admin/data-table/DataTableBodyRow";
import { OrderStatusSelectorMenu } from "./OrderStatusSelectorMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const l = orderListMessages.en;
const o = orderMessages.en;

describe("OrderStatusSelectorMenu", () => {
  let host: HTMLDivElement;
  let root: Root;
  const onStatusUpdate = vi.fn();

  beforeEach(() => {
    onStatusUpdate.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  async function open(status: string, facts: AdminOrderStatusFacts, onRowOpen = vi.fn()) {
    // The menu sits in a clickable table row, as in the order list.
    await act(async () => root.render(
      <div onClick={rowClickHandler(onRowOpen)}>
        <OrderStatusSelectorMenu
          status={status}
          facts={facts}
          open
          onOpenChange={() => undefined}
          onStatusUpdate={onStatusUpdate}
          trigger={<button type="button">Status</button>}
        />
      </div>,
    ));
    return (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
      .find((item) => item.textContent?.startsWith(label));
  }

  const labels = () => [...document.querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent);

  it("offers only the changes without side effects: Confirmed and Cancelled for a new order", async () => {
    await open("pending", { paymentStatus: "unpaid", paidAmount: 0, fulfillmentStatus: "pending" });
    expect(labels()).toEqual([o["status.confirmed"], o["status.cancelled"]]);
  });

  it("acts in place: choosing a status never opens the order", async () => {
    const onRowOpen = vi.fn();
    const item = await open("pending", { paymentStatus: "unpaid", paidAmount: 0, fulfillmentStatus: "pending" }, onRowOpen);
    const confirmed = item(o["status.confirmed"])!;
    await act(async () => {
      confirmed.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      confirmed.click();
    });
    expect(onStatusUpdate).toHaveBeenCalledWith("confirmed");

    await act(async () => {
      item(o["status.cancelled"])!.click();
    });
    expect(onStatusUpdate).toHaveBeenLastCalledWith("cancelled");

    await act(async () => {
      item(o["status.cancelled"])!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onRowOpen).not.toHaveBeenCalled();
  });

  it("keeps Cancelled in the menu for a part-sent order, greyed out with the reason", async () => {
    const item = await open("confirmed", { paymentStatus: "unpaid", paidAmount: 0, fulfillmentStatus: "partial" });
    const cancelled = item(o["status.cancelled"]);
    expect(cancelled?.getAttribute("aria-disabled")).toBe("true");
    expect(cancelled?.textContent).toBe(`${o["status.cancelled"]}${l["statusBlock.withCourier"]}`);
    expect(labels()).toHaveLength(1);
  });

  it("says a paid order is cancelled through a refund", async () => {
    const item = await open("confirmed", { paymentStatus: "paid", paidAmount: 1800, fulfillmentStatus: "pending" });
    expect(item(o["status.cancelled"])?.textContent).toContain(l.cancelNeedsRefund);
  });

  it("says to collect the cash before Completed", async () => {
    const item = await open("delivered", { paymentMethod: "cod", paymentStatus: "unpaid", paidAmount: 0, balanceDue: 1800 });
    expect(item(o["status.completed"])?.textContent).toContain(l["statusBlock.cashFirst"]);
  });
});
