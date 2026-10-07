// @vitest-environment happy-dom

// Every row of the orders list has the same cells, each one line, whatever the
// order's state (order-state-matrix.fixture.ts): a long or junk name, a
// "Partially refunded" payment, a courier booking to check or a lakh-sized
// total never makes one row taller, wider or shaped differently. In English
// and in Bangla, on the table and on the phone card.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderListItem } from "@scalius/core/modules/orders/browser";
import { FULFILLMENT_STATUSES, ORDER_STATUSES, PAYMENT_STATUSES } from "@scalius/shared/order-state";
import { setLocale } from "~/i18n";
import type { OrderActionPermissions } from "~/lib/order-action-permissions";
import { getOrderColumns, type OrderRowHandlers } from "./order-columns";
import { OrderMobileCard } from "./OrderMobileCard";
import { orderStateMatrix } from "./order-state-matrix.fixture";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("~/hooks/use-currency", () => ({
  useCurrency: () => ({ fmt: (n: number) => `৳${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` }),
}));
vi.mock("@/hooks/use-currency", () => ({
  useCurrency: () => ({ fmt: (n: number) => `৳${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` }),
}));
vi.mock("~/hooks/use-order-action-permissions", () => ({ useOrderActionPermissions: () => ({ canViewFraudCheck: true }) }));

const everything = new Proxy({}, { get: () => true }) as OrderActionPermissions;
const handlers = (showArchived = false): OrderRowHandlers => ({
  showArchived,
  dateField: "createdAt",
  selectable: false,
  orderActions: everything,
  updatingStatusIds: new Set(),
  onArchive: vi.fn(),
  onRestore: vi.fn(),
  onStatusUpdate: vi.fn(),
  onShipmentRefreshed: vi.fn(),
});

const rows = orderStateMatrix();

/** The cell's slots in order: its `data-part` names (a badge, a line and "—" are all a "value"). */
function shape(cell: Element): string {
  return [...cell.querySelectorAll("[data-part]")].map((element) => element.getAttribute("data-part")).join(">");
}

/** Text that could wrap: a text node with no one-line ancestor inside the cell. */
function wrappingText(cell: Element): string[] {
  const found: string[] = [];
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    let oneLine = false;
    for (let element = node.parentElement; element && element !== cell.parentElement; element = element.parentElement) {
      const classes = element.getAttribute("class") ?? "";
      // Badges are whitespace-nowrap (badgeVariants); tooltip text is portalled out of the cell.
      if (/\b(truncate|whitespace-nowrap)\b/.test(classes) || element.getAttribute("data-slot") === "badge") {
        oneLine = true;
        break;
      }
    }
    if (!oneLine) found.push(node.textContent);
  }
  return found;
}

describe("orders list rows across the state matrix", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    setLocale("en");
  });

  async function render(ui: ReactNode) {
    const rootRoute = createRootRoute();
    const page = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <>{ui}</> });
    const router = createRouter({
      routeTree: rootRoute.addChildren([page]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await router.load();
    await act(async () => root.render(<RouterProvider router={router} />));
  }

  it("covers every order, payment and fulfilment status together, and every courier state, type and channel", () => {
    const seen = new Set(rows.map(({ order }) => `${order.status}/${order.paymentStatus}/${order.fulfillmentStatus}`));
    expect(seen.size).toBe(ORDER_STATUSES.length * PAYMENT_STATUSES.length * FULFILLMENT_STATUSES.length);
    expect(rows.length).toBeGreaterThanOrEqual(340);
    // Apps' holds turn over across every status too, held and not.
    const held = rows.filter(({ order }) => order.onHold);
    expect(held.length).toBeGreaterThan(0);
    expect(new Set(held.map(({ order }) => order.status)).size).toBe(ORDER_STATUSES.length);
  });

  it("says a held order is on hold in its one attention marker, without changing the row's shape", async () => {
    const columns = getOrderColumns(handlers());
    const order = columns.find((column) => column.id === "order")!;
    const cell = order.cell as (context: { row: { original: OrderListItem } }) => ReactNode;
    const [held, free] = [rows.find((entry) => entry.order.onHold)!, rows.find((entry) => !entry.order.onHold)!];
    await render(
      <table>
        <tbody>
          {[held, free].map(({ label, order: original }) => (
            <tr key={label} data-row={label}><td>{cell({ row: { original } })}</td></tr>
          ))}
        </tbody>
      </table>,
    );
    const [heldCell, freeCell] = [...host.querySelectorAll("td")];
    expect(heldCell!.querySelector('[data-part="attention"]')?.getAttribute("aria-label")).toContain("On hold for review");
    expect(freeCell!.querySelector('[data-part="attention"]')?.getAttribute("aria-label") ?? "").not.toContain("On hold for review");
    expect(shape(heldCell!)).toBe(shape(freeCell!));
  });

  it.each(["en", "bn"] as const)("gives every row the same cells, one line each (%s)", async (locale) => {
    setLocale(locale);
    for (const archived of [false, true]) {
      const columns = getOrderColumns(handlers(archived));
      await render(
        <table>
          <tbody>
            {rows.map(({ label, order }) => (
              <tr key={label} data-row={label}>
                {columns.map((column) => {
                  const cell = column.cell as (context: { row: { original: OrderListItem } }) => ReactNode;
                  return <td key={column.id} data-col={column.id}>{cell({ row: { original: order } })}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      for (const column of columns) {
        const cells = [...host.querySelectorAll(`td[data-col="${column.id}"]`)];
        expect(cells).toHaveLength(rows.length);
        const shapes = new Map<string, string>();
        cells.forEach((cell, index) => shapes.set(shape(cell), rows[index]!.label));
        // One shape per column across the whole matrix.
        expect([...shapes.keys()], `${column.id} (${locale}${archived ? ", archived" : ""}): ${[...shapes.values()].join(" | ")}`).toHaveLength(1);
        for (const [index, cell] of cells.entries()) {
          expect(wrappingText(cell), `${column.id} wraps in ${rows[index]!.label}`).toEqual([]);
          expect(cell.innerHTML, `${column.id} in ${rows[index]!.label}`).not.toMatch(/flex-wrap|line-clamp|break-words|whitespace-pre/);
        }
      }
      // The customer is the one two-line cell, on every row: name over phone.
      for (const cell of host.querySelectorAll('td[data-col="customer"]')) {
        expect(cell.querySelectorAll('[data-part="value"]')).toHaveLength(2);
      }
      act(() => root.unmount());
      root = createRoot(host);
    }
  }, 120_000);

  it.each(["en", "bn"] as const)("gives every phone card the same four lines (%s)", async (locale) => {
    setLocale(locale);
    await render(
      <div>
        {rows.map(({ label, order }) => (
          <div key={label} data-card={label}>
            <OrderMobileCard order={order} dateField="createdAt" selectable isSelected={false} onToggleSelection={vi.fn()} />
          </div>
        ))}
      </div>,
    );
    for (const card of host.querySelectorAll("[data-card]")) {
      const link = card.querySelector("a")!;
      expect(link.children, card.getAttribute("data-card")!).toHaveLength(4);
      // The number, total, name and phone never wrap; the closing line is cut, not wrapped.
      expect(link.children[3]!.className).toMatch(/\btruncate\b/);
      expect(link.children[1]!.firstElementChild!.className).toMatch(/\btruncate\b/);
    }
  }, 120_000);
});
