// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Order, ShipmentRecovery } from "./types";
import { ShipmentCard } from "./ShipmentCard";
import { orderDetailMessages } from "~/i18n/order-detail";
import { queryKeys } from "~/lib/query-keys";

const en = orderDetailMessages.en;

const mocks = vi.hoisted(() => ({ canManage: true, repair: vi.fn(), delivered: vi.fn() }));
vi.mock("~/hooks/use-order-action-permissions", () => ({
  useOrderActionPermissions: () => ({ canManageOrderShipments: mocks.canManage, canChangeOrderStatus: mocks.canManage }),
}));
vi.mock("~/lib/api-mutations/orders", () => ({
  orderErrorMessage: (error: Error) => error.message,
  useCreateOrderShipment: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false }),
  useMarkOrderDelivered: () => ({ mutate: mocks.delivered, isPending: false }),
  useReconcileShipment: () => ({ mutate: mocks.repair, reset: vi.fn(), isPending: false }),
  useLookupUnknownShipment: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false }),
  useResolveUnknownShipment: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false }),
}));
vi.mock("~/lib/api-query-options/orders", async () => {
  const { queryKeys: keys } = await import("~/lib/query-keys");
  return { orderCodQueryOptions: (id: string) => ({ queryKey: keys.orders.cod(id), queryFn: () => new Promise(() => undefined) }) };
});
vi.mock("~/components/admin/ShipmentStatusIndicator", () => ({
  default: ({ label }: { label?: string }) => (label ? <p data-testid="shipment-status">{label}</p> : null),
}));
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
  state: "needs_attention", reason: "courier_unconfirmed", severity: "danger", activeLock: true,
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
      expect(host.textContent).toContain(en["shipmentRecovery.courier_unconfirmed"]);
      expect(host.textContent).toContain(en["shipmentRecovery.courier_unconfirmed.help"]);
      expect(host.textContent).toContain(en["courier.checkTitle"]);
      expect(repairButton()).toBeUndefined();
      expect(mocks.repair).not.toHaveBeenCalled();
    },
  );

  it("retains the authorized repair action for incomplete local finalization", async () => {
    await render({ shipmentRecovery: { ...recovery, reason: "reconcile_required", canRepair: true } });
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
    expect(host.textContent).not.toContain(en["fulfill.submit"]);
  });

  it("lists what each parcel holds", async () => {
    const line = (id: string, productName: string, quantity: number) => ({
      id, productId: `p_${id}`, variantId: null, quantity, shippedQuantity: quantity, price: 600,
      productName, productImage: null, variantLabel: null,
    });
    const parcel = (id: string, shipmentItems: string | null) => ({
      id, orderId: order.id, providerId: null, providerType: "manual", externalId: null, trackingId: null,
      status: "in_transit", rawStatus: null, shipmentItems, createdAt: 1_783_000_000,
    });
    await render({
      shipmentRecovery: undefined,
      status: "shipped",
      items: [line("i1", "Kurta", 4), line("i2", "Attar", 1)],
      shipments: [
        parcel("s1", JSON.stringify([{ itemId: "i1", quantity: 2 }])),
        parcel("s2", JSON.stringify([{ itemId: "i1", quantity: 2 }, { itemId: "i2", quantity: 1 }])),
      ],
    });
    const parcels = [...host.querySelectorAll("#order-shipments ul.divide-y > li")].map((row) =>
      [...row.querySelectorAll("ul li")].map((item) => item.textContent));
    expect(parcels).toEqual([["2 × Kurta"], ["2 × Kurta", "1 × Attar"]]);
  });

  const kurta = (quantity: number, shippedQuantity: number) => ({
    id: "i1", productId: "p1", variantId: null, quantity, shippedQuantity, price: 600,
    productName: "Kurta", productImage: null, variantLabel: null,
  });
  const riderParcel = (quantity: number) => ({
    id: "s1", orderId: order.id, providerId: null, providerType: "manual", courierName: "R3 Rider Jamal",
    externalId: null, trackingId: null, status: "in_transit", rawStatus: null,
    shipmentItems: JSON.stringify([{ itemId: "i1", quantity }]), createdAt: 1_783_000_000,
  });

  it("words a failed own-rider delivery once, with the attempt and reason (R3-ORD-05)", async () => {
    client.setQueryData(queryKeys.orders.cod(order.id), {
      tracking: { codStatus: "failed", deliveryAttempts: 1, failureReason: "no_cash", failureNote: "Will pay tomorrow" },
    });
    await render({ shipmentRecovery: undefined, status: "shipped", items: [kurta(2, 2)], shipments: [riderParcel(2)] });
    const label = en["shipments.failedAttempt"].replace("{count}", "1").replace("{reason}", en["cod.reason.no_cash"]);
    expect(host.querySelector('[data-testid="shipment-status"]')?.textContent).toBe(label);
    expect(host.textContent?.split(en["cod.status.failed"]).length).toBe(2);
    expect(host.textContent).toContain("Will pay tomorrow");
    expect(host.textContent).not.toContain(en["shipmentRecovery.failed"]);
  });

  it("offers Mark delivered for a shipped, fully sent order paid online", async () => {
    await render({
      shipmentRecovery: undefined, status: "shipped", paymentMethod: "stripe", paymentStatus: "paid", paidAmount: 1200, balanceDue: 0,
      items: [kurta(2, 2)], shipments: [riderParcel(2)],
    });
    const button = [...host.querySelectorAll("button")].find((element) => element.textContent === en["primary.markDelivered"]);
    await act(async () => button!.click());
    expect(mocks.delivered).toHaveBeenCalledWith({ orderId: order.id });
  });

  it("offers no Mark delivered for a cash order: collecting the cash delivers it", async () => {
    await render({ shipmentRecovery: undefined, status: "shipped", items: [kurta(2, 2)], shipments: [riderParcel(2)] });
    expect(host.textContent).not.toContain(en["primary.markDelivered"]);
  });
});
