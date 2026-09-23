import { describe, expect, it } from "vitest";
import {
  countOrderFilters,
  orderFilterUpdates,
  orderListQuery,
  orderSearchUpdates,
  orderViewUpdates,
  validateOrderSearch as validateTypedOrderSearch,
} from "./order-list-search";

const validateOrderSearch = (search: Record<string, unknown>) =>
  validateTypedOrderSearch(search as Parameters<typeof validateTypedOrderSearch>[0]);

const base = validateOrderSearch({});

describe("order list search", () => {
  it("normalizes unknown tabs and filters away", () => {
    const search = validateOrderSearch({
      view: "everything",
      paymentStatus: "maybe",
      statusGroup: "open",
      archived: "true",
      startDate: "2026-13",
    });
    expect(search.view).toBeUndefined();
    expect(search.paymentStatus).toBeUndefined();
    expect(search.statusGroup).toBe("open");
    expect(search.archived).toBe(true);
    expect(search.startDate).toBeUndefined();
    expect(base).toMatchObject({ page: 1, limit: 10, sort: "updatedAt", order: "desc", archived: false });
  });

  it("merges the tab preset into the list API params", () => {
    expect(orderListQuery({ ...base, view: "unfulfilled" })).toMatchObject({ statusGroup: "open" });
    expect(orderListQuery({ ...base, view: "unpaid" })).toMatchObject({ paymentStatus: "unpaid" });
    expect(orderListQuery(base).statusGroup).toBeUndefined();
    expect(orderListQuery({ ...base, archived: true }).archived).toBe("true");
    // An explicit filter wins over the preset.
    const exact = orderListQuery({ ...base, view: "unfulfilled", status: "shipped" });
    expect(exact.status).toBe("shipped");
    expect(exact.statusGroup).toBeUndefined();
  });

  it("choosing a tab resets the page and clears the filters it replaces", () => {
    expect(orderViewUpdates("unpaid")).toEqual({
      view: "unpaid",
      status: undefined,
      statusGroup: undefined,
      paymentStatus: undefined,
      page: 1,
    });
  });

  it("a contradicting filter leaves the tab; others keep it", () => {
    expect(orderFilterUpdates({ view: "unpaid" }, { paymentStatus: "paid" })).toEqual({
      paymentStatus: "paid",
      page: 1,
      view: undefined,
    });
    expect(orderFilterUpdates({ view: "unfulfilled" }, { status: "pending" }).view).toBeUndefined();
    expect(orderFilterUpdates({ view: "unpaid" }, { paymentMethod: "cod" })).toEqual({
      paymentMethod: "cod",
      page: 1,
    });
  });

  it("sorts by best match only while searching", () => {
    expect(orderSearchUpdates("rahim", base)).toEqual({
      search: "rahim",
      page: 1,
      sort: "relevance",
      order: "desc",
    });
    expect(orderSearchUpdates("", { search: "rahim", sort: "relevance" })).toEqual({
      search: "",
      page: 1,
      sort: "updatedAt",
      order: "desc",
    });
    expect(orderSearchUpdates("rahima", { search: "rahim", sort: "totalAmount" })).toEqual({
      search: "rahima",
      page: 1,
    });
  });

  it("counts active filters for the Filters button", () => {
    expect(countOrderFilters(base)).toBe(0);
    expect(
      countOrderFilters({ ...base, status: "pending", startDate: "2026-09-01", endDate: "2026-09-02", archived: true }),
    ).toBe(3);
  });
});
