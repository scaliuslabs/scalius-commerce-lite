// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  preview: vi.fn(),
  confirm: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("@/lib/api", () => ({ apiData: (value: unknown) => value }));
vi.mock("@scalius/api-client/sdk", () => ({
  postApiV1AdminOrdersQuote: vi.fn(),
  postApiV1AdminOrdersByIdAmendmentsPreview: state.preview,
}));
vi.mock("@/lib/api-mutations/orders", () => ({
  orderErrorMessage: () => "Couldn't reach the server.",
  useCreateOrder: () => ({ mutateAsync: vi.fn(), isPending: false }),
  // isPending never flips here: only the form's own guard can stop a second click.
  useConfirmManualOrderAmendment: () => ({
    mutateAsync: state.confirm,
    isPending: false,
    error: null,
    reset: vi.fn(),
  }),
}));
vi.mock("@/lib/api-query-options/delivery", () => ({
  deliveryLocationsQueryOptions: () => ({ queryKey: ["cities"], queryFn: async () => ({ locations: [] }) }),
  getDeliveryLocations: async () => ({ locations: [] }),
}));
vi.mock("@/hooks/use-debounce", () => ({ useDebounce: <T,>(value: T) => value }));
vi.mock("@/hooks/use-currency", () => ({
  useCurrency: () => ({ code: "BDT", fmt: (n: number) => `৳${n.toLocaleString("en-IN")}` }),
}));
vi.mock("@/hooks/use-order-action-permissions", () => ({
  useOrderActionPermissions: () => ({ canEditOrders: true, canCreateOrders: true }),
}));
vi.mock("@/components/admin/FormStickyHeader", () => ({
  FormActionBar: (props: { onSave: () => void; saveLabel: string; canSave: boolean }) => (
    <button type="button" disabled={!props.canSave} onClick={props.onSave}>{props.saveLabel}</button>
  ),
}));
vi.mock("@/components/admin/resource/PageHeader", () => ({ PageHeader: () => null }));
vi.mock("../shared/UnsavedChangesGuard", () => ({ UnsavedChangesGuard: () => null }));
vi.mock("./OrderItemsSection", () => ({ OrderItemsSection: () => null }));
vi.mock("./SummarySection", () => ({ SummarySection: () => null }));
vi.mock("./CustomerInfoSection", () => ({ CustomerInfoSection: () => null }));
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

describe("edit order review", () => {
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
    await act(async () => {});
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("shows the cash change and sends one save for a double click", async () => {
    expect(state.preview).toHaveBeenCalledTimes(1);
    await act(async () => buttonNamed("Review changes")!.click());
    await act(async () => {});

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
      quoteFingerprint: "f".repeat(64),
    }));
    // The dialog never asks for a fresh preview.
    expect(state.preview).toHaveBeenCalledTimes(1);
  });
});
