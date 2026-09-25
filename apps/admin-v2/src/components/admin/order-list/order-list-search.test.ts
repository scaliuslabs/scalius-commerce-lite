import { describe, expect, it } from "vitest";
import {
  countOrderFilters,
  orderListQuery,
  orderSearchSortUpdates,
  orderViewUpdates,
  validateOrderSearch as validateTypedOrderSearch,
} from "./order-list-search";

const validateOrderSearch = (search: Record<string, unknown>) =>
  validateTypedOrderSearch(search as Parameters<typeof validateTypedOrderSearch>[0]);

const base = validateOrderSearch({});

describe("order list search", () => {
  it("filters by delivery method and counts it, dropping unknown methods", () => {
    const search = validateOrderSearch({ deliveryMethod: "pickup" });
    expect(search.deliveryMethod).toBe("pickup");
    expect(orderListQuery(search, "").deliveryMethod).toBe("pickup");
    expect(countOrderFilters(search)).toBe(1);
    expect(validateOrderSearch({ deliveryMethod: "drone" }).deliveryMethod).toBeUndefined();
    expect(orderViewUpdates("ready_for_pickup")).toMatchObject({ view: "ready_for_pickup", deliveryMethod: undefined });
  });

  it("defaults to newest first and keeps unknown tabs, filters and any search term out", () => {
    const search = validateOrderSearch({
      view: "everything",
      paymentStatus: "maybe",
      statusGroup: "open",
      search: "01712345601",
      openRequest: "true",
      archived: "true",
      startDate: "2026-13",
    });
    expect(search.view).toBeUndefined();
    expect(search.paymentStatus).toBeUndefined();
    expect(search).not.toHaveProperty("statusGroup");
    expect(search).not.toHaveProperty("search");
    expect(search.openRequest).toBe(true);
    expect(search.archived).toBe(true);
    expect(search.startDate).toBeUndefined();
    expect(base).toMatchObject({ page: 1, limit: 10, sort: "createdAt", order: "desc", archived: false, openRequest: false });
  });

  it("accepts every server-side tab and the partially refunded payment filter", () => {
    for (const view of ["unfulfilled", "ready_for_pickup", "unpaid", "cod_to_collect", "delivery_failed", "returned"]) {
      expect(validateOrderSearch({ view }).view).toBe(view);
    }
    expect(validateOrderSearch({ paymentStatus: "partially_refunded" }).paymentStatus).toBe("partially_refunded");
  });

  it("sends the tab, filters and the session search term to the list API", () => {
    expect(orderListQuery({ ...base, view: "cod_to_collect" }, "")).toMatchObject({
      view: "cod_to_collect",
      sort: "createdAt",
      order: "desc",
      search: undefined,
    });
    expect(orderListQuery({ ...base, openRequest: true, archived: true }, " 01712345601 ")).toMatchObject({
      openRequest: "true",
      archived: "true",
      search: "01712345601",
    });
    expect(orderListQuery(base, "").openRequest).toBeUndefined();
  });

  it("choosing a tab starts at page 1 without the previous tab's filters", () => {
    expect(orderViewUpdates("returned")).toMatchObject({
      view: "returned",
      status: undefined,
      paymentStatus: undefined,
      openRequest: false,
      archived: false,
      page: 1,
    });
  });

  it("sorts by best match only while searching", () => {
    expect(orderSearchSortUpdates("rahim", "", "createdAt")).toEqual({ page: 1, sort: "relevance", order: "desc" });
    expect(orderSearchSortUpdates("", "rahim", "relevance")).toEqual({ page: 1, sort: "createdAt", order: "desc" });
    expect(orderSearchSortUpdates("rahima", "rahim", "totalAmount")).toEqual({ page: 1 });
  });

  it("counts active filters for the Filters button", () => {
    expect(countOrderFilters(base)).toBe(0);
    expect(
      countOrderFilters({
        ...base,
        status: "pending",
        startDate: "2026-09-01",
        endDate: "2026-09-02",
        openRequest: true,
        archived: true,
      }),
    ).toBe(4);
  });
});
