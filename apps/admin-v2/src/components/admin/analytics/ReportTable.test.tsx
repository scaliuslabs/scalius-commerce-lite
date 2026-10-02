// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyticsReport } from "@scalius/shared/analytics-reports";
import { setLocale } from "~/i18n";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children, ...props }: { to: string; params?: Record<string, string>; children: ReactNode }) => (
    <a href={to.replace("$productId", params?.productId ?? "")} {...props}>{children}</a>
  ),
}));

import { ReportTable, type ReportTableData } from "./ReportTable";
import { formatReportCell } from "./analytics-format";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const money = (value: number) => `৳${value}`;
const products = analyticsReport("sales_by_product");

function data(overrides: Partial<ReportTableData> = {}): ReportTableData {
  return {
    report: { id: products.id, columns: [...products.columns], rowLink: "product" },
    sort: { key: "net_sales", direction: "desc" },
    page: 1,
    totalPages: 3,
    totalRows: 120,
    granularity: null,
    rows: [
      {
        id: "prod_a",
        productId: "prod_a",
        values: { product: "Panjabi", orders: 3, net_items_sold: 4, gross_sales: 2000, discounts: 100, returns: 0, net_sales: 1900, taxes: 50, total_sales: 1950 },
      },
    ],
    totals: { product: null, orders: null, net_items_sold: 8, gross_sales: 3200, discounts: 160, returns: 480, net_sales: 2560, taxes: 101, total_sales: 2661 },
    ...overrides,
  };
}

describe("report table", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onSort = vi.fn();
  const onPage = vi.fn();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    onSort.mockReset();
    onPage.mockReset();
    setLocale("en");
  });

  const render = (value: ReportTableData) => act(() => root.render(<ReportTable data={value} money={money} onSort={onSort} onPage={onPage} />));

  it("draws headings, the row linked to its product, and a totals row of the columns that add up", () => {
    render(data());
    const headings = [...container.querySelectorAll("th")].map((th) => th.textContent);
    expect(headings).toEqual(["Product", "Orders", "Items sold", "Gross sales", "Discounts", "Returns", "Net sales", "Taxes", "Total sales"]);
    expect(container.querySelector("th[aria-sort=descending]")?.textContent).toBe("Net sales");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/admin/products/prod_a/edit");
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows[1]?.textContent).toBe("Total8৳3200৳160৳480৳2560৳101৳2661");
    expect(container.textContent).toContain("120 rows");
    expect(container.textContent).toContain("Page 1 of 3");
  });

  it("sorts on the server: a heading asks for the next direction, numbers first descending", () => {
    render(data());
    act(() => container.querySelectorAll<HTMLButtonElement>("th button")[6]!.click());
    expect(onSort).toHaveBeenLastCalledWith("net_sales", "asc");
    act(() => container.querySelectorAll<HTMLButtonElement>("th button")[0]!.click());
    expect(onSort).toHaveBeenLastCalledWith("product", "asc");
    act(() => container.querySelectorAll<HTMLButtonElement>("th button")[1]!.click());
    expect(onSort).toHaveBeenLastCalledWith("orders", "desc");
  });

  it("pages with previous and next, disabled at the ends", () => {
    render(data());
    const [previous, next] = [...container.querySelectorAll<HTMLButtonElement>("button[aria-label$='page']")];
    expect(previous?.disabled).toBe(true);
    act(() => next!.click());
    expect(onPage).toHaveBeenCalledWith(2);
  });

  it("says when there is nothing for the period", () => {
    render(data({ rows: [], totalRows: 0, totalPages: 1 }));
    expect(container.textContent).toContain("Nothing to show for this period.");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
  });

  it("words in Bangla with Bangla digits", () => {
    setLocale("bn");
    render(data());
    expect(container.querySelector("th")?.textContent).toBe("পণ্য");
    expect(container.textContent).toContain("১২০টি সারি");
  });
});

describe("report cells", () => {
  const context = { t: ((key: string) => key) as never, money, granularity: null };

  it("words enums and placeholders, and shows unknown codes as they are", () => {
    const t = (key: string) => ({
      "enum.paymentMethod.cod": "Cash on delivery",
      "token.__no_delivery": "No delivery",
      "token.category": "Uncategorized",
      "token.other": "Other",
    } as Record<string, string>)[key] ?? key;
    const words = { ...context, t: t as never };
    expect(formatReportCell({ key: "payment_method", type: "enum", enum: "paymentMethod" }, "cod", {}, words)).toBe("Cash on delivery");
    expect(formatReportCell({ key: "payment_method", type: "enum", enum: "paymentMethod" }, "bkash_app", {}, words)).toBe("bkash_app");
    expect(formatReportCell({ key: "delivery_zone", type: "text" }, "__no_delivery", {}, words)).toBe("No delivery");
    expect(formatReportCell({ key: "category", type: "text" }, "", {}, words)).toBe("Uncategorized");
  });

  it("formats money, percentages, days and empty cells", () => {
    expect(formatReportCell({ key: "net_sales", type: "money" }, 1900, {}, context)).toBe("৳1900");
    expect(formatReportCell({ key: "sell_through_rate", type: "percent" }, 28.5714, {}, context)).toBe("28.6%");
    expect(formatReportCell({ key: "gross_margin", type: "percent" }, null, {}, context)).toBe("—");
  });
});
