import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "CustomerHistoryView.tsx"), "utf8");

describe("CustomerHistoryView responsive boundaries", () => {
  it("uses separate mobile and desktop order projections with one typed route", () => {
    expect(source).toContain('className="divide-y overflow-hidden rounded-md border sm:hidden"');
    expect(source).toContain('className="hidden overflow-hidden rounded-md border sm:block"');
    expect(source).toContain('to="/admin/orders/$orderId"');
    expect(source).toContain("params={{ orderId: order.id }}");
    expect(source).not.toContain('target="_blank"');
  });

  it("keeps pagination server-backed and store-time formatting deterministic", () => {
    expect(source).not.toContain("setTimeout(");
    expect(source).not.toContain("orders.slice(");
    expect(source).toContain("getCustomerHistory({");
    expect(source).toContain("ordersPage: ordersPage.page + 1");
    expect(source).toContain("historyPage: historyPage.page + 1");
    expect(source).toContain("ordersPage.hasNextPage");
    expect(source).toContain("historyPage.hasNextPage");
    expect(source).not.toContain("suppressHydrationWarning");
    expect(source).toContain("formatAdminDate(order.createdAt)");
    expect(source).toContain("formatAdminTimestamp(record.createdAt)");
  });
});
