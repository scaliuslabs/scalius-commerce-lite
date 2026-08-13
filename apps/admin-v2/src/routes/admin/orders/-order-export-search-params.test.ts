import { describe, expect, it } from "vitest";
import {
  buildOrderExportSearchParams,
  buildRecoveryExportSearchParams,
  type OrderExportSearch,
} from "./-order-export-search-params";

const fullyFilteredSearch: OrderExportSearch = {
  search: "  buyer  ",
  status: "confirmed",
  statusGroup: "open",
  paymentStatus: "unpaid",
  paymentMethod: "sslcommerz",
  fulfillmentStatus: "pending",
  paymentRecovery: "needs_attention",
  archived: true,
  sort: "createdAt",
  order: "asc",
  startDate: "2026-08-01",
  endDate: "2026-08-13",
};

describe("order export filter parity", () => {
  it("mirrors every concurrently active list filter into a recovery export", () => {
    expect(Object.fromEntries(buildRecoveryExportSearchParams(fullyFilteredSearch)!)).toEqual({
      state: "needs_attention",
      search: "buyer",
      status: "confirmed",
      statusGroup: "open",
      paymentStatus: "unpaid",
      paymentMethod: "sslcommerz",
      fulfillmentStatus: "pending",
      archived: "true",
      sort: "createdAt",
      order: "asc",
      startDate: "2026-08-01",
      endDate: "2026-08-13",
      maxRows: "1000",
    });
  });

  it("uses the same common filter values for normal and recovery exports", () => {
    const normal = buildOrderExportSearchParams(fullyFilteredSearch);
    const recovery = buildRecoveryExportSearchParams(fullyFilteredSearch)!;
    const commonKeys = [
      "search", "status", "statusGroup", "paymentStatus", "paymentMethod",
      "fulfillmentStatus", "archived", "sort", "order", "startDate", "endDate", "maxRows",
    ];
    for (const key of commonKeys) expect(recovery.get(key), key).toBe(normal.get(key));
    expect(recovery.get("state")).toBe(normal.get("paymentRecovery"));
  });

  it("does not select the recovery endpoint without a recovery filter", () => {
    expect(buildRecoveryExportSearchParams({
      ...fullyFilteredSearch,
      paymentRecovery: undefined,
    })).toBeNull();
  });
});
