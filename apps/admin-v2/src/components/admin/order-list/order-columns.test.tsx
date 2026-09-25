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
import { getOrderColumns } from "./order-columns";
import { OrderMobileCard } from "./OrderMobileCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("~/hooks/use-currency", () => ({ useCurrency: () => ({ fmt: (n: number) => `৳${n}` }) }));

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

function FulfillmentCell({ row }: { row: OrderListItem }) {
  const column = getOrderColumns(handlers).find((candidate) => candidate.id === "fulfillment")!;
  const cell = column.cell as (context: { row: { original: OrderListItem } }) => ReactNode;
  return <>{cell({ row: { original: row } })}</>;
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
  const layout = () => getOrderColumns({ ...handlers, selectable: true }).map((column) => {
    const id = column.id!;
    const meta = column.meta as { priority?: number; minWidth?: number; primary?: boolean } | undefined;
    const locked = id === "select" || id === "actions" || Boolean(meta?.primary);
    return {
      id,
      priority: locked ? Number.POSITIVE_INFINITY : meta?.priority ?? 50,
      minWidth: meta?.minWidth ?? (id === "select" ? 40 : 56),
      locked,
    };
  });
  const shownAt = (width: number) => {
    const hidden = fitColumns(layout(), width);
    return layout().map((column) => column.id).filter((id) => !hidden.has(id) && id !== "select" && id !== "actions");
  };

  it("drops Items, then Fulfillment, then Total, Status and Customer; never the order", () => {
    expect([2000, 800, 700, 600, 450, 300].map(shownAt)).toEqual([
      ["order", "customer", "total", "fulfillment", "items", "status"],
      ["order", "customer", "total", "fulfillment", "status"],
      ["order", "customer", "total", "status"],
      ["order", "customer", "status"],
      ["order", "customer"],
      ["order"],
    ]);
  });
});
