// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrderListItem } from "@scalius/core/modules/orders/browser";
import type { OrderActionPermissions } from "~/lib/order-action-permissions";
import { fitColumns } from "~/components/admin/data-table/column-layout";
import { fitList } from "~/components/admin/data-table/list-width.fixture";
import { getOrderColumns } from "./order-columns";
import { OrderMobileCard } from "./OrderMobileCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("~/hooks/use-currency", () => ({ useCurrency: () => ({ fmt: (n: number) => `৳${n}`, fmtIn: (n: number) => `৳${n}` }) }));

const order = (overrides: Partial<OrderListItem>) => ({
  id: "o-1",
  orderNumber: 1047,
  customerName: "Rahim",
  customerPhone: "+8801712349101",
  status: "shipped",
  paymentStatus: "unpaid",
  paymentMethod: "cod",
  fulfillmentStatus: "complete",
  totalAmount: 680,
  paidAmount: 0,
  createdAt: new Date("2026-09-24T04:00:00Z"),
  updatedAt: new Date("2026-09-24T04:00:00Z"),
  latestShipment: { id: "s-1", status: "in_transit" },
  shipmentRecovery: { activeLock: false },
  activeRefundOperation: null,
  openRequestType: null,
  refundDue: 0,
  cod: null,
  ...overrides,
}) as unknown as OrderListItem;

const handlers = {
  showArchived: false,
  dateField: "createdAt" as const,
  selectable: false,
  orderActions: { canManageOrderShipments: false } as OrderActionPermissions,
  updatingStatusIds: new Set<string>(),
  onArchive: vi.fn(),
  onRestore: vi.fn(),
  onStatusUpdate: vi.fn(),
  onShipmentRefreshed: vi.fn(),
};

/** The delivery cells of one row: fulfilment, delivery status and delivery method. */
function FulfillmentCell({ row }: { row: OrderListItem }) {
  const columns = getOrderColumns(handlers).filter((candidate) => ["fulfillment", "deliveryStatus", "deliveryMethod"].includes(candidate.id!));
  return (
    <>
      {columns.map((column) => {
        const cell = column.cell as (context: { row: { original: OrderListItem } }) => ReactNode;
        return <div key={column.id}>{cell({ row: { original: row } })}</div>;
      })}
    </>
  );
}

describe("order list delivery state", () => {
  let root: Root;
  let host: HTMLDivElement;

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  async function render(ui: ReactNode) {
    const rootRoute = createRootRoute();
    const page = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <>{ui}</> });
    const router = createRouter({
      routeTree: rootRoute.addChildren([page]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await router.load();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<RouterProvider router={router} />));
    return host;
  }

  it("says Returned, not In transit, for a returned order", async () => {
    const view = await render(<FulfillmentCell row={order({ status: "returned" })} />);
    expect(view.textContent).toContain("Returned");
    expect(view.textContent).not.toContain("In transit");
  });

  it("says Delivery failed with the attempt for a failed cash-on-delivery attempt, in the row and on the phone card", async () => {
    const failed = order({ cod: { status: "failed", deliveryAttempts: 1 } });
    const row = await render(<FulfillmentCell row={failed} />);
    expect(row.textContent).toContain("Delivery failed · attempt 1");
    expect(row.textContent).not.toContain("In transit");
    act(() => root.unmount());
    host.remove();

    const card = await render(
      <OrderMobileCard order={failed} dateField="createdAt" selectable={false} isSelected={false} onToggleSelection={vi.fn()} />,
    );
    expect(card.textContent).toContain("Delivery failed · attempt 1");
  });

  it("marks pickup and no-delivery orders, and a pickup order ready to collect", async () => {
    const pickup = await render(<FulfillmentCell row={order({
      status: "confirmed", fulfillmentStatus: "pending", latestShipment: null, shippingMethodKind: "pickup", requiresShipping: false,
    })} />);
    expect(pickup.textContent).toContain("Unfulfilled");
    expect(pickup.textContent).toContain("Pickup");
    act(() => root.unmount());
    host.remove();

    const ready = await render(<FulfillmentCell row={order({
      status: "confirmed", fulfillmentStatus: "pending", latestShipment: null, shippingMethodKind: "pickup",
      requiresShipping: false, pickupReadyAt: new Date("2026-09-25T09:00:00Z"),
    })} />);
    expect(ready.textContent).toContain("Ready for pickup");
    expect(ready.textContent).not.toContain("Unfulfilled");
    act(() => root.unmount());
    host.remove();

    const service = await render(<FulfillmentCell row={order({
      status: "confirmed", fulfillmentStatus: "pending", latestShipment: null, shippingMethodKind: null, requiresShipping: false,
    })} />);
    expect(service.textContent).toContain("No delivery");
  });

  it("keeps the courier status while the parcel is simply on its way", async () => {
    const view = await render(<FulfillmentCell row={order({})} />);
    expect(view.textContent).toContain("In transit");
  });
});

describe("order columns on a narrow screen", () => {
  const shownAt = (width: number) =>
    fitList(getOrderColumns({ ...handlers, selectable: true }), width).shown.filter((id) => id !== "select" && id !== "actions");

  it("shows Shopify's columns when there is room, in Shopify's order", () => {
    expect(shownAt(4000)).toEqual([
      "order", "date", "customer", "channel", "total", "payment", "fulfillment", "items", "deliveryStatus", "deliveryMethod", "status",
    ]);
  });

  it("drops the delivery method, items, channel and delivery status first; folds payment and fulfilment into one cell; then drops it, the total, status and customer; never the order or the date", () => {
    const states: string[][] = [];
    for (let width = 4000; width >= 10; width -= 2) {
      const shown = shownAt(width);
      if (states.at(-1)?.join() !== shown.join()) states.push(shown);
    }
    expect(states.slice(1)).toEqual([
      ["order", "date", "customer", "channel", "total", "payment", "fulfillment", "items", "deliveryStatus", "status"],
      ["order", "date", "customer", "channel", "total", "payment", "fulfillment", "deliveryStatus", "status"],
      ["order", "date", "customer", "total", "payment", "fulfillment", "deliveryStatus", "status"],
      ["order", "date", "customer", "total", "payment", "fulfillment", "status"],
      ["order", "date", "customer", "total", "paymentFulfillment", "status"],
      ["order", "date", "customer", "total", "status"],
      ["order", "date", "customer", "status"],
      ["order", "date", "customer"],
      ["order", "date"],
    ]);
  });
});

describe("a long customer name", () => {
  let root: Root;
  let host: HTMLDivElement;

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it.each([
    ["English", "Mohammad Abdur Rahman Chowdhury Talukder Bhuiyan Siddiqui of Old Dhaka Wholesale Garments"],
    ["Bangla", "মোহাম্মদ আব্দুর রহমান চৌধুরী তালুকদার ভূঁইয়া সিদ্দিকী পুরান ঢাকা পাইকারি পোশাক বিক্রেতা"],
  ])("in %s is capped and cut with the whole name on hover, so Total, Payment and Fulfillment stay", async (_language, name) => {
    const columns = getOrderColumns(handlers);
    const customer = columns.find((column) => column.id === "customer")!;
    // The column never grows past its cap; the money and status columns keep their room.
    expect(customer.meta).toMatchObject({ minWidth: 188, maxWidth: 176 });
    const room = columns
      .filter((column) => !column.meta?.combines)
      .reduce((sum, column) => sum + ((column.meta as { minWidth?: number } | undefined)?.minWidth ?? 48), 0);
    expect(fitColumns(
      columns.filter((column) => !column.meta?.combines).map((column) => ({
        id: column.id!,
        priority: (column.meta as { priority?: number; primary?: boolean } | undefined)?.primary ? Number.POSITIVE_INFINITY : (column.meta as { priority?: number } | undefined)?.priority ?? 50,
        minWidth: (column.meta as { minWidth?: number } | undefined)?.minWidth ?? 48,
        locked: column.id === "actions" || Boolean((column.meta as { primary?: boolean } | undefined)?.primary),
      })),
      room,
    ).size).toBe(0);

    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const cell = customer.cell as (context: { row: { original: OrderListItem } }) => ReactNode;
    await act(async () => root.render(<>{cell({ row: { original: order({ customerName: name }) } })}</>));
    const line = [...host.querySelectorAll<HTMLElement>("[data-part=value]")].find((element) => element.textContent === name)!;
    expect(line.className).toContain("truncate");
    expect(line.title).toBe(name);
  });
});
