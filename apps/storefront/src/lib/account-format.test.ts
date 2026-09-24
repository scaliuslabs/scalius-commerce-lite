import { describe, expect, it } from "vitest";
import { accountMoney, formatAccountDate, formatDeliveryArea, openRequestLabel } from "./account-format";

describe("account display rules", () => {
  it("formats every account date in Bangladesh time with an AM/PM marker", () => {
    expect(formatAccountDate("2026-09-23T23:46:00.000Z")).toBe("24 Sep 2026, 5:46 AM");
    expect(formatAccountDate("2026-09-24T06:00:00.000Z")).toBe("24 Sep 2026, 12:00 PM");
    expect(formatAccountDate("2026-09-24T18:05:00.000Z")).toBe("25 Sep 2026, 12:05 AM");
    expect(formatAccountDate("2026-09-23T23:46:00.000Z", { time: false })).toBe("24 Sep 2026");
    expect(formatAccountDate(null)).toBe("");
    expect(formatAccountDate("not a date")).toBe("");
  });

  it("writes money with the taka sign, lakh grouping and no space", () => {
    expect(accountMoney(1080, "BDT")).toBe("৳1,080");
    expect(accountMoney(230690, "BDT")).toBe("৳2,30,690");
    expect(accountMoney(1822.5, "BDT")).toBe("৳1,822.50");
  });

  it("orders a place area, zone, then city and names open requests", () => {
    expect(formatDeliveryArea({ areaName: null, zoneName: "Mirpur", cityName: "Dhaka" })).toBe("Mirpur, Dhaka");
    expect(formatDeliveryArea({ areaName: "Mirpur 1", zoneName: "Mirpur", cityName: "Dhaka" })).toBe("Mirpur 1, Mirpur, Dhaka");
    expect(openRequestLabel("cancel_pre_shipment")).toBe("Cancellation requested");
    expect(openRequestLabel(null)).toBeNull();
  });
});
