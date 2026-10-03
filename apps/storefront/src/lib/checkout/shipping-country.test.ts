import { describe, expect, it } from "vitest";
import { checkoutAddressForMode, missingCheckoutFields } from "./delivery-mode";
import { defaultShippingCountry, shippingCountryOf, storeShippingCountries } from "./shipping-country";

const market = (id: string, countries: string[], presences: string[] = []) => ({
  id, handle: id, name: id, isBackup: id === "backup", countries, presences: presences.map((value) => ({ value, locale: "en" })),
});

describe("the shipping country", () => {
  it("is Bangladesh alone for a store whose markets sell only there (no country field)", () => {
    expect(storeShippingCountries({ markets: [market("backup", ["BD"], [""])] })).toEqual(["BD"]);
    expect(storeShippingCountries(undefined)).toEqual(["BD"]);
    expect(storeShippingCountries({ markets: [market("backup", ["BD"]), market("in", ["IN", "NP"])] })).toEqual(["BD", "IN", "NP"]);
  });

  it("starts on the page market's country, else Bangladesh, else the first", () => {
    const matrix = { markets: [market("backup", ["BD"], [""]), market("in", ["IN"], ["en-in"])] };
    expect(defaultShippingCountry(matrix, "en-in", ["BD", "IN"])).toBe("IN");
    expect(defaultShippingCountry(matrix, null, ["BD", "IN"])).toBe("BD");
    expect(defaultShippingCountry({ markets: [market("us", ["US"])] }, null, ["US"])).toBe("US");
    expect(shippingCountryOf(" us ")).toBe("US");
    expect(shippingCountryOf("<x>")).toBe("BD");
  });

  it("asks City and Thana only in Bangladesh, and sends another country's fields without them", () => {
    const filled = { customerName: "Ann", customerPhone: "+14155552671", shippingAddress: "1 Loop", shippingMethod: "ship_1" };
    expect(missingCheckoutFields("delivery", filled, "US")).toEqual([]);
    expect(missingCheckoutFields("delivery", filled, "BD")).toEqual(["city", "zone"]);
    expect(missingCheckoutFields("delivery", filled)).toEqual(["city", "zone"]);
    expect(checkoutAddressForMode("delivery", {
      shippingCountryCode: "US", shippingAddress: " 1 Loop ", shippingLocality: "Cupertino", city: "city_1",
    })).toMatchObject({ shippingCountryCode: "US", shippingAddress: "1 Loop", shippingLocality: "Cupertino", city: null, zone: null });
    expect(checkoutAddressForMode("delivery", { shippingAddress: "House 1", city: "city_1", zone: "zone_1" }))
      .not.toHaveProperty("shippingCountryCode");
    expect(checkoutAddressForMode("pickup", { shippingCountryCode: "US", shippingAddress: "1 Loop" })).toMatchObject({ shippingAddress: null });
  });
});
