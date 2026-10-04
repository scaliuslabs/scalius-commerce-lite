import { describe, expect, it } from "vitest";

import { phoneCountryMeta } from "./phone-example";

describe("phone country facts", () => {
  it("gives the calling code and an example both ways a buyer types it", () => {
    expect(phoneCountryMeta("IN")).toEqual({ code: "+91", example: "+91 81234 56789", national: "081234 56789" });
    expect(phoneCountryMeta("us")).toMatchObject({ code: "+1", example: "+1 201 555 0123" });
    expect(phoneCountryMeta("BD")).toMatchObject({ code: "+880" });
  });

  it("is null for a code libphonenumber does not know", () => {
    expect(phoneCountryMeta("ZZ")).toBeNull();
    expect(phoneCountryMeta("")).toBeNull();
  });
});
