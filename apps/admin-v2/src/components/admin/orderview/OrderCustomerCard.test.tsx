// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { displayPhone } from "~/lib/phone-display";
import { setLocale } from "~/i18n";
import { formatOrderTimestamp } from "./formatters";
import type { Order, OrderAppRiskCheck, OrderCustomerRecord, OrderHold } from "./types";

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
  appRiskChecks: [],
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
    setLocale("en");
    act(() => root.unmount());
    container.remove();
  });

  const show = (order: Order) => act(() => root.render(<OrderCustomerCard order={order} />));
  const recordLink = () => container.querySelector("a[href^='/admin/customers/']");

  it("shows the order's own name and links a guest record by its phone", () => {
    show(orderWith({ id: "cust_guest", name: "R3-SB Guest One", kind: "guest", phone }));
    expect(container.textContent).toContain("R3-SB Guest Two");
    expect(container.textContent).not.toContain("R3-SB Guest One");
    expect(recordLink()?.textContent).toBe(`Guest orders for ${displayPhone(phone)}`);
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

  describe("apps' risk checks", () => {
    const checks: OrderAppRiskCheck[] = [
      {
        appId: "acme.radar", appName: "Risk radar", level: "high",
        reasons: ["Phone has 3 returned orders", "Address doesn't match the area"], checkedAt: "2026-10-01T08:00:00.000Z",
      },
      // Order timestamps may come as unix seconds.
      { appId: "acme.trust", appName: "Trust score", level: "medium", reasons: ["New customer"], checkedAt: 1_790_000_000 },
      { appId: "acme.verify", appName: "Phone verify", level: "low", reasons: [], checkedAt: "2026-10-01T08:06:00.000Z" },
    ];
    const withChecks = (appRiskChecks: OrderAppRiskCheck[]) => ({ ...baseOrder, appRiskChecks }) as unknown as Order;
    const items = () => [...container.querySelectorAll("section:last-of-type > ul > li")];

    it("lists each app's level as a word, its reasons and when it checked, and says it is advice", () => {
      // The courier fraud check is hidden for this viewer; apps' advice is part of the order and still shows.
      show(withChecks(checks));
      expect(container.textContent).toContain("Risk checks by apps");
      expect(container.textContent).toContain("Nothing was cancelled automatically");
      expect(container.textContent).not.toContain("Courier fraud check");

      const [high, medium, low] = items();
      expect(high!.querySelector("a")?.getAttribute("href")).toBe("/admin/apps/acme.radar");
      expect(high!.querySelector("a")?.textContent).toBe("Risk radar");
      expect(high!.textContent).toContain("High risk");
      expect([...high!.querySelectorAll("ul > li")].map((reason) => reason.textContent)).toEqual([
        "Phone has 3 returned orders",
        "Address doesn't match the area",
      ]);
      expect(high!.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-01T08:00:00.000Z");
      expect(high!.querySelector("time")?.textContent).toBe(`Checked ${formatOrderTimestamp("2026-10-01T08:00:00.000Z")}`);
      expect(medium!.textContent).toContain("Medium risk");
      expect(medium!.querySelector("time")?.getAttribute("datetime")).toBe(new Date(1_790_000_000 * 1000).toISOString());
      expect(medium!.querySelector("time")?.textContent).toBe(`Checked ${formatOrderTimestamp(1_790_000_000)}`);
      expect(low!.textContent).toContain("Low risk");
      expect(low!.querySelector("ul")).toBeNull();
    });

    it("says when staff released an app's hold, under that app's check", () => {
      const holds: OrderHold[] = [
        // Open: the page's hold notice shows it, not this card.
        { id: "ohd_open", appId: "acme.trust", appName: "Trust score", reason: "New customer", placedAt: 1_790_000_000, releasedAt: null },
        {
          id: "ohd_radar", appId: "acme.radar", appName: "Risk radar", reason: "Phone has 3 returned orders",
          placedAt: "2026-10-01T08:00:00.000Z", releasedAt: "2026-10-01T09:30:00.000Z",
        },
        // An app whose check isn't on the order still has its released hold listed.
        { id: "ohd_other", appId: "acme.other", appName: "Address check", reason: "Unknown area", placedAt: 1_790_000_000, releasedAt: 1_790_000_600 },
      ];
      show({ ...baseOrder, appRiskChecks: checks, holds } as unknown as Order);
      const [high, medium, low, other] = items();
      expect(high!.textContent).toContain(`Hold released ${formatOrderTimestamp("2026-10-01T09:30:00.000Z")}`);
      expect(high!.querySelectorAll("time")[1]?.getAttribute("datetime")).toBe("2026-10-01T09:30:00.000Z");
      expect(medium!.textContent).not.toContain("Hold released");
      expect(low!.textContent).not.toContain("Hold released");
      expect(other!.querySelector("a")?.getAttribute("href")).toBe("/admin/apps/acme.other");
      expect(other!.textContent).toBe(`Address check${`Hold released ${formatOrderTimestamp(1_790_000_600)}`}`);

      // Released holds alone still show the section.
      show({ ...baseOrder, holds: holds.slice(2) } as unknown as Order);
      expect(container.textContent).toContain("Risk checks by apps");
      expect(items()).toHaveLength(1);
    });

    it("shows nothing when no app checked the order", () => {
      show(withChecks([]));
      expect(container.textContent).not.toContain("Risk checks by apps");
      expect(container.querySelector("time")).toBeNull();
    });

    it("speaks Bangla", () => {
      setLocale("bn");
      show(withChecks(checks));
      expect(container.textContent).toContain("অ্যাপের ঝুঁকি যাচাই");
      expect(container.textContent).toContain("বেশি ঝুঁকি");
      expect(container.textContent).toContain("শুধু পরামর্শ");
    });
  });
});
