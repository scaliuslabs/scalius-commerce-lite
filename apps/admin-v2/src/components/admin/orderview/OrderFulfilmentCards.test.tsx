// @vitest-environment happy-dom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { orderDetailMessages } from "~/i18n/order-detail";
import type { Order, OrderFulfillment, OrderItem } from "./types";
import { OrderFulfilmentCards } from "./OrderFulfilmentCards";
import { fulfilledGroups, returnedByGroup, unfulfilledGroups } from "./fulfilment-groups";

const mocks = vi.hoisted(() => ({
  canManage: true,
  canEdit: true,
  ready: vi.fn(),
  voided: vi.fn(),
  setLocation: vi.fn(),
  dialogs: [] as string[],
  locations: [] as Array<{ id: string; name: string; isDefault: boolean; status: string }>,
}));
vi.mock("~/hooks/use-order-action-permissions", () => ({
  useOrderActionPermissions: () => ({ canManageOrderShipments: mocks.canManage, canUpdateOrderCod: true, canEditOrders: mocks.canEdit }),
}));
vi.mock("~/lib/api-mutations/orders", () => ({
  orderErrorMessage: (error: Error) => error.message,
  useMarkPickupReady: () => ({ mutate: mocks.ready, isPending: false }),
  useMarkOrderDelivered: () => ({ mutate: vi.fn(), isPending: false }),
  useVoidFulfillment: () => ({ mutate: mocks.voided, reset: vi.fn(), isPending: false, isError: false }),
  useSetOrderFulfillmentLocation: () => ({ mutate: mocks.setLocation, isPending: false }),
}));
vi.mock("~/lib/api-query-options/inventory-locations", async (importActual) => ({
  ...(await importActual<typeof import("~/lib/api-query-options/inventory-locations")>()),
  inventoryLocationsQueryOptions: () => ({ queryKey: ["inventory-locations", "test"], queryFn: async () => mocks.locations }),
}));
vi.mock("~/lib/api-query-options/orders", () => ({
  orderReturnsQueryOptions: (id: string) => ({ queryKey: ["returns", id], queryFn: () => new Promise(() => undefined) }),
}));
vi.mock("~/hooks/use-currency", () => ({ useCurrency: () => ({ fmt: (value: number) => `৳${value}` }) }));
vi.mock("~/hooks/use-hydrated", () => ({ useHydrated: () => true }));
vi.mock("./ManualFulfillmentDialog", () => ({
  ManualFulfillmentDialog: ({ kind, open }: { kind: string; open: boolean }) => {
    if (open) mocks.dialogs.push(kind);
    return open ? <p data-testid="handover-dialog">{kind}</p> : null;
  },
}));
vi.mock("./ShipmentCard", () => ({
  BookCourier: () => <p data-testid="book-courier">book</p>,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className }: { children: React.ReactNode; className?: string }) => <a className={className} href="#p">{children}</a>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const en = orderDetailMessages.en;

const line = (id: string, name: string, overrides: Partial<OrderItem> = {}): OrderItem => ({
  id, productId: `p_${id}`, variantId: null, quantity: 1, price: 500, productName: name, productImage: null,
  variantLabel: null, fulfillmentType: "ship", fulfilledQuantity: 0, ...overrides,
});
const base = {
  id: "ord_1", version: 1, status: "confirmed", paymentMethod: "cod", balanceDue: 1500, currencyCode: "BDT",
  items: [], shipments: [], fulfillments: [], discounts: [], archivedAt: null, editReadiness: {},
} as unknown as Order;
const order = (overrides: Partial<Order>): Order => ({ ...base, ...overrides });

const riderParcel = (overrides: Partial<OrderFulfillment> = {}): OrderFulfillment => ({
  id: "ful_1", kind: "ship", createdAt: "2026-09-25T08:00:00.000Z",
  lines: [{ orderItemId: "k1", quantity: 1 }],
  tracking: { shipmentId: "s1", courierName: "Rider Jamal", trackingId: "RJ-1", trackingUrl: null, status: "in_transit" },
  status: "active", actorType: "admin", cashCollected: null, voidedAt: null, canVoid: true, voidBlockedReason: null,
  ...overrides,
});

describe("fulfilment groups", () => {
  it("groups what is left by how it reaches the buyer, in page order", () => {
    const groups = unfulfilledGroups(order({
      items: [
        line("s1", "Setup", { fulfillmentType: "service" }),
        line("k1", "Kurta", { quantity: 3, fulfilledQuantity: 1 }),
        line("g1", "Gift card", { fulfillmentType: "gift_card" }),
      ],
    }));
    expect(groups.map((group) => [group.type, group.units])).toEqual([["ship", 2], ["service", 1], ["gift_card", 1]]);
  });

  it("lists active fulfilments oldest first and leaves voided ones out", () => {
    const groups = fulfilledGroups(order({
      items: [line("k1", "Kurta", { quantity: 2, fulfilledQuantity: 2 })],
      fulfillments: [
        riderParcel({ id: "ful_2", createdAt: "2026-09-25T10:00:00.000Z" }),
        riderParcel({ id: "ful_old", createdAt: "2026-09-24T10:00:00.000Z", status: "voided" }),
        riderParcel({ id: "ful_1" }),
      ],
    }));
    expect(groups.map((group) => group.fulfillment?.id)).toEqual(["ful_1", "ful_2"]);
  });
});

describe("returned units per hand-over", () => {
  const two = (quantities: number[]) => fulfilledGroups(order({
    items: [line("k1", "Kurta", { quantity: quantities.reduce((sum, value) => sum + value, 0), fulfilledQuantity: quantities.reduce((sum, value) => sum + value, 0) })],
    fulfillments: quantities.map((quantity, index) => riderParcel({
      id: `ful_${index}`,
      createdAt: `2026-09-25T0${index}:00:00.000Z`,
      lines: [{ orderItemId: "k1", quantity }],
    })),
  }));

  it.each([
    { parcels: [1, 1], returned: 0, expected: [0, 0] },
    { parcels: [1, 1], returned: 1, expected: [1, 0] },
    { parcels: [1, 1], returned: 2, expected: [1, 1] },
    { parcels: [2, 3], returned: 4, expected: [2, 2] },
    { parcels: [2, 3], returned: 9, expected: [2, 3] },
  ])("parcels $parcels with $returned returned show $expected (oldest first, never double-counted)", ({ parcels, returned, expected }) => {
    const groups = two(parcels);
    const shown = returnedByGroup(groups, new Map([["k1", returned]])).map((map) => map.get("k1") ?? 0);
    expect(shown).toEqual(expected);
    expect(shown.reduce((sum, value) => sum + value, 0)).toBe(Math.min(returned, parcels.reduce((sum, value) => sum + value, 0)));
  });
});

describe("OrderFulfilmentCards", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canManage = true;
    mocks.canEdit = true;
    mocks.dialogs = [];
    mocks.locations = [];
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient();
  });

  afterEach(() => {
    act(() => root.unmount());
    client.clear();
    document.body.innerHTML = "";
  });

  async function render(shown: Order) {
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <OrderFulfilmentCards order={shown} />
      </QueryClientProvider>,
    ));
  }
  const card = (testId: string) => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  const button = (scope: ParentNode, label: string) =>
    [...scope.querySelectorAll("button")].find((element) => element.textContent === label);

  it("shows an unfulfilled shipping card with its buyer inputs and the own-rider action", async () => {
    await render(order({
      items: [line("k1", "Kurta", {
        quantity: 2,
        properties: [{ key: "fit", type: "select", label: "Fit", value: "slim", displayValue: "Slim", price: 100, priceMinor: 10000 }],
      })],
    }));
    const ship = card("unfulfilled-ship")!;
    expect(ship.textContent).toContain(en["badge.unfulfilled"]);
    expect(ship.textContent).toContain("Shipping (2)");
    expect(ship.textContent).toContain("Fit: Slim (+৳100.00)");
    await act(async () => button(ship, en["fulfill.submit"])!.click());
    expect(mocks.dialogs).toContain("ship");
  });

  it("shows a free gift at ৳0 with its price struck, as the payment counts it", async () => {
    const money = (unitPriceMinor: number, discountAmountMinor: number) => ({
      unitPriceMinor, lineSubtotalMinor: unitPriceMinor, discountAmountMinor,
      taxableAmountMinor: unitPriceMinor - discountAmountMinor, taxAmountMinor: 0,
    });
    await render(order({
      currencyDecimalPlaces: 2, subtotalAmountMinor: 170_000, shippingAmountMinor: 0, discountAmountMinor: 120_000,
      taxAmountMinor: 0, totalAmountMinor: 50_000, taxLabel: "VAT", pricesIncludeTax: false,
      items: [
        line("k1", "Mug", money(50_000, 0)),
        line("k2", "Gift lamp", { price: 1200, ...money(120_000, 120_000) }),
      ],
    } as Partial<Order>));
    const ship = card("unfulfilled-ship")!;
    const totals = [...ship.querySelectorAll("[data-line-total]")].map((cell) => cell.textContent?.replace(/\s+/g, " ").trim());
    expect(totals).toEqual(["৳500.00", "৳1,200.00 ৳0.00"]);
    expect(ship.querySelectorAll("[data-line-total] s")).toHaveLength(1);
    expect([...ship.querySelectorAll("[data-line-total] s")][0]!.textContent).toBe("৳1,200.00");
  });

  it("shows a returned unit once, on the oldest parcel that held it, when a line went out in two parcels", async () => {
    // Two units, sent as two one-unit parcels; one unit came back (the return names the line, not the parcel).
    client.setQueryData(["returns", "ord_1"], {
      returns: [{ id: "ret_1", lines: [{ orderItemId: "k1", receivedQuantity: 1 }] }],
    });
    await render(order({
      status: "delivered",
      items: [line("k1", "Kurta", { quantity: 2, fulfilledQuantity: 2 })],
      fulfillments: [
        riderParcel({ id: "ful_late", createdAt: "2026-09-25T10:00:00.000Z" }),
        riderParcel({ id: "ful_early", createdAt: "2026-09-25T08:00:00.000Z" }),
      ],
    }));
    const cards = [...host.querySelectorAll<HTMLElement>('[data-testid="fulfilled-ship"]')];
    expect(cards).toHaveLength(2);
    const returnedLine = en["items.returned"].replace("{count}", "1");
    expect(cards.map((element) => element.textContent?.includes(returnedLine))).toEqual([true, false]);
  });

  describe("fulfilment location", () => {
    const main = { id: "loc_main", name: "Main warehouse", isDefault: true, status: "active" };
    const branch = { id: "loc_branch", name: "Chattogram branch", isDefault: false, status: "active" };
    const unshipped = order({
      items: [line("k1", "Kurta")],
      editReadiness: { items: { allowed: false, reason: null }, details: { allowed: true, reason: null } },
      fulfillmentLocation: { id: "loc_main", name: "Main warehouse", explicit: false },
    });
    const shipsFrom = en["location.shipsFrom"].replace("{name}", "Main warehouse");

    it("stays out of the way while the store has one location", async () => {
      mocks.locations = [main];
      await render(unshipped);
      await act(async () => undefined);
      expect(card("unfulfilled-ship")!.textContent).not.toContain(shipsFrom);
    });

    it("names where the order ships from and offers a change until anything has left", async () => {
      mocks.locations = [main, branch];
      await render(unshipped);
      await vi.waitFor(() => expect(card("unfulfilled-ship")!.textContent).toContain(shipsFrom));
      expect(button(card("unfulfilled-ship")!, en["location.change"])).toBeDefined();

      await render({ ...unshipped, editReadiness: { items: { allowed: false, reason: "shipped" }, details: { allowed: false, reason: "shipped" } } });
      expect(card("unfulfilled-ship")!.textContent).toContain(shipsFrom);
      expect(button(card("unfulfilled-ship")!, en["location.change"])).toBeUndefined();
    });
  });

  it("offers no hand-over actions to staff without shipment permission", async () => {
    mocks.canManage = false;
    await render(order({ items: [line("k1", "Kurta")] }));
    expect(button(card("unfulfilled-ship")!, en["fulfill.submit"])).toBeUndefined();
  });

  describe("pickup", () => {
    const pickupOrder = order({
      requiresShipping: false, shippingMethodKind: "pickup",
      pickup: { address: "Shop 12, Gulshan 1", hours: "10am–8pm", readyAt: null },
      items: [line("l1", "Lighter", { fulfillmentType: "pickup", quantity: 2 })],
    });

    it("marks the order ready for pickup with one key per attempt", async () => {
      await render(pickupOrder);
      const pickup = card("unfulfilled-pickup")!;
      expect(pickup.textContent).toContain("Pickup at Shop 12, Gulshan 1");
      expect(pickup.textContent).toContain("10am–8pm");
      await act(async () => button(pickup, en["primary.markReadyForPickup"])!.click());
      await act(async () => button(pickup, en["primary.markReadyForPickup"])!.click());
      const [[first], [second]] = mocks.ready.mock.calls;
      expect(first).toMatchObject({ orderId: "ord_1", requestKey: expect.any(String) });
      expect(second.requestKey).toBe(first.requestKey);
    });

    it("once ready, says so and makes Mark as picked up the one action", async () => {
      await render({ ...pickupOrder, pickupReadyAt: "2026-09-25T09:00:00.000Z" });
      const pickup = card("unfulfilled-pickup")!;
      expect(pickup.textContent).toContain(en["badge.readyForPickup"]);
      expect(button(pickup, en["primary.markReadyForPickup"])).toBeUndefined();
      await act(async () => button(pickup, en["pickup.submit"])!.click());
      expect(mocks.dialogs).toContain("pickup");
    });

    it("shows what was picked up and the cash taken at the counter", async () => {
      await render({
        ...pickupOrder,
        items: [line("l1", "Lighter", { fulfillmentType: "pickup", quantity: 2, fulfilledQuantity: 2 })],
        fulfillments: [riderParcel({
          id: "ful_p", kind: "pickup", tracking: null, cashCollected: 1200, canVoid: false,
          lines: [{ orderItemId: "l1", quantity: 2 }],
        })],
      });
      expect(card("unfulfilled-pickup")).toBeNull();
      const done = card("fulfilled-pickup")!;
      expect(done.textContent).toContain(en["badge.pickedUp"]);
      expect(done.textContent).toContain("Cash received ৳1,200.00");
    });
  });

  it("marks a service done from its own card", async () => {
    await render(order({ requiresShipping: false, items: [line("v1", "Installation", { fulfillmentType: "service" })] }));
    const service = card("unfulfilled-service")!;
    expect(service.textContent).toContain(en["badge.notDone"]);
    expect(service.textContent).toContain(en["group.serviceHelp"]);
    await act(async () => button(service, en["service.submit"])!.click());
    expect(mocks.dialogs).toContain("service");
  });

  it("says digital lines are sent automatically and offers no action", async () => {
    await render(order({ items: [line("d1", "E-book", { fulfillmentType: "digital" })] }));
    const digital = card("unfulfilled-digital")!;
    expect(digital.textContent).toContain(en["group.automaticHelp"]);
    expect(digital.querySelector("button")).toBeNull();
  });

  describe("void", () => {
    const sent = order({
      items: [line("k1", "Kurta", { quantity: 2, fulfilledQuantity: 1 })],
      fulfillments: [riderParcel()],
    });

    async function openMenu() {
      const trigger = card("fulfilled-ship")!.querySelector<HTMLButtonElement>(`button[aria-label="${en["fulfilled.actions"]}"]`)!;
      await act(async () => {
        trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    }

    it("voids a returned own-rider parcel after confirming, with the dialog's key", async () => {
      await render(sent);
      const done = card("fulfilled-ship")!;
      expect(done.textContent).toContain("Shipping #1");
      expect(done.textContent).toContain("RJ-1");
      const [item] = await openMenu();
      expect(item!.textContent).toContain(en["shipments.cameBack"]);
      await act(async () => item!.click());
      const dialog = document.querySelector('[role="alertdialog"]')!;
      expect(dialog.textContent).toContain(en["shipments.cameBackOne"]);
      expect(mocks.voided).not.toHaveBeenCalled();
      const confirm = [...dialog.querySelectorAll("button")].find((element) => element.textContent === en["shipments.cameBack"])!;
      await act(async () => confirm.click());
      expect(mocks.voided).toHaveBeenCalledWith(
        { orderId: "ord_1", fulfillmentId: "ful_1", requestKey: expect.any(String) },
        expect.anything(),
      );
    });

    it("shows why a fulfilment can't be voided on the disabled item", async () => {
      await render({ ...sent, fulfillments: [riderParcel({ canVoid: false, voidBlockedReason: "courier" })] });
      const [item] = await openMenu();
      expect(item!.getAttribute("aria-disabled")).toBe("true");
      expect(item!.closest('[data-testid="void-blocked"]')).not.toBeNull();
      expect(item!.textContent).toContain(en["void.blocked.courier"]);
      await act(async () => item!.click());
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    });

    it("offers no menu when the server allows nothing", async () => {
      await render({ ...sent, fulfillments: [riderParcel({ canVoid: undefined, voidBlockedReason: undefined })] });
      expect(card("fulfilled-ship")!.querySelector(`button[aria-label="${en["fulfilled.actions"]}"]`)).toBeNull();
    });
  });
});
