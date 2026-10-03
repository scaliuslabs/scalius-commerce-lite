import { describe, expect, it } from "vitest";
import { courierServesCountry, couriersForCountry } from "./courier-countries";

describe("courier countries", () => {
  it("offers a Bangladesh-only courier for a Bangladesh order (or one without a country) and leaves it out elsewhere", () => {
    expect(courierServesCountry(["BD"], "BD")).toBe(true);
    expect(courierServesCountry(["BD"], null)).toBe(true);
    expect(courierServesCountry(["BD"], "US")).toBe(false);
    expect(courierServesCountry("any", "US")).toBe(true);
    expect(courierServesCountry(undefined, "US")).toBe(true);
    const pathao = { id: "p", countries: ["BD"] as const };
    const global = { id: "g", countries: "any" as const };
    expect(couriersForCountry([pathao, global], "GB")).toEqual({ served: [global], elsewhere: [pathao] });
  });
});
