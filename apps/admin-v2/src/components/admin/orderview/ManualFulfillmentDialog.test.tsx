// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { orderDetailMessages } from "~/i18n/order-detail";
import type { Order } from "./types";
import { ManualFulfillmentDialog } from "./ManualFulfillmentDialog";

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), canUpdateCod: true }));
vi.mock("~/lib/api-mutations/orders", () => ({
  orderErrorMessage: (error: Error) => error.message,
  useCreateFulfillment: () => ({ mutate: mocks.mutate, reset: vi.fn(), isPending: false, isError: false }),
}));
vi.mock("~/hooks/use-order-action-permissions", () => ({
  useOrderActionPermissions: () => ({ canUpdateOrderCod: mocks.canUpdateCod }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const en = orderDetailMessages.en;

const item = (id: string, name: string, quantity: number, fulfilledQuantity: number, fulfillmentType = "ship", extra = {}) => ({
  id, productId: `p_${id}`, variantId: null, quantity, fulfilledQuantity, fulfillmentType, price: 800,
  productName: name, productImage: null, variantLabel: null, fulfillmentStatus: "pending", ...extra,
});
const order = {
  id: "ord_1", status: "confirmed", currencyCode: "BDT",
  items: [item("i1", "Kurta", 3, 1), item("i2", "Scarf", 1, 1)],
} as unknown as Order;

/** A pickup order paid in cash at the counter, with an engraved lighter and a plain one. */
const pickupOrder = {
  id: "ord_2", status: "confirmed", currencyCode: "BDT", paymentMethod: "cod", balanceDue: 1200, requiresShipping: false,
  shippingMethodKind: "pickup",
  items: [
    item("p1", "Lighter", 2, 0, "pickup", {
      properties: [{ key: "engraving", type: "text", label: "Engraving", value: "Rahim", displayValue: "Rahim", price: 200, priceMinor: 20000 }],
    }),
    item("p2", "Setup visit", 1, 0, "service"),
  ],
} as unknown as Order;

function setValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ManualFulfillmentDialog", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canUpdateCod = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  const button = (label: string) => [...document.querySelectorAll("button")].find((element) => element.textContent === label)!;
  const submit = () => button(en["fulfill.submit"]);
  const quantity = (name: string, key: "fulfill.quantity" | "pickup.quantity" | "service.quantity" = "fulfill.quantity") =>
    document.querySelector<HTMLInputElement>(`input[aria-label="${en[key].replace("{name}", name)}"]`);

  describe("ship: own rider", () => {
    it("defaults each line to what is left and sends part of a line", async () => {
      await act(async () => root.render(<ManualFulfillmentDialog order={order} open onOpenChange={() => undefined} />));
      expect(quantity("Kurta")?.value).toBe("2");
      expect(quantity("Scarf")).toBeNull();

      await act(async () => setValue(quantity("Kurta")!, "1"));
      await act(async () => submit().click());
      const [payload] = mocks.mutate.mock.calls[0]!;
      expect(payload).toMatchObject({ orderId: "ord_1", kind: "ship", lines: [{ itemId: "i1", quantity: 1 }] });
      expect(payload.requestKey).toEqual(expect.any(String));
      expect(payload.cashReceived).toBeUndefined();
    });

    it("reads a quantity and delivery cost typed in Bangla digits", async () => {
      await act(async () => root.render(<ManualFulfillmentDialog order={order} open onOpenChange={() => undefined} />));
      await act(async () => setValue(quantity("Kurta")!, "১"));
      await act(async () => setValue(document.querySelector<HTMLInputElement>("#fulfill-amount")!, "৬০"));
      await act(async () => submit().click());
      const [payload] = mocks.mutate.mock.calls[0]!;
      expect(payload.lines).toEqual([{ itemId: "i1", quantity: 1 }]);
      expect(payload.tracking.shipmentAmount).toBe(60);
    });

    it("repeats the same request key on a second click so the server replays the first fulfilment", async () => {
      await act(async () => root.render(<ManualFulfillmentDialog order={order} open onOpenChange={() => undefined} />));
      await act(async () => submit().click());
      await act(async () => submit().click());
      const [first, second] = mocks.mutate.mock.calls.map(([payload]) => payload);
      expect(second.requestKey).toBe(first.requestKey);
    });

    it("gives a reopened dialog a new request key", async () => {
      await act(async () => root.render(<ManualFulfillmentDialog order={order} open onOpenChange={() => undefined} />));
      await act(async () => submit().click());
      await act(async () => root.render(<ManualFulfillmentDialog order={order} open={false} onOpenChange={() => undefined} />));
      await act(async () => root.render(<ManualFulfillmentDialog order={order} open onOpenChange={() => undefined} />));
      await act(async () => submit().click());
      const [first, second] = mocks.mutate.mock.calls.map(([payload]) => payload);
      expect(second.requestKey).not.toBe(first.requestKey);
    });

    it("leaves the courier name to the merchant: blank means your own rider", async () => {
      await act(async () => root.render(<ManualFulfillmentDialog order={order} open onOpenChange={() => undefined} />));
      const courier = document.querySelector<HTMLInputElement>("#fulfill-courier")!;
      expect(courier.value).toBe("");
      expect(courier.placeholder).toBe(en["fulfill.defaultCourier"]);
      await act(async () => submit().click());
      expect(mocks.mutate.mock.calls[0]![0].tracking).toBeUndefined();

      await act(async () => setValue(courier, "Rider Jamal"));
      await act(async () => submit().click());
      expect(mocks.mutate.mock.calls[1]![0].tracking).toEqual({ courierName: "Rider Jamal" });
    });

    it("clears a field's error as soon as it's corrected", async () => {
      await act(async () => root.render(<ManualFulfillmentDialog order={order} open onOpenChange={() => undefined} />));
      await act(async () => setValue(quantity("Kurta")!, "0"));
      await act(async () => submit().click());
      expect(document.querySelector("#fulfill-items-error")?.textContent).toBe(en["fulfill.selectItem"]);

      await act(async () => setValue(quantity("Kurta")!, "2"));
      expect(document.querySelector("#fulfill-items-error")).toBeNull();
    });

    it("flags a tracking link that isn't a full https address next to the field", async () => {
      await act(async () => root.render(<ManualFulfillmentDialog order={order} open onOpenChange={() => undefined} />));
      await act(async () => setValue(document.querySelector<HTMLInputElement>("#fulfill-trackingUrl")!, "not a url"));
      await act(async () => submit().click());
      expect(mocks.mutate).not.toHaveBeenCalled();
      expect(document.querySelector("#fulfill-trackingUrl-error")?.textContent).toBe(en["fulfill.trackingUrlInvalid"]);
    });
  });

  describe("pickup: at the counter", () => {
    it("hands over only pickup lines, shows their buyer inputs, and records the cash taken", async () => {
      await act(async () => root.render(<ManualFulfillmentDialog order={pickupOrder} kind="pickup" open onOpenChange={() => undefined} />));
      expect(document.body.textContent).toContain(en["pickup.title"]);
      expect(quantity("Lighter", "pickup.quantity")?.value).toBe("2");
      expect(quantity("Setup visit", "service.quantity")).toBeNull();
      expect(document.querySelector("#fulfill-courier")).toBeNull();
      expect(document.body.textContent).toContain("Engraving: Rahim (+৳200.00)");
      const cash = document.querySelector<HTMLButtonElement>("#fulfill-cash")!;
      expect(cash.getAttribute("aria-checked")).toBe("true");

      await act(async () => button(en["pickup.submit"]).click());
      expect(mocks.mutate.mock.calls[0]![0]).toMatchObject({
        orderId: "ord_2", kind: "pickup", lines: [{ itemId: "p1", quantity: 2 }], cashReceived: 1200,
      });
    });

    it("leaves the cash for later when the box is cleared", async () => {
      await act(async () => root.render(<ManualFulfillmentDialog order={pickupOrder} kind="pickup" open onOpenChange={() => undefined} />));
      await act(async () => document.querySelector<HTMLButtonElement>("#fulfill-cash")!.click());
      expect(document.body.textContent).toContain(en["handover.cashLaterHelp"]);
      await act(async () => button(en["pickup.submit"]).click());
      expect(mocks.mutate.mock.calls[0]![0].cashReceived).toBeUndefined();
    });

    it("offers no cash field to staff who can't record cash", async () => {
      mocks.canUpdateCod = false;
      await act(async () => root.render(<ManualFulfillmentDialog order={pickupOrder} kind="pickup" open onOpenChange={() => undefined} />));
      expect(document.querySelector("#fulfill-cash")).toBeNull();
    });
  });

  describe("service: Mark as done", () => {
    it("marks the service lines done with their quantities", async () => {
      await act(async () => root.render(<ManualFulfillmentDialog order={pickupOrder} kind="service" open onOpenChange={() => undefined} />));
      expect(quantity("Setup visit", "service.quantity")?.value).toBe("1");
      expect(quantity("Lighter", "pickup.quantity")).toBeNull();
      await act(async () => button(en["service.submit"]).click());
      expect(mocks.mutate.mock.calls[0]![0]).toMatchObject({ kind: "service", lines: [{ itemId: "p2", quantity: 1 }], cashReceived: 1200 });
    });
  });
});
