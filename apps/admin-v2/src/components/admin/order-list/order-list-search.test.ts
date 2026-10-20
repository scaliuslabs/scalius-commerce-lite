import { describe, expect, it } from "vitest";
import {
  CLEARED_ORDER_FILTERS,
  countOrderFilters,
  orderFilterQuery,
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

  it("filters by cash, a built-in gateway or an app's method, dropping anything else", () => {
    for (const paymentMethod of ["cod", "stripe", "scalius.bangladesh:sslcommerz", "scalius.bkash:bkash"]) {
      const search = validateOrderSearch({ paymentMethod });
      expect(search.paymentMethod).toBe(paymentMethod);
      expect(orderListQuery(search, "").paymentMethod).toBe(paymentMethod);
      expect(countOrderFilters(search)).toBe(1);
    }
    for (const paymentMethod of ["bkash", "sslcommerz", "scalius.bkash:", ":bkash", "scalius.bkash:BKASH", 7]) {
      expect(validateOrderSearch({ paymentMethod }).paymentMethod).toBeUndefined();
    }
  });

  it("filters by an app's column, counts it, and clears it with the other filters", () => {
    const search = validateOrderSearch({ appFilter: "acme.crm/tier:gold" });
    expect(search.appFilter).toBe("acme.crm/tier:gold");
    expect(orderListQuery(search, "").appFilter).toBe("acme.crm/tier:gold");
    expect(orderFilterQuery(search, "").appFilter).toBe("acme.crm/tier:gold");
    expect(countOrderFilters(search)).toBe(1);
    expect(CLEARED_ORDER_FILTERS).toHaveProperty("appFilter", undefined);
    expect(orderViewUpdates("unpaid")).toHaveProperty("appFilter", undefined);
    // A malformed filter never reaches the API, and no filter sends no parameter.
    expect(validateOrderSearch({ appFilter: "gold" }).appFilter).toBeUndefined();
    expect(orderListQuery(base, "").appFilter).toBeUndefined();
    expect(orderListQuery(base, "")).not.toHaveProperty("appColumns");
  });

  it("filters by sales channel and counts it, dropping unknown channels", () => {
    const search = validateOrderSearch({ channel: "admin" });
    expect(search.channel).toBe("admin");
    expect(orderListQuery(search, "").channel).toBe("admin");
    expect(countOrderFilters(search)).toBe(1);
    expect(orderListQuery(base, "").channel).toBeUndefined();
    for (const channel of ["online_store", "admin", "pos", "agent", "app"]) {
      expect(validateOrderSearch({ channel }).channel).toBe(channel);
    }
    expect(validateOrderSearch({ channel: "dashboard" }).channel).toBeUndefined();
    expect(orderViewUpdates("unpaid")).toMatchObject({ view: "unpaid", channel: undefined });
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
    expect(base).toMatchObject({ page: 1, limit: 50, sort: "createdAt", order: "desc", archived: false, openRequest: false });
  });

  it("accepts every server-side tab and the partially refunded payment filter", () => {
    for (const view of ["unfulfilled", "ready_for_pickup", "unpaid", "overdue", "cod_to_collect", "delivery_failed", "returned"]) {
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

  it("asks for a numbered page, or for the rows after/before a cursor, never both", () => {
    expect(orderListQuery(base, "")).toMatchObject({ page: 1, limit: 50 });
    expect(orderListQuery(base, "")).not.toHaveProperty("after");
    const next = orderListQuery(validateOrderSearch({ after: "end-cursor", page: "3" }), "");
    expect(next).toMatchObject({ after: "end-cursor", limit: 50 });
    expect(next).not.toHaveProperty("page");
    const previous = orderListQuery(validateOrderSearch({ before: "start-cursor" }), "");
    expect(previous).toMatchObject({ before: "start-cursor" });
    expect(previous).not.toHaveProperty("page");
    // Filters and sort ride along with the cursor.
    expect(orderListQuery(validateOrderSearch({ after: "c", sort: "totalAmount", order: "asc", status: "pending" }), "rahim"))
      .toMatchObject({ after: "c", sort: "totalAmount", order: "asc", status: "pending", search: "rahim" });
  });

  it("keeps the cursor out of the filters the export and 'select all' reuse", () => {
    const filters = orderFilterQuery(validateOrderSearch({ after: "c", status: "pending" }), "");
    expect(filters).not.toHaveProperty("after");
    expect(filters).not.toHaveProperty("before");
    expect(filters).not.toHaveProperty("page");
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
