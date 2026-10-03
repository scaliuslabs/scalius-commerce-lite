import { describe, expect, it } from "vitest";

import {
  deliveryHierarchyCanonicalFields,
  formatAddressInline,
  usesDeliveryHierarchy,
  validatePostalAddress,
} from "./address";
import {
  ADDRESS_COUNTRY_CODES,
  ADDRESS_METADATA_SOURCE,
  addressRowsOfFormat,
  addressRulesFor,
  countriesRequiringAddressField,
  formatAddressLines,
} from "./address-metadata";
import { validateAndFormatPhone } from "./customer-utils";

describe("country address rules (libaddressinput)", () => {
  it("records its source and licence and knows every country", () => {
    expect(ADDRESS_METADATA_SOURCE).toMatchObject({ repository: "https://github.com/google/libaddressinput", licence: "Apache-2.0" });
    expect(ADDRESS_METADATA_SOURCE.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(ADDRESS_COUNTRY_CODES.length).toBeGreaterThan(240);
    for (const code of ["BD", "US", "GB", "IN", "JP", "AE", "HK", "IE", "BR", "SG", "DE"]) expect(ADDRESS_COUNTRY_CODES).toContain(code);
  });

  it("refuses an unknown or malformed country", () => {
    expect(addressRulesFor("ZZ")).toBeNull();
    expect(addressRulesFor("XX")).toBeNull();
    expect(addressRulesFor("bd'--")).toBeNull();
    expect(addressRulesFor(null)).toBeNull();
    expect(validatePostalAddress({ countryCode: "QQ", line1: "1 Road" }, addressRulesFor("QQ")).issues)
      .toEqual([{ field: "countryCode", code: "unknown_country" }]);
  });

  it("gives Saleor's shape: allowed, required, postal pattern, examples, labels and field order", () => {
    const us = addressRulesFor("us")!;
    expect(us.countryCode).toBe("US");
    expect(us.requiredFields).toEqual(["line1", "locality", "adminArea", "postalCode"]);
    expect(us.allowedFields).toEqual(["name", "company", "line1", "line2", "locality", "adminArea", "postalCode"]);
    expect(us.rows).toEqual([["name"], ["company"], ["line1"], ["line2"], ["locality", "adminArea", "postalCode"]]);
    expect(us.labels).toEqual({ adminArea: "state", locality: "city", dependentLocality: "suburb", postalCode: "zip" });
    expect(us.postalCodeExamples).toContain("95014");
    expect(us.adminAreas).toContainEqual({ code: "CA", name: "California", isoCode: null });

    const bd = addressRulesFor("BD")!;
    expect(bd.requiredFields).toEqual(["line1", "locality"]);
    expect(bd.postalCodePattern).toBe("\\d{4}");
    expect(bd.adminAreas).toEqual([]);

    // Japan starts with the postal code; the UAE has no postal code and requires the emirate.
    expect(addressRulesFor("JP")!.rows[0]).toEqual(["postalCode"]);
    const ae = addressRulesFor("AE")!;
    expect(ae.allowedFields).not.toContain("postalCode");
    expect(ae.requiredFields).toEqual(["line1", "adminArea"]);
    expect(ae.labels.adminArea).toBe("emirate");
    expect(addressRulesFor("IE")!.labels.postalCode).toBe("eircode");
    expect(addressRulesFor("GB")!.labels.locality).toBe("post_town");
  });

  it("drops literals and letters it does not model from form rows", () => {
    expect(addressRowsOfFormat("%N%n%O%n%A%nSINGAPORE %Z")).toEqual([["name"], ["company"], ["line1"], ["line2"], ["postalCode"]]);
    expect(addressRowsOfFormat("%N%n%A%n%C %X")).toEqual([["name"], ["line1"], ["line2"], ["locality"]]);
  });

  it("lists the countries that require each field (the shipping-address trigger's lists)", () => {
    expect(countriesRequiringAddressField("postalCode")).toEqual(expect.arrayContaining(["US", "GB", "IN", "JP"]));
    expect(countriesRequiringAddressField("postalCode")).not.toContain("BD");
    expect(countriesRequiringAddressField("adminArea")).toEqual(expect.arrayContaining(["US", "AE", "IN"]));
    expect(countriesRequiringAddressField("locality")).toContain("BD");
    expect(countriesRequiringAddressField("locality")).not.toContain("SG");
  });
});

describe("validatePostalAddress", () => {
  const us = addressRulesFor("US")!;

  it("requires the country's required fields", () => {
    const { issues } = validatePostalAddress({ countryCode: "US", line1: "1 Infinite Loop" }, us);
    expect(issues).toEqual([
      { field: "locality", code: "required" },
      { field: "adminArea", code: "required" },
      { field: "postalCode", code: "required" },
    ]);
  });

  it("accepts optional fields absent and normalizes what is present", () => {
    const { address, issues } = validatePostalAddress({
      countryCode: " us ",
      line1: "  1  Infinite   Loop ",
      locality: "Cupertino",
      adminArea: "california",
      postalCode: " 95014 ",
      dependentLocality: "Ignored: the US does not use it",
    }, us);
    expect(issues).toEqual([]);
    expect(address).toEqual({
      countryCode: "US",
      name: null,
      company: null,
      line1: "1 Infinite Loop",
      line2: null,
      dependentLocality: null,
      locality: "Cupertino",
      adminArea: "CA",
      postalCode: "95014",
      validationSkipped: false,
    });
  });

  it("checks the postal code pattern and the admin area list", () => {
    const { issues } = validatePostalAddress({ countryCode: "US", line1: "x", locality: "y", adminArea: "Narnia", postalCode: "ABCDE" }, us);
    expect(issues).toEqual([{ field: "postalCode", code: "invalid" }, { field: "adminArea", code: "invalid" }]);
    expect(validatePostalAddress({ countryCode: "GB", line1: "1 High St", locality: "London", postalCode: "ec1y 8sy" }, addressRulesFor("GB")).issues).toEqual([]);
  });

  it("keeps a staff address that breaks the rules, marked, but never a too-long value", () => {
    const skipped = validatePostalAddress({ countryCode: "US", line1: "1 Infinite Loop" }, us, { skipValidation: true });
    expect(skipped.issues).toEqual([]);
    expect(skipped.address.validationSkipped).toBe(true);
    const valid = validatePostalAddress({ countryCode: "US", line1: "1 Infinite Loop", locality: "Cupertino", adminArea: "CA", postalCode: "95014" }, us, { skipValidation: true });
    expect(valid.address.validationSkipped).toBe(false);
    const tooLong = validatePostalAddress({ countryCode: "US", line1: "x".repeat(501) }, us, { skipValidation: true });
    expect(tooLong.issues).toContainEqual({ field: "line1", code: "too_long" });
  });
});

describe("the Bangladesh adapter", () => {
  it("fills the locality and dependent locality from the picked names, never an admin area", () => {
    expect(deliveryHierarchyCanonicalFields({ cityName: " Dhaka ", zoneName: "Dhanmondi" }))
      .toEqual({ countryCode: "BD", locality: "Dhaka", dependentLocality: "Dhanmondi" });
    expect(usesDeliveryHierarchy("BD")).toBe(true);
    expect(usesDeliveryHierarchy(null)).toBe(true);
    expect(usesDeliveryHierarchy("IN")).toBe(false);
  });

  it("round-trips: an adapter address is a valid Bangladesh address", () => {
    const picked = { city: "loc_city", zone: "loc_zone", area: null, cityName: "Dhaka", zoneName: "Dhanmondi", areaName: null };
    const canonical = { ...deliveryHierarchyCanonicalFields(picked), line1: "House 12, Road 5" };
    const { address, issues } = validatePostalAddress(canonical, addressRulesFor("BD"));
    expect(issues).toEqual([]);
    expect(address).toMatchObject({ countryCode: "BD", locality: "Dhaka", dependentLocality: null, adminArea: null });
    // BD's format has no dependent locality: the thana stays in the adapter, which the inline format reads.
    expect(formatAddressInline({ ...picked, ...canonical })).toBe("House 12, Road 5, Dhanmondi, Dhaka");
  });

  it("reads a Bangladesh address exactly as before (line, area, thana, city)", () => {
    expect(formatAddressInline({ line1: "House 1", areaName: "Road 27", zoneName: "Dhanmondi", cityName: "Dhaka" }))
      .toBe("House 1, Road 27, Dhanmondi, Dhaka");
    expect(formatAddressInline({ countryCode: "BD", line1: "House 1", area: "area_id", zoneName: null, zone: "zone_id", cityName: "Dhaka" }))
      .toBe("House 1, area_id, zone_id, Dhaka");
  });
});

describe("formatting other countries", () => {
  it("reads one line with the country name", () => {
    expect(formatAddressInline(
      { countryCode: "US", line1: "1 Infinite Loop", locality: "Cupertino", adminArea: "CA", postalCode: "95014" },
      { countryName: () => "United States" },
    )).toBe("1 Infinite Loop, Cupertino, CA 95014, United States");
  });

  it("prints label lines in the country's format", () => {
    expect(formatAddressLines(
      { name: "Tim", line1: "1 Infinite Loop", locality: "Cupertino", adminArea: "CA", postalCode: "95014" },
      addressRulesFor("US")!,
    )).toEqual(["Tim", "1 Infinite Loop", "CUPERTINO, CA 95014"]);
    expect(formatAddressLines({ line1: "1 Rd", locality: "Dhaka" }, addressRulesFor("BD")!)).toEqual(["1 Rd", "DHAKA"]);
  });
});

describe("phones in the address country", () => {
  it("reads a national number in the address country", () => {
    expect(validateAndFormatPhone("07911 123456", undefined, { defaultCountry: "GB" })).toBe("+447911123456");
    expect(validateAndFormatPhone("98765 43210", undefined, { defaultCountry: "IN" })).toBe("+919876543210");
    expect(validateAndFormatPhone("+1 415 555 2671", undefined, { defaultCountry: "GB" })).toBe("+14155552671");
  });

  it("keeps Bangladesh's rules without a country or with BD", () => {
    expect(validateAndFormatPhone("01712-345678")).toBe("+8801712345678");
    expect(validateAndFormatPhone("01712-345678", undefined, { defaultCountry: "BD" })).toBe("+8801712345678");
    expect(() => validateAndFormatPhone("02-9876543", undefined, { defaultCountry: "BD" })).toThrow("Bangladeshi mobile");
    expect(() => validateAndFormatPhone("+880 2 9876543", undefined, { defaultCountry: "GB" })).toThrow("Bangladeshi mobile");
    expect(validateAndFormatPhone("+8801712345678", undefined, { defaultCountry: "IN" })).toBe("+8801712345678");
  });

  it("refuses an invalid number for the country", () => {
    expect(() => validateAndFormatPhone("12345", undefined, { defaultCountry: "US" })).toThrow();
  });
});
