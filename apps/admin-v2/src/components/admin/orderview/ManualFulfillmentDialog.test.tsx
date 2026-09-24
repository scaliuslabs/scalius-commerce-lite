// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { orderDetailMessages } from "~/i18n/order-detail";
import type { Order } from "./types";
import { ManualFulfillmentDialog } from "./ManualFulfillmentDialog";

const mocks = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("~/lib/api-mutations/orders", () => ({
  orderErrorMessage: (error: Error) => error.message,
  useCreateFulfillmentShipment: () => ({ mutate: mocks.mutate, reset: vi.fn(), isPending: false, isError: false }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const en = orderDetailMessages.en;

const item = (id: string, name: string, quantity: number, shippedQuantity: number) => ({
  id, productId: `p_${id}`, variantId: null, quantity, shippedQuantity, price: 800,
  productName: name, productImage: null, variantLabel: null, fulfillmentStatus: "pending",
});
const order = {
  id: "ord_1", status: "confirmed",
  items: [item("i1", "Kurta", 3, 1), item("i2", "Scarf", 1, 1)],
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
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  const submit = () => [...document.querySelectorAll("button")].find((button) => button.textContent === en["fulfill.submit"])!;
  const quantity = (name: string) =>
    document.querySelector<HTMLInputElement>(`input[aria-label="${en["fulfill.quantity"].replace("{name}", name)}"]`);

  it("defaults each line to what is left and sends part of a line", async () => {
    await act(async () => root.render(<ManualFulfillmentDialog order={order} open onOpenChange={() => undefined} />));
    expect(quantity("Kurta")?.value).toBe("2");
    expect(quantity("Scarf")).toBeNull();

    await act(async () => setValue(quantity("Kurta")!, "1"));
    await act(async () => submit().click());
    const [payload] = mocks.mutate.mock.calls[0]!;
    expect(payload.items).toEqual([{ itemId: "i1", quantity: 1 }]);
    expect(payload.requestKey).toEqual(expect.any(String));
  });

  it("reads a quantity and delivery cost typed in Bangla digits", async () => {
    await act(async () => root.render(<ManualFulfillmentDialog order={order} open onOpenChange={() => undefined} />));
    await act(async () => setValue(quantity("Kurta")!, "\u09e7"));
    await act(async () => setValue(document.querySelector<HTMLInputElement>("#fulfill-amount")!, "\u09ec\u09e6"));
    await act(async () => submit().click());
    const [payload] = mocks.mutate.mock.calls[0]!;
    expect(payload.items).toEqual([{ itemId: "i1", quantity: 1 }]);
    expect(payload.shipmentAmount).toBe(60);
  });

  it("repeats the same request key on a second click so the server replays the first shipment", async () => {
    await act(async () => root.render(<ManualFulfillmentDialog order={order} open onOpenChange={() => undefined} />));
    await act(async () => submit().click());
    await act(async () => submit().click());
    const [first, second] = mocks.mutate.mock.calls.map(([payload]) => payload);
    expect(second.requestKey).toBe(first.requestKey);
  });

  it("leaves the courier name to the merchant: blank means your own rider", async () => {
    await act(async () => root.render(<ManualFulfillmentDialog order={order} open onOpenChange={() => undefined} />));
    const courier = document.querySelector<HTMLInputElement>("#fulfill-courier")!;
    expect(courier.value).toBe("");
    expect(courier.placeholder).toBe(en["fulfill.defaultCourier"]);
    await act(async () => submit().click());
    expect(mocks.mutate.mock.calls[0]![0].courierName).toBeUndefined();

    await act(async () => setValue(courier, "Rider Jamal"));
    await act(async () => submit().click());
    expect(mocks.mutate.mock.calls[1]![0].courierName).toBe("Rider Jamal");
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
