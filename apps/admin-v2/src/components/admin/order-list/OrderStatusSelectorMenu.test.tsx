// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { orderListMessages } from "~/i18n/order-list";
import { orderMessages } from "~/i18n/orders";
import type { AdminOrderStatusFacts } from "~/lib/admin-order-status-policy";
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

  async function open(status: string, facts: AdminOrderStatusFacts) {
    await act(async () => root.render(
      <OrderStatusSelectorMenu
        status={status}
        facts={facts}
        open
        onOpenChange={() => undefined}
        onStatusUpdate={onStatusUpdate}
        trigger={<button type="button">Status</button>}
      />,
    ));
    return (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
      .find((item) => item.textContent?.startsWith(label));
  }

  it("keeps Cancelled in the menu for a part-sent order, greyed out with the reason", async () => {
    const item = await open("confirmed", { paymentStatus: "unpaid", paidAmount: 0, fulfillmentStatus: "partial" });
    const cancelled = item(o["status.cancelled"]);
    expect(cancelled?.getAttribute("aria-disabled")).toBe("true");
    expect(cancelled?.textContent).toBe(`${o["status.cancelled"]}${l["statusBlock.withCourier"]}`);
    expect(item(o["status.shipped"])?.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("says a paid order is cancelled through a refund", async () => {
    const item = await open("confirmed", { paymentStatus: "paid", paidAmount: 1800, fulfillmentStatus: "pending" });
    expect(item(o["status.cancelled"])?.textContent).toContain(l.cancelNeedsRefund);
  });

  it("says to collect the cash before Delivered", async () => {
    const item = await open("shipped", { paymentMethod: "cod", paymentStatus: "unpaid", paidAmount: 0, balanceDue: 1800 });
    expect(item(o["status.delivered"])?.textContent).toContain(l["statusBlock.cashFirst"]);
  });
});
