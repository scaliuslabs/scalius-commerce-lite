import { describe, expect, it } from "vitest";

import { normalizeCurrencySettingsInput } from "./currency";

describe("Admin currency settings input", () => {
  it("normalizes supported codes before the server request", () => {
    expect(normalizeCurrencySettingsInput({
      currencyCode: " bdt ",
      currencySymbol: "৳",
    })).toEqual({
      currencyCode: "BDT",
      currencySymbol: "৳",
    });
  });

  it.each(["", "US", "USDT", "ZZZ", null])(
    "rejects unsupported code %s",
    (currencyCode) => {
      expect(() => normalizeCurrencySettingsInput({ currencyCode }))
        .toThrow("Select a supported three-letter currency code.");
    },
  );

  it("preserves partial settings payloads that do not change currency code", () => {
    const input = { currencySymbol: "Tk" };
    expect(normalizeCurrencySettingsInput(input)).toBe(input);
  });
});
