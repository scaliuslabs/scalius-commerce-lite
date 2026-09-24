// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatPhoneForDisplay } from "@scalius/shared/customer-utils";
import type { Order, OrderCustomerRecord } from "./types";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children, ...props }: { to: string; params?: Record<string, string>; children: ReactNode }) => (
    <a href={Object.entries(params ?? {}).reduce((href, [key, value]) => href.replace(`$${key}`, value), to)} {...props}>{children}</a>
  ),
}));
vi.mock("~/hooks/use-order-action-permissions", () => ({
  useOrderActionPermissions: () => ({ canEditOrders: false, canViewFraudCheck: false }),
}));
vi.mock("~/components/admin/order-list/LazyFraudCheckIndicator", () => ({ LazyFraudCheckIndicator: () => null }));
vi.mock("./OrderDetailsDialog", () => ({ OrderDetailsDialog: () => null }));

import { OrderCustomerCard } from "./OrderCustomerCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const phone = "+8801712345678";
const baseOrder = {
  id: "ord_1069", customerName: "R3-SB Guest Two", customerPhone: phone, customerEmail: null, customerId: "cust_1",
  shippingAddress: "House 1", areaName: null, zoneName: null, cityName: null, shippingMethodName: null,
  editReadiness: { items: { allowed: false, reason: null }, details: { allowed: false, reason: null } },
};
const orderWith = (customerRecord?: OrderCustomerRecord | null) =>
  ({ ...baseOrder, ...(customerRecord === undefined ? {} : { customerRecord }) }) as unknown as Order;

describe("order customer card", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const show = (order: Order) => act(() => root.render(<OrderCustomerCard order={order} />));
  const recordLink = () => container.querySelector("a[href^='/admin/customers/']");

  it("shows the order's own name and links a guest record by its phone", () => {
    show(orderWith({ id: "cust_guest", name: "R3-SB Guest One", kind: "guest", phone }));
    expect(container.textContent).toContain("R3-SB Guest Two");
    expect(container.textContent).not.toContain("R3-SB Guest One");
    expect(recordLink()?.textContent).toBe(`Guest orders for ${formatPhoneForDisplay(phone)}`);
    expect(recordLink()?.getAttribute("href")).toBe("/admin/customers/cust_guest/edit");
    expect(container.textContent).not.toContain("Ordered as");
  });

  it("says 'Ordered as' when the account is named differently from the order", () => {
    show(orderWith({ id: "cust_owner", name: "Owner Rahman", kind: "account", phone }));
    expect(recordLink()?.textContent).toBe("Owner Rahman");
    expect(recordLink()?.getAttribute("href")).toBe("/admin/customers/cust_owner/edit");
    expect(container.textContent).toContain("Ordered as R3-SB Guest Two");
  });

  it("stays quiet when the record's name matches the order apart from case and spaces", () => {
    show(orderWith({ id: "cust_m", name: "  r3-sb guest two ", kind: "merchant", phone }));
    expect(recordLink()?.textContent).toBe("  r3-sb guest two ");
    expect(container.textContent).not.toContain("Ordered as");
  });

  it("works without a customer record", () => {
    show(orderWith(null));
    expect(container.textContent).toContain("R3-SB Guest Two");
    expect(recordLink()).toBeNull();
    show(orderWith(undefined));
    expect(container.textContent).toContain("R3-SB Guest Two");
    expect(recordLink()).toBeNull();
  });
});
