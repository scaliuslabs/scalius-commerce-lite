import { describe, expect, it } from "vitest";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import {
  addressDraftFrom,
  addressDraftInput,
  draftInCountry,
  emptyAddressDraft,
  isAddressDraftEmpty,
  orderAddressInput,
  readAddressProblems,
} from "./address-draft";

describe("the dashboard address draft", () => {
  const bangladesh = { ...emptyAddressDraft(), line1: " House 1,  Road 2 ", city: "city_1", zone: "zone_1", cityName: "Dhaka", zoneName: "Mirpur" };
  const us = { ...emptyAddressDraft("US"), line1: "1 Infinite Loop", locality: "Cupertino", adminArea: "CA", postalCode: "95014" };

  it("sends a Bangladesh address as its street line and City/Thana/Area ids, as before", () => {
    expect(addressDraftInput(bangladesh)).toEqual({
      countryCode: "BD", name: null, company: null, line1: "House 1, Road 2", city: "city_1", zone: "zone_1", area: null,
    });
    expect(orderAddressInput(bangladesh)).toEqual({
      shippingCountryCode: "BD", shippingAddress: "House 1, Road 2", shippingCompany: null, city: "city_1", zone: "zone_1", area: null,
    });
  });

  it("sends another country's canonical fields and never Bangladesh's ids", () => {
    expect(orderAddressInput({ ...us, city: "city_1" })).toMatchObject({
      shippingCountryCode: "US", shippingAddress: "1 Infinite Loop", shippingLocality: "Cupertino", shippingAdminArea: "CA",
      shippingPostalCode: "95014", city: null, zone: null, area: null,
    });
  });

  it("keeps the lines and drops the region and places when the country changes", () => {
    expect(draftInCountry(bangladesh, "GB")).toMatchObject({ countryCode: "GB", line1: bangladesh.line1, city: null, zone: null, adminArea: "" });
    expect(draftInCountry(us, "US")).toBe(us);
  });

  it("reads a stored address and knows an empty one", () => {
    expect(addressDraftFrom({ countryCode: "US", line1: "1 Loop", postalCode: "95014" })).toMatchObject({ countryCode: "US", line1: "1 Loop", postalCode: "95014", city: null });
    expect(addressDraftFrom(null).countryCode).toBe("BD");
    expect(isAddressDraftEmpty(emptyAddressDraft("JP"))).toBe(true);
    expect(isAddressDraftEmpty(us)).toBe(false);
  });

  it("reads the fields an address refusal names, and nothing from another error", () => {
    const refused = new AdminApiResponseError("Enter the postal code.", 400, "validation_error", {
      reason: "address_invalid",
      issues: [{ field: "postalCode", code: "required" }, { field: "adminArea", code: "invalid" }],
    });
    expect(readAddressProblems(refused)).toEqual([{ field: "postalCode", code: "required" }, { field: "adminArea", code: "invalid" }]);
    expect(readAddressProblems(new AdminApiResponseError("Nope", 409))).toBeNull();
    expect(readAddressProblems(new Error("offline"))).toBeNull();
  });
});
