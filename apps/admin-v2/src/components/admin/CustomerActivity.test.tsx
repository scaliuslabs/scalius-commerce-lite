// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatPhoneForDisplay } from "@scalius/shared/customer-utils";

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

const guestPhone = "+8801712345678";
const owner = { id: "cust_owner", name: "Owner Rahman", kind: "account", phone: "+8801711111011" };
const guest = { id: "cust_guest", name: "R3-SB Guest One", kind: "guest", phone: guestPhone };
const guestTitle = `${formatPhoneForDisplay(guestPhone)} · guest orders`;
const snapshot = (name: string) => ({
  name, email: null, phone: "+8801711111011", address: null, city: null, zone: null, area: null,
  cityName: null, zoneName: null, areaName: null, order: null, relatedCustomer: null, verifiedContact: null, author: null,
});
const order1069 = { id: "ord_1069", orderNumber: 1069 };
const pagination = { page: 1, limit: 10, total: 1, totalPages: 1, hasNextPage: false };

function payload(customer: Record<string, unknown>, history: Array<Record<string, unknown>>, orders: Array<Record<string, unknown>> = []) {
  return {
    customer: {
      id: "cust_page", name: "Page", kind: "account", latestOrderName: null, mergedInto: null, samePhone: [],
      email: null, phone: "+8801711111011", address: null, city: null, zone: null, area: null,
      cityName: null, zoneName: null, areaName: null, accountClaimedAt: null, totalOrders: 1, totalSpent: 500,
      lastOrderAt: null, createdAt: "2026-09-20T10:00:00.000Z", updatedAt: "2026-09-20T10:00:00.000Z", deletedAt: null,
      ...customer,
    },
    history,
    orders,
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

  it("says how an account signed up and which orders a verified contact linked to it", async () => {
    await show(payload({}, [
      { id: "h4", changeType: "updated", createdAt: "2026-09-23T10:00:00.000Z", ...snapshot("Owner Rahman") },
      {
        id: "h3", changeType: "order_moved_in", createdAt: "2026-09-22T10:00:00.000Z", ...snapshot("Owner"),
        order: order1069, relatedCustomer: guest, verifiedContact: "email",
      },
      {
        id: "h2", changeType: "order_linked", createdAt: "2026-09-21T12:00:00.000Z", ...snapshot("Owner"),
        order: { id: "ord_1091", orderNumber: 1091 }, verifiedContact: "phone",
      },
      { id: "h1", changeType: "signed_up", createdAt: "2026-09-21T10:00:00.000Z", ...snapshot("Owner"), verifiedContact: "email" },
    ]));

    const [update, movedIn, linked, signedUp] = entries();
    // The update compares with the sign-up snapshot, not with the order events.
    expect(update).toContain("Name: Owner → Owner Rahman");
    expect(movedIn).toMatch(/^Order #1069 linked by verified email on .+ \(from .+ · guest orders\)$/);
    expect(movedIn).not.toContain("R3-SB Guest One");
    expect(linked).toMatch(/^Order #1091 linked by verified phone on .+$/);
    expect(signedUp).toMatch(/^Signed up with a verified email on .+$/);
    expect(link("#1069")?.getAttribute("href")).toBe("/admin/orders/ord_1069");
    expect(link("#1091")?.getAttribute("href")).toBe("/admin/orders/ord_1091");
    expect(link(guestTitle)?.getAttribute("href")).toBe("/admin/customers/cust_guest/edit");
    // No "guest orders still on …" cue on the account.
    expect(container.querySelector("[data-slot=alert]")).toBeNull();
  });

  it("says which account an order moved to, and falls back to the plain wording without a verified contact", async () => {
    await show(payload({ kind: "guest", latestOrderName: "R3-SB Guest Two" }, [
      {
        id: "h3", changeType: "order_moved_out", createdAt: "2026-09-22T10:00:00.000Z", ...snapshot("R3-SB Guest One"),
        order: order1069, relatedCustomer: owner, verifiedContact: "email",
      },
      {
        id: "h2", changeType: "order_moved_out", createdAt: "2026-09-21T12:00:00.000Z", ...snapshot("R3-SB Guest One"),
        order: { id: "ord_1070", orderNumber: 1070 }, relatedCustomer: owner,
      },
      { id: "h1", changeType: "created", createdAt: "2026-09-21T10:00:00.000Z", ...snapshot("R3-SB Guest One") },
    ]));

    const [verified, plain] = entries();
    expect(verified).toMatch(/^Order #1069 moved to account Owner Rahman, linked by verified email on .+$/);
    expect(plain).toMatch(/^Order #1070 moved to account Owner Rahman · .+$/);
    expect(link("Owner Rahman")?.getAttribute("href")).toBe("/admin/customers/cust_owner/edit");
    // A guest record carries no "not yet claimed" or "belongs to an account" marker.
    expect(container.querySelector("[data-slot=alert]")).toBeNull();
    expect(container.textContent).not.toContain("not yet claimed");
  });

  it("names each order in the list by the name it was placed with", async () => {
    await show(payload({ kind: "guest", totalOrders: 2 }, [
      { id: "h1", changeType: "created", createdAt: "2026-09-21T10:00:00.000Z", ...snapshot("R3-SB Guest One") },
    ], [
      { id: "ord_1082", orderNumber: 1082, customerName: "R3-SB Guest Two", status: "pending", totalAmount: 900, createdAt: "2026-09-22T10:00:00.000Z" },
      { id: "ord_1081", orderNumber: 1081, customerName: "R3-SB Guest One", status: "delivered", totalAmount: 500, createdAt: "2026-09-21T10:00:00.000Z" },
    ]));

    const rows = [...container.querySelectorAll("a[href^='/admin/orders/']")].map((row) => row.textContent ?? "");
    expect(rows[0]).toContain("#1082 · R3-SB Guest Two");
    expect(rows[1]).toContain("#1081 · R3-SB Guest One");
  });

  it("shows each change's time and author, and a restore from trash", async () => {
    await show(payload({}, [
      { id: "h4", changeType: "restored", createdAt: "2026-09-23T10:00:00.000Z", ...snapshot("Owner"), author: { kind: "staff", name: "Nasrin" } },
      { id: "h3", changeType: "deleted", createdAt: "2026-09-22T10:00:00.000Z", ...snapshot("Owner"), author: { kind: "staff", name: null } },
      {
        id: "h2", changeType: "order_linked", createdAt: "2026-09-21T12:00:00.000Z", ...snapshot("Owner"),
        order: { id: "ord_1091", orderNumber: 1091 }, verifiedContact: "email", author: { kind: "system", name: null },
      },
      { id: "h1", changeType: "signed_up", createdAt: "2026-09-21T10:00:00.000Z", ...snapshot("Owner"), verifiedContact: "phone", author: { kind: "buyer", name: null } },
      { id: "h0", changeType: "created", createdAt: "2026-09-20T10:00:00.000Z", ...snapshot("Owner") },
    ]));

    const [restored, deleted, linked, signedUp, created] = entries();
    // 10:00 UTC is 4:00 pm in Dhaka: the time is shown, not only the day.
    expect(restored).toMatch(/^Restored from trash · .*4:00.* · by Nasrin$/i);
    expect(restored).not.toContain("Name:");
    expect(deleted).toMatch(/ · by staff$/);
    expect(linked).toMatch(/^Order #1091 linked by verified email on .*6:00.* · automatic$/i);
    expect(signedUp).toMatch(/^Signed up with a verified phone on .* · by the buyer$/);
    // Older entries without an author say nothing about who.
    expect(created).not.toContain(" by ");
    expect(created).not.toContain("automatic");
  });

  it("links other customers with the same phone, without offering to merge them", async () => {
    await show(payload({
      kind: "merchant",
      samePhone: [
        { id: "cust_guest", name: "R3-SB Guest One", kind: "guest", phone: guestPhone },
        { id: "cust_owner", name: "Owner Rahman", kind: "account", phone: guestPhone },
      ],
    }, [
      { id: "h1", changeType: "created", createdAt: "2026-09-21T10:00:00.000Z", ...snapshot("Page") },
    ]));

    expect(container.textContent).toContain(`Same phone as ${guestTitle}, Owner Rahman`);
    expect(link(guestTitle)?.getAttribute("href")).toBe("/admin/customers/cust_guest/edit");
    expect(link("Owner Rahman")?.getAttribute("href")).toBe("/admin/customers/cust_owner/edit");
    expect(container.querySelector("button")?.textContent ?? "").not.toMatch(/merge|claim/i);
  });
});
