import { describe, expect, it } from "vitest";
import { buildOrderExportParams } from "./order-export";

const filters = {
  search: "01712345601",
  view: "unpaid" as const,
  openRequest: "true" as const,
  status: undefined,
  paymentStatus: "partially_refunded" as const,
  sort: "createdAt" as const,
  order: "desc" as const,
  archived: undefined,
  startDate: "2026-09-01",
};

describe("order export request", () => {
  it("exports every matching order with the list's filters and search, up to the server cap", () => {
    expect(Object.fromEntries(buildOrderExportParams({ filters, ids: null, format: "items" }))).toEqual({
      format: "items",
      search: "01712345601",
      view: "unpaid",
      openRequest: "true",
      paymentStatus: "partially_refunded",
      sort: "createdAt",
      order: "desc",
      startDate: "2026-09-01",
      maxRows: "5000",
    });
  });

  it("exports exactly the page or the selection by id, without filters", () => {
    expect(Object.fromEntries(buildOrderExportParams({ filters, ids: ["A1", "B2"], format: "summary" }))).toEqual({
      format: "summary",
      ids: "A1,B2",
      maxRows: "2",
    });
  });
});
