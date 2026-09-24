// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ getApiV1AdminCustomersByIdHistory: vi.fn() }));
vi.mock("@scalius/api-client/sdk", () => sdk);
vi.mock("~/hooks/use-currency", () => ({ useCurrency: () => ({ fmt: (value: number) => `৳${value}` }) }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children, ...props }: { to: string; params?: Record<string, string>; children: ReactNode }) => (
    <a href={Object.entries(params ?? {}).reduce((href, [key, value]) => href.replace(`$${key}`, value), to)} {...props}>{children}</a>
  ),
}));

import { CustomerActivity } from "./CustomerActivity";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const owner = { id: "cust_owner", name: "Owner" };
const guest = { id: "cust_guest", name: "Guest buyer" };
const snapshot = (name: string) => ({
  name, email: null, phone: "+8801711111011", address: null, city: null, zone: null, area: null,
  cityName: null, zoneName: null, areaName: null, order: null, relatedCustomer: null,
});
const page = 1;
const pagination = { page, limit: 10, total: 1, totalPages: 1, hasNextPage: false };

function payload(customer: Record<string, unknown>, history: Array<Record<string, unknown>>) {
  return {
    customer: {
      id: "cust_page", name: "Page", email: null, phone: "+8801711111011", address: null, city: null, zone: null, area: null,
      cityName: null, zoneName: null, areaName: null, accountClaimedAt: null, totalOrders: 1, totalSpent: 500,
      lastOrderAt: null, createdAt: "2026-09-20T10:00:00.000Z", updatedAt: "2026-09-20T10:00:00.000Z", deletedAt: null,
      linkedAccount: null, guestRecords: [], ...customer,
    },
    history,
    orders: [],
    pagination: { history: pagination, orders: pagination },
  };
}

describe("CustomerActivity", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    notifyManager.setNotifyFunction((callback) => callback());
  });

  async function show(data: ReturnType<typeof payload>) {
    sdk.getApiV1AdminCustomersByIdHistory.mockImplementation(() => Promise.resolve({ data: { success: true, data } }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><CustomerActivity customerId="cust_page" /></QueryClientProvider>);
    });
    await vi.waitFor(() => expect(container.querySelectorAll("ol > li").length).toBeGreaterThan(0));
  }

  const link = (text: string) => [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === text);
  const entries = () => [...container.querySelectorAll("ol > li")].map((item) => item.textContent ?? "");

  it("shows a moved-in order as one linked line and diffs an update against the older snapshot", async () => {
    await show(payload({ guestRecords: [{ ...guest, orderCount: 1 }] }, [
      { id: "h3", changeType: "updated", createdAt: "2026-09-23T10:00:00.000Z", ...snapshot("Owner Rahman") },
      {
        id: "h2", changeType: "order_moved_in", createdAt: "2026-09-22T10:00:00.000Z", ...snapshot("Guest buyer"),
        order: { id: "ord_1069", orderNumber: 1069 }, relatedCustomer: guest,
      },
      { id: "h1", changeType: "created", createdAt: "2026-09-21T10:00:00.000Z", ...snapshot("Owner") },
    ]));

    const [update, moved, created] = entries();
    // The update compares with "created", not with the move's snapshot.
    expect(update).toContain("Name: Owner → Owner Rahman");
    expect(moved).toContain("Order #1069 moved in from guest record Guest buyer");
    expect(moved).not.toContain("Name:");
    expect(created).toContain("Name: Owner");
    expect(link("#1069")?.getAttribute("href")).toBe("/admin/orders/ord_1069");
    expect(link("Guest buyer")?.getAttribute("href")).toBe("/admin/customers/cust_guest/edit");
    expect(container.textContent).toContain("1 guest order still on Guest buyer");
  });

  it("marks a guest record an account hasn't claimed and links the account", async () => {
    await show(payload({ linkedAccount: owner }, [
      {
        id: "h2", changeType: "order_moved_out", createdAt: "2026-09-22T10:00:00.000Z", ...snapshot("Guest buyer"),
        order: { id: "ord_1069", orderNumber: 1069 }, relatedCustomer: owner,
      },
      { id: "h1", changeType: "created", createdAt: "2026-09-21T10:00:00.000Z", ...snapshot("Guest buyer") },
    ]));

    const note = container.querySelector("[data-slot=alert]");
    expect(note?.textContent).toContain("Guest orders (not yet claimed)");
    expect(note?.textContent).toContain("These orders were placed with a contact the account Owner hasn't verified yet.");
    expect(note?.querySelector("a")?.getAttribute("href")).toBe("/admin/customers/cust_owner/edit");
    expect(entries()[0]).toContain("Order #1069 moved to account Owner");
  });

  it("says a retired guest record was merged into the account", async () => {
    await show(payload({ linkedAccount: owner, deletedAt: "2026-09-22T10:00:00.000Z", totalOrders: 0 }, [
      { id: "h1", changeType: "created", createdAt: "2026-09-21T10:00:00.000Z", ...snapshot("Guest buyer") },
    ]));

    const note = container.querySelector("[data-slot=alert]");
    expect(note?.textContent).toBe("Merged into Owner");
    expect(note?.textContent).not.toContain("not yet claimed");
    expect(note?.querySelector("a")?.getAttribute("href")).toBe("/admin/customers/cust_owner/edit");
  });
});
