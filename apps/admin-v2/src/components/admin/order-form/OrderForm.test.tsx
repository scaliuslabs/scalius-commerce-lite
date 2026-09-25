// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  preview: vi.fn(),
  quote: vi.fn(),
  create: vi.fn(),
  confirm: vi.fn(),
  navigate: vi.fn(),
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: state.toast }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("@/lib/api", () => ({ apiData: (value: unknown) => value }));
vi.mock("@scalius/api-client/sdk", () => ({
  postApiV1AdminOrdersQuote: state.quote,
  postApiV1AdminOrdersByIdAmendmentsPreview: state.preview,
}));
vi.mock("@/lib/api-mutations/orders", () => ({
  orderErrorMessage: () => "Couldn't reach the server.",
  useCreateOrder: () => ({ mutateAsync: state.create, isPending: false }),
  // isPending never flips here: only the form's own guard can stop a second click.
  useConfirmManualOrderAmendment: () => ({
    mutateAsync: state.confirm,
    isPending: false,
    error: null,
    reset: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-debounce", () => ({ useDebounce: <T,>(value: T) => value }));
vi.mock("@/hooks/use-currency", () => ({
  useCurrency: () => ({ code: "BDT", fmt: (n: number) => `৳${n.toLocaleString("en-IN")}` }),
}));
vi.mock("@/hooks/use-order-action-permissions", () => ({
  useOrderActionPermissions: () => ({ canEditOrders: true, canCreateOrders: true }),
}));
vi.mock("@/components/admin/resource/PageHeader", () => ({ PageHeader: () => null }));
vi.mock("../shared/UnsavedChangesGuard", () => ({ UnsavedChangesGuard: () => null }));
vi.mock("./OrderItemsSection", () => ({ OrderItemsSection: () => null }));
vi.mock("./SummarySection", () => ({ SummarySection: () => null }));
// The customer card, reduced to two fields wired like the real ones.
vi.mock("./CustomerInfoSection", async () => {
  const { useController } = await import("react-hook-form");
  function CustomerInfoSection() {
    const name = useController({ name: "customerName" });
    const notes = useController({ name: "notes" });
    return (
      <>
        <input aria-label="Name" value={name.field.value ?? ""} onChange={name.field.onChange} />
        <textarea
          aria-label="Notes"
          value={notes.field.value || ""}
          onChange={(e) => notes.field.onChange(e.target.value || null)}
        />
      </>
    );
  }
  return { CustomerInfoSection, ORDER_LOCATION_IDS: { city: "order-city", zone: "order-zone", area: "order-area" } };
});
vi.mock("./ProductSearch", () => ({ PRODUCT_SEARCH_INPUT_ID: "order-product-search" }));

import { OrderForm } from "../OrderForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const order = {
  id: "ord_1",
  version: 3,
  customerName: "Karim Ahmed",
  customerPhone: "+8801712345678",
  customerEmail: null,
  shippingAddress: "Road 2, Mirpur 10, Dhaka",
  city: "c1",
  zone: "z1",
  area: null,
  notes: null,
  discountAmount: null,
  shippingCharge: 70,
  items: [{ orderItemId: "item_1", productId: "p1", variantId: "v1", quantity: 2, price: 1150 }],
};

const buttonNamed = (name: string) =>
  Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent === name);
const field = (label: string) =>
  document.body.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
const saveBar = () => document.body.querySelector("[data-save-bar]");

async function type(label: string, value: string) {
  const element = field(label);
  const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!;
  await act(async () => {
    setValue.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(name: string) {
  await act(async () => buttonNamed(name)!.click());
  await act(async () => {});
}

describe("edit order on the save bar", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    state.preview.mockReset().mockResolvedValue({
      subtotalAmount: 3500, shippingAmount: 70, discountAmount: 0, taxAmount: 0, totalAmount: 3570,
      balanceDue: 3570, quoteFingerprint: "f".repeat(64), lines: [],
    });
    state.confirm.mockReset().mockReturnValue(new Promise(() => {}));
    state.navigate.mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(
      <QueryClientProvider client={new QueryClient()}>
        <OrderForm mode="amend" defaultValues={order} orderLabel="#1001" cashToCollect={2370} />
      </QueryClientProvider>,
    ));
    // Let the amendment quote settle (a query, then its render).
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    await act(async () => {});
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("shows the bar only while the order differs from the saved one", async () => {
    expect(saveBar()).toBeNull();
    await type("Notes", "Call before delivery");
    expect(saveBar()?.textContent).toContain("Unsaved changes");
    // Undoing the note is no change at all.
    await type("Notes", "");
    expect(saveBar()).toBeNull();
  });

  it("discards back to the loaded order exactly", async () => {
    await type("Name", "Rahim Uddin");
    await type("Notes", "Leave at the gate");
    await click("Discard");
    await click("Discard changes");
    expect(saveBar()).toBeNull();
    expect(field("Name").value).toBe("Karim Ahmed");
    expect(field("Notes").value).toBe("");
  });

  it("reviews the cash change from the bar's Save and sends one save for a double click", async () => {
    await type("Notes", "Call before delivery");
    await click("Save");

    expect(document.body.textContent).toContain("Save changes to order #1001?");
    expect(document.body.textContent).toContain("Cash to collect ৳2,370 → ৳3,570");

    const save = buttonNamed("Save changes")!;
    await act(async () => {
      save.click();
      save.click();
    });
    expect(state.confirm).toHaveBeenCalledTimes(1);
    expect(state.confirm).toHaveBeenCalledWith(expect.objectContaining({
      id: "ord_1",
      expectedVersion: 3,
      notes: "Call before delivery",
      quoteFingerprint: "f".repeat(64),
    }));
    // The dialog never asks for a fresh preview.
    expect(state.preview).toHaveBeenCalledTimes(1);
  });

  it("keeps the edits and the bar, without an error, when the review is cancelled", async () => {
    await type("Notes", "Call before delivery");
    await click("Save");
    await click("Cancel");
    expect(document.body.textContent).not.toContain("Save changes to order #1001?");
    expect(saveBar()?.textContent).toContain("Unsaved changes");
    expect(document.body.textContent).not.toContain("Couldn't save");
    expect(field("Notes").value).toBe("Call before delivery");
    expect(state.confirm).not.toHaveBeenCalled();
  });

  it("saves and leaves once the review is confirmed", async () => {
    state.confirm.mockResolvedValue({ id: "ord_1" });
    await type("Notes", "Call before delivery");
    await click("Save");
    await click("Save changes");
    expect(state.navigate).toHaveBeenCalledWith({ to: "/admin/orders/$orderId", params: { orderId: "ord_1" } });
    expect(state.toast.success).toHaveBeenCalledTimes(1);
    expect(state.toast.success).toHaveBeenCalledWith("Order updated");
  });
});

describe("create order on the save bar", () => {
  let host: HTMLDivElement;
  let root: Root;

  const quote = {
    subtotalAmount: 1350, shippingAmount: 0, discountAmount: 0, taxAmount: 0, totalAmount: 1350,
    balanceDue: 1350, lines: [],
  };
  /** A pickup order for an engraved lighter: typed by staff at the counter. */
  const pickup = {
    customerName: "Karim Ahmed",
    customerPhone: "01712345678",
    customerEmail: null,
    shippingAddress: "",
    city: "",
    zone: "",
    area: null,
    notes: null,
    discountAmount: null,
    shippingCharge: 0,
    shippingMethodId: "rate_counter",
    shippingMethodKind: "pickup" as const,
    items: [{
      productId: "p_lighter", variantId: "v_lighter", quantity: 1, price: 1350, fulfillmentKind: "physical" as const,
      properties: [{ key: "engraving", value: "Rahim" }],
      propertiesDisplay: [{ key: "engraving", type: "text" as const, label: "Engraving", value: "Rahim", displayValue: "Rahim", priceMinor: 20000 }],
    }],
  };

  async function renderCreate(defaultValues: Record<string, unknown>) {
    await act(async () => root.render(
      <QueryClientProvider client={new QueryClient()}>
        <OrderForm mode="create" defaultValues={defaultValues} />
      </QueryClientProvider>,
    ));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    await act(async () => {});
  }

  beforeEach(() => {
    state.quote.mockReset().mockResolvedValue(quote);
    state.create.mockReset().mockResolvedValue({ id: "ord_new" });
    state.navigate.mockReset();
    state.toast.success.mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("names the new order in the bar, then creates a pickup order with the line's buyer inputs and no address", async () => {
    await renderCreate(pickup);
    // No city or zone: the pickup method is enough to price it.
    expect(state.quote).toHaveBeenCalledWith({ body: expect.objectContaining({
      city: null, zone: null, shippingMethodId: "rate_counter",
      items: [expect.objectContaining({ properties: [{ key: "engraving", value: "Rahim" }] })],
    }) });

    await type("Notes", "Engrave before pickup");
    expect(saveBar()?.textContent).toContain("Unsaved order");
    await click("Save");
    expect(state.create).toHaveBeenCalledTimes(1);
    const [body] = state.create.mock.calls[0]!;
    expect(body).toMatchObject({
      shippingAddress: null, city: null, zone: null, area: null, shippingMethodId: "rate_counter",
      notes: "Engrave before pickup",
      items: [{ productId: "p_lighter", variantId: "v_lighter", quantity: 1, properties: [{ key: "engraving", value: "Rahim" }] }],
    });
    // Display-only fields never leave the form.
    expect(body.items[0]).not.toHaveProperty("propertiesDisplay");
    expect(body.items[0]).not.toHaveProperty("fulfillmentKind");
    expect(state.navigate).toHaveBeenCalledWith({ to: "/admin/orders/$orderId", params: { orderId: "ord_new" } });
    expect(state.toast.success).toHaveBeenCalledWith("Order created");
  });

  it("still asks an address for a delivered order and keeps the bar", async () => {
    await renderCreate({ ...pickup, shippingMethodId: null, shippingMethodKind: null });
    expect(state.quote).not.toHaveBeenCalled();
    await type("Notes", "Deliver after 5pm");
    await click("Save");
    expect(state.create).not.toHaveBeenCalled();
    expect(saveBar()).not.toBeNull();
  });

  it("keeps the bar and the details with an error when the order can't be created", async () => {
    state.create.mockRejectedValue(new Error("Only 1 of that item is left."));
    await renderCreate(pickup);
    await type("Notes", "Engrave before pickup");
    await click("Save");
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(state.navigate).not.toHaveBeenCalled();
    expect(saveBar()).not.toBeNull();
    expect(document.body.textContent).toContain("Couldn't save your changes");
    expect(document.body.textContent).toContain("Only 1 of that item is left.");
    expect(field("Notes").value).toBe("Engrave before pickup");
    expect(state.toast.success).not.toHaveBeenCalled();
  });

  it("creates an order of services with no delivery method and no address", async () => {
    await renderCreate({
      ...pickup,
      shippingMethodId: null,
      shippingMethodKind: null,
      items: [{ productId: "p_setup", variantId: "v_setup", quantity: 1, price: 1500, fulfillmentKind: "service" as const }],
    });
    expect(state.quote).toHaveBeenCalledWith({ body: expect.objectContaining({ city: null, zone: null }) });
    await type("Notes", "Set up on Friday");
    await click("Save");
    expect(state.create.mock.calls[0]![0]).toMatchObject({ shippingAddress: null, city: null, zone: null });
    expect(state.create.mock.calls[0]![0]).not.toHaveProperty("shippingMethodId");
  });
});
