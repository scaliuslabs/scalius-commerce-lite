import { describe, expect, it } from "vitest";
import { countryDraftsOf, countryIssue, rateErrors, toRateInput, zoneRegionsBody } from "./DeliveryZones";

const rate = (patch: Partial<Parameters<typeof rateErrors>[0]> = {}) => ({
  key: "k",
  id: null,
  kind: "delivery" as const,
  name: "Inside Dhaka",
  fee: "60",
  freeOver: "",
  rateSource: "flat",
  rateService: "",
  fallbackFee: "",
  description: "",
  pickupAddress: "",
  pickupHours: "",
  isActive: true,
  ...patch,
});

describe("delivery charge validation", () => {
  it("accepts Bangla digits and an empty free-over amount", () => {
    expect(rateErrors(rate({ fee: "৬০" }), true)).toEqual({});
  });

  it("refuses paisa in a taka charge or free-over amount, and keeps decimals for other currencies", () => {
    expect(rateErrors(rate({ fee: "৬০.৫০", freeOver: "999.99" }), true)).toEqual({ fee: "wholeTaka", freeOver: "wholeTaka" });
    expect(rateErrors(rate({ fee: "60.00", freeOver: "1000" }), true)).toEqual({});
    expect(rateErrors(rate({ fee: "৬০.৫০" }), false)).toEqual({});
  });

  it("bounds the charge and the free-over amount at ৳1,00,000", () => {
    expect(rateErrors(rate({ fee: "99999999999" }))).toEqual({ fee: "feeTooHigh" });
    expect(rateErrors(rate({ fee: "100000", freeOver: "100000.01" }))).toEqual({ freeOver: "freeOverTooHigh" });
    expect(rateErrors(rate({ fee: "60.555", freeOver: "abc" }))).toEqual({ fee: "feeInvalid", freeOver: "feeInvalid" });
  });

  it("treats an empty pickup charge as free, but still needs a delivery charge", () => {
    expect(rateErrors(rate({ kind: "pickup", fee: "", pickupAddress: "House 1, Dhanmondi" }))).toEqual({});
    expect(rateErrors(rate({ kind: "pickup", fee: "abc", pickupAddress: "House 1, Dhanmondi" }))).toEqual({ fee: "feeInvalid" });
    expect(rateErrors(rate({ fee: "" }))).toEqual({ fee: "feeInvalid" });
  });

  it("needs a name and, for pickup, the pickup address", () => {
    expect(rateErrors(rate({ name: " ", kind: "pickup", fee: "0" }))).toEqual({
      name: "rateNameRequired",
      pickupAddress: "pickupAddressRequired",
    });
  });

  it("lets a courier calculate a rate without a fixed charge and keeps fallback opt-in", () => {
    const calculated = rate({ rateSource: "example.courier:express", fee: "", rateService: " next-day " });
    expect(rateErrors(calculated)).toEqual({});
    expect(toRateInput(calculated)).toMatchObject({ rateSource: "example.courier:express", fee: 0, rateService: "next-day", fallbackFee: null });
    expect(toRateInput({ ...calculated, fallbackFee: "০" })).toMatchObject({ fallbackFee: 0 });
    expect(toRateInput({ ...calculated, rateService: " " })).toMatchObject({ rateService: null });
  });

  it("validates a courier fallback with the same currency rules as fixed charges", () => {
    const calculated = rate({ rateSource: "example.courier:express", fee: "" });
    expect(rateErrors({ ...calculated, fallbackFee: "abc" })).toEqual({ fallbackFee: "feeInvalid" });
    expect(rateErrors({ ...calculated, fallbackFee: "100001" })).toEqual({ fallbackFee: "feeTooHigh" });
    expect(rateErrors({ ...calculated, fallbackFee: "৬০.৫০" }, true)).toEqual({ fallbackFee: "wholeTaka" });
    expect(rateErrors({ ...calculated, fallbackFee: "৬০.৫০" }, false)).toEqual({});
  });

  it("clears courier-only fields when returning to fixed charges or pickup", () => {
    const saved = rate({ rateService: "next-day", fallbackFee: "60" });
    expect(toRateInput(saved)).toMatchObject({ rateSource: "flat", rateService: null, fallbackFee: null, fee: 60 });
    expect(toRateInput({ ...saved, kind: "pickup", rateSource: "example.courier:express" }))
      .toMatchObject({ rateSource: "flat", rateService: null, fallbackFee: null, fee: 60 });
  });
});

describe("zone countries", () => {
  const dhaka = { id: "city_dhaka", name: "Dhaka", type: "city" as const, parentName: null };
  const region = (countryCode: string, adminArea: string | null = null, postalPrefix: string | null = null) =>
    ({ countryCode, adminArea, postalPrefix });

  it("groups a zone's regions by country, and shows Bangladesh delivery areas as part of Bangladesh", () => {
    expect(countryDraftsOf({
      regions: [region("US", "CA"), region("US", null, "941"), region("US", "NY"), region("FR")],
      locations: [dhaka],
    })).toEqual([
      { code: "BD", whole: false, adminAreas: [], postalPrefixes: "" },
      { code: "FR", whole: true, adminAreas: [], postalPrefixes: "" },
      { code: "US", whole: false, adminAreas: ["CA", "NY"], postalPrefixes: "941" },
    ]);
    expect(countryDraftsOf(null)).toEqual([]);
  });

  it("sends a whole country alone, the parts of another, and Bangladesh areas only for part of Bangladesh", () => {
    expect(zoneRegionsBody([
      { code: "BD", whole: false, adminAreas: [], postalPrefixes: "" },
      { code: "FR", whole: true, adminAreas: ["IDF"], postalPrefixes: "75" },
      { code: "US", whole: false, adminAreas: ["CA"], postalPrefixes: " 941, 100;941 " },
    ], [dhaka])).toEqual({
      regions: [
        { countryCode: "FR" },
        { countryCode: "US", adminArea: "CA" },
        { countryCode: "US", postalPrefix: "941" },
        { countryCode: "US", postalPrefix: "100" },
      ],
      locationIds: ["city_dhaka"],
    });
    expect(zoneRegionsBody([{ code: "BD", whole: true, adminAreas: [], postalPrefixes: "" }], [dhaka]))
      .toEqual({ regions: [{ countryCode: "BD" }], locationIds: [] });
  });

  it("needs a region or postal code for part of a country, and a delivery area for part of Bangladesh", () => {
    expect(countryIssue({ code: "US", whole: false, adminAreas: [], postalPrefixes: " , " }, [])).toBe("partRequired");
    expect(countryIssue({ code: "US", whole: false, adminAreas: [], postalPrefixes: "941" }, [])).toBeNull();
    expect(countryIssue({ code: "BD", whole: false, adminAreas: [], postalPrefixes: "" }, [])).toBe("placesRequiredFor");
    expect(countryIssue({ code: "BD", whole: false, adminAreas: [], postalPrefixes: "" }, [dhaka])).toBeNull();
    expect(countryIssue({ code: "JP", whole: true, adminAreas: [], postalPrefixes: "" }, [])).toBeNull();
  });
});
