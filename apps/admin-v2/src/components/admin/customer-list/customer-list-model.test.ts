import { describe, expect, it } from "vitest";

import {
  formatCustomerLocation,
  type CustomerListBuyer,
} from "./customer-list-model";

function buyer(overrides: Partial<CustomerListBuyer> = {}): CustomerListBuyer {
  return {
    id: "cust_1",
    name: "Release Audit Customer",
    email: null,
    phone: "+8801700000020",
    address: "House 20, Road 7",
    city: "dhaka",
    zone: "dhanmondi",
    area: null,
    cityName: "Dhaka",
    zoneName: "Dhanmondi",
    areaName: null,
    totalOrders: 1,
    totalSpent: 0,
    lastOrderAt: "2026-07-20T00:00:00.000Z",
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    accountClaimedAt: null,
    ...overrides,
  };
}

describe("customer list presentation", () => {
  it("appends structured location names to a street address", () => {
    expect(formatCustomerLocation(buyer())).toBe(
      "House 20, Road 7, Dhanmondi, Dhaka",
    );
  });

  it("does not repeat city or zone already present in the address", () => {
    expect(formatCustomerLocation(buyer({
      address: "House 20, Road 7, Dhanmondi, Dhaka",
    }))).toBe("House 20, Road 7, Dhanmondi, Dhaka");
  });

  it("deduplicates location segments without changing their display casing", () => {
    expect(formatCustomerLocation(buyer({
      address: "House 20, DHAKA",
      cityName: "Dhaka",
      zoneName: null,
    }))).toBe("House 20, DHAKA");
  });
});
