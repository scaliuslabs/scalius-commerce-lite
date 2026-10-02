import { describe, expect, it } from "vitest";
import { buildCustomerExportParams, CUSTOMER_EXPORT_MAX_ROWS } from "./customer-export";

describe("customers export request", () => {
  it("exports exactly the chosen customers", () => {
    expect(Object.fromEntries(buildCustomerExportParams({ filters: { tag: "vip" }, ids: ["cus_1", "cus_2"] }))).toEqual({
      ids: "cus_1,cus_2",
      maxRows: "2",
    });
  });

  it("exports everyone matching the tab and filters, up to the server's cap", () => {
    expect(Object.fromEntries(buildCustomerExportParams({
      filters: { tag: "vip", segmentId: "seg_1", subscribed: "sms" },
      ids: null,
    }))).toEqual({ tag: "vip", segmentId: "seg_1", subscribed: "sms", maxRows: String(CUSTOMER_EXPORT_MAX_ROWS) });
    expect(Object.fromEntries(buildCustomerExportParams({ filters: {}, ids: null }))).toEqual({ maxRows: "10000" });
  });

  it("refuses more chosen customers than one request takes", () => {
    const ids = Array.from({ length: 101 }, (_, index) => `cus_${index}`);
    expect(() => buildCustomerExportParams({ filters: {}, ids })).toThrow(RangeError);
    expect(() => buildCustomerExportParams({ filters: {}, ids: [] })).toThrow(RangeError);
  });
});
