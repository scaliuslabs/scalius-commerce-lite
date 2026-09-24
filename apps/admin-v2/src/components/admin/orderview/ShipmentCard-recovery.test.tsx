// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Order, ShipmentRecovery } from "./types";
import { ShipmentCard } from "./ShipmentCard";
import { orderDetailMessages } from "~/i18n/order-detail";

const en = orderDetailMessages.en;

const mocks = vi.hoisted(() => ({ canManage: true, repair: vi.fn() }));
vi.mock("~/hooks/use-order-action-permissions", () => ({
  useOrderActionPermissions: () => ({ canManageOrderShipments: mocks.canManage }),
}));
vi.mock("~/lib/api-mutations/orders", () => ({
  orderErrorMessage: (error: Error) => error.message,
  useCreateOrderShipment: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false }),
  useReconcileShipment: () => ({ mutate: mocks.repair, reset: vi.fn(), isPending: false }),
  useLookupUnknownShipment: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false }),
  useResolveUnknownShipment: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false }),
}));
vi.mock("./ManualFulfillmentDialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ManualFulfillmentDialog")>()),
  ManualFulfillmentDialog: () => null,
}));
vi.mock("~/components/admin/ShipmentStatusIndicator", () => ({ default: () => null }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="/admin/settings/shipping">{children}</a>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const order: Order = {
  id: "order_shipment", version: 1, customerName: "Test buyer", customerPhone: "+8801700000000",
  customerEmail: null, shippingAddress: "Test address", city: "Dhaka", zone: "Central Road",
  area: null, notes: null, discountAmount: 0, shippingCharge: 0, status: "confirmed",
  createdAt: 1_783_000_000, updatedAt: 1_783_000_000, items: [], totalAmount: 1800,
  customerId: null, paymentMethod: "cod", paymentStatus: "unpaid", paidAmount: 0,
  balanceDue: 1800, orderNumber: 1001, archivedAt: null, discounts: [], refundDue: 0, refundedAmount: 0,
  editReadiness: { items: { allowed: false, reason: "closed" }, details: { allowed: false, reason: "closed" } },
};
const recovery: ShipmentRecovery = {
  state: "needs_attention", severity: "danger", activeLock: true,
  label: "Courier confirmation needed",
  message: "Check the courier portal or contact the courier with this order number before attempting another booking.",
  shipmentId: "shipment_unknown", status: "reconcile_required", providerType: "pathao",
  canRepair: false, canRefresh: false, canRetryCreate: false, unknownOutcome: true, updatedAt: null,
};

describe("ShipmentCard recovery authority", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canManage = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    act(() => root.unmount());
    client.clear();
    host.remove();
  });

  async function render(overrides: Partial<Order> = {}) {
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <ShipmentCard order={{ ...order, shipmentRecovery: recovery, ...overrides }} />
      </QueryClientProvider>,
    ));
  }

  function repairButton() {
    return Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === en["shipments.repair"]);
  }

  it.each(["ready", "loading", "unavailable", "stale"] as const)(
    "does not infer repair from %s history when the server requires courier confirmation",
    async (status) => {
      await render({ operationalReads: {
        shipments: { status, refreshing: false },
        deliveryProviders: { status: "ready", refreshing: false },
      } });
      expect(host.textContent).toContain("Courier confirmation needed");
      expect(host.textContent).toContain(recovery.message);
      expect(host.textContent).toContain(en["courier.checkTitle"]);
      expect(repairButton()).toBeUndefined();
      expect(mocks.repair).not.toHaveBeenCalled();
    },
  );

  it("retains the authorized repair action for incomplete local finalization", async () => {
    await render({ shipmentRecovery: { ...recovery, canRepair: true, label: "Shipment needs reconciliation" } });
    expect(repairButton()).toBeDefined();
    await act(async () => repairButton()!.click());
    expect(mocks.repair).toHaveBeenCalledExactlyOnceWith({ orderId: order.id, shipmentId: recovery.shipmentId });
  });

  it("requires merchant shipment permission even when the server allows repair", async () => {
    mocks.canManage = false;
    await render({ shipmentRecovery: { ...recovery, canRepair: true } });
    expect(repairButton()).toBeUndefined();
    expect(mocks.repair).not.toHaveBeenCalled();
  });

  it("hides new shipment actions after fulfillment is complete while retaining history", async () => {
    await render({
      fulfillmentStatus: "complete",
      items: [{
        id: "item_shipment",
        productId: "product_shipment",
        variantId: null,
        quantity: 1,
        price: 1800,
        productName: "Test product",
        productImage: null,
        variantLabel: null,
      }],
      shipments: [],
    });

    expect(host.textContent).toContain(en["shipments.empty"]);
    expect(host.textContent).not.toContain(en["shipments.book"]);
    expect(host.textContent).not.toContain(en["fulfill.open"]);
  });

  it("offers your own rider for what is left to send", async () => {
    await render({
      shipmentRecovery: undefined,
      items: [{
        id: "item_shipment", productId: "product_shipment", variantId: null, quantity: 3, shippedQuantity: 1,
        price: 600, productName: "Kurta", productImage: null, variantLabel: null,
      }],
      shipments: [],
    });
    expect(host.textContent).toContain(en["fulfill.open"]);
  });
});
