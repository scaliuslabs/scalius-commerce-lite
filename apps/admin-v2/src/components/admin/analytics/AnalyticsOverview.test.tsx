// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsOverview as OverviewData } from "~/lib/api-query-options/analytics";
import { setLocale, translate } from "~/i18n";
import { analyticsMessages, type AnalyticsMessageKey } from "~/i18n/analytics";

const measures = (totalSales: number, orders: number) => ({
  orders,
  grossSales: totalSales,
  discounts: 0,
  returns: 0,
  netSales: totalSales,
  shipping: 0,
  taxes: 0,
  totalSales,
  netItemsSold: orders,
  averageOrderValue: orders ? totalSales / orders : 0,
});

const period = (from: string, to: string, totalSales: number, orders: number) => ({
  range: { from, to },
  totals: measures(totalSales, orders),
  customers: { customers: 3, newCustomers: 2, returningCustomers: 1, repeatPurchaseRate: 33.3 },
  payments: { codOrders: 3, prepaidOrders: 1, codShare: 75, returnedToSender: 1, codDelivered: 1, rtsRate: 50, refunded: 200 },
  cancellations: { placed: 5, cancelled: 1, cancellationRate: 20 },
  otherCurrencyOrders: 0,
});

const overview: OverviewData = {
  currency: { code: "BDT", decimalPlaces: 2 },
  granularity: "day",
  comparison: "previous_period",
  current: { ...period("2026-08-01", "2026-08-03", 3000, 4), otherCurrencyOrders: 2 },
  previous: period("2026-07-29", "2026-07-31", 2000, 2),
  breakdowns: {
    // The dashboard channel has two rows: no source, and a merchant's own label.
    channel: [
      { key: "online_store", label: "", ...measures(2000, 2) },
      { key: "admin", label: "", ...measures(500, 1) },
      { key: "admin", label: "facebook", ...measures(500, 1) },
    ],
    paymentMethod: [{ key: "cod", label: "", ...measures(3000, 4) }],
    city: [{ key: "", label: "", ...measures(3000, 4) }],
    deliveryZone: [{ key: "__pickup", label: "", ...measures(3000, 4) }],
    location: [{ key: "loc_default", label: "Main location", ...measures(3000, 4) }],
  },
  series: [
    { key: "2026-08-01", current: { orders: 1, grossSales: 1000, discounts: 0, returns: 0, netSales: 1000, totalSales: 1000 }, previousKey: "2026-07-29", previous: { orders: 1, grossSales: 500, discounts: 0, returns: 0, netSales: 500, totalSales: 500 } },
    { key: "2026-08-02", current: { orders: 2, grossSales: 1500, discounts: 0, returns: 0, netSales: 1500, totalSales: 1500 }, previousKey: "2026-07-30", previous: { orders: 0, grossSales: 0, discounts: 0, returns: 0, netSales: 0, totalSales: 0 } },
    { key: "2026-08-03", current: { orders: 1, grossSales: 500, discounts: 0, returns: 0, netSales: 500, totalSales: 500 }, previousKey: "2026-07-31", previous: { orders: 1, grossSales: 1500, discounts: 0, returns: 0, netSales: 1500, totalSales: 1500 } },
  ],
} as OverviewData;

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-query")>(),
  useQuery: () => ({ data: overview, isError: false, isFetching: false, refetch: vi.fn() }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));
vi.mock("~/hooks/use-currency", () => ({ useCurrency: () => ({ fmt: (value: number) => `৳${value}` }) }));
vi.mock("~/hooks/use-media-query", () => ({ useMediaQuery: () => false }));

import { AnalyticsOverview, breakdownRow } from "./AnalyticsOverview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("analytics overview page", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(
      <AnalyticsOverview
        selection={{ from: "2026-08-01", to: "2026-08-03", comparison: "previous_period", granularity: null }}
        today="2026-08-03"
        granularity="day"
        onChange={vi.fn()}
      />,
    ));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    setLocale("en");
  });

  it("leads with the four sales tiles and their change against the previous period", () => {
    const text = container.textContent ?? "";
    expect(text).toContain("Total sales৳3000");
    expect(text).toContain("Up 50%");
    expect(text).toContain("Orders4");
    expect(text).toContain("Up 100%");
    expect(text).toContain("2 orders in another currency aren't included in these numbers.");
  });

  it("words the breakdowns: channels with their source, placeholders for unnamed rows", () => {
    const text = container.textContent ?? "";
    expect(text).toContain("Online store");
    expect(text).toContain("Dashboard · facebook");
    expect(text).toContain("Cash on delivery");
    expect(text).toContain("No delivery address");
    expect(text).toContain("Pickup");
    expect(text).toContain("Main location");
    expect(text).toContain("1 returned of 2 delivered or returned");
  });

  it("switches the chart between sales and order counts", () => {
    const orders = [...container.querySelectorAll("button")].find((button) => button.textContent === "Orders")!;
    act(() => orders.click());
    expect(orders.getAttribute("aria-pressed")).toBe("true");
    act(() => container.querySelector<SVGElement>("svg[role=img]")!.focus());
    // The last day: one order now, one in the comparison day.
    expect(container.querySelector("[role=status]")?.textContent).toMatch(/^1.*1/);
  });

  it("offers the table view and every breakdown's report", () => {
    const links = [...container.querySelectorAll("a")].map((link) => link.textContent);
    expect(links).toContain("View as table");
    expect(links.filter((label) => label === "View report")).toHaveLength(5);
  });

  it("lists a channel once per source, without two rows sharing a React key", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const fresh = document.createElement("div");
    document.body.append(fresh);
    const freshRoot = createRoot(fresh);
    act(() => freshRoot.render(
      <AnalyticsOverview
        selection={{ from: "2026-08-01", to: "2026-08-03", comparison: "previous_period", granularity: null }}
        today="2026-08-03"
        granularity="day"
        onChange={vi.fn()}
      />,
    ));
    const dashboardRows = [...fresh.querySelectorAll("li")].map((row) => row.textContent ?? "").filter((text) => text.startsWith("Dashboard"));
    act(() => freshRoot.unmount());
    fresh.remove();
    const sameKey = errors.mock.calls.filter(([message]) => String(message).includes("same key"));
    errors.mockRestore();
    expect(sameKey).toEqual([]);
    expect(dashboardRows).toHaveLength(2);
  });
});

describe("breakdown row keys", () => {
  const t = (key: AnalyticsMessageKey, vars?: Record<string, string | number>) => translate(analyticsMessages, key, vars);
  const row = (key: string, label: string) => ({ key, label, ...measures(100, 1) });

  it("are unique for rows that share one key but differ in label: a channel's sources, a zone's names", () => {
    const cases: Array<[Parameters<typeof breakdownRow>[2], Array<ReturnType<typeof row>>]> = [
      ["channel", [row("admin", ""), row("admin", "facebook"), row("admin", "phone"), row("online_store", "")]],
      ["zone", [row("__no_delivery", ""), row("__no_delivery", "Dhaka"), row("zone_a", "Dhaka"), row("__other", "")]],
      ["paymentMethod", [row("cod", ""), row("sslcommerz", ""), row("__other", "")]],
      ["city", [row("", ""), row("Dhaka", "Dhaka"), row("Dhaka|", "Dhaka|")]],
      ["location", [row("", ""), row("loc_a", "Main location"), row("loc_b", "Main location")]],
    ];
    for (const [kind, rows] of cases) {
      const keys = rows.map((item) => breakdownRow(item, t, kind).key);
      expect(new Set(keys).size, kind).toBe(keys.length);
    }
  });
});
