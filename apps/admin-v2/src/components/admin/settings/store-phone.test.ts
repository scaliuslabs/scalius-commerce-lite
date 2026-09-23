import { describe, expect, it } from "vitest";
import { normalizeStorePhone } from "./store-phone";

describe("store phone", () => {
  it("normalizes any Bangladeshi mobile format to 01XXXXXXXXX", () => {
    for (const input of ["01712345678", "+8801712345678", "8801712345678", "+880 1712-345 678", "(017) 1234 5678", "০১৭১২৩৪৫৬৭৮"]) {
      expect(normalizeStorePhone(input)).toBe("01712345678");
    }
  });

  it("keeps other numbers as typed, with Latin digits", () => {
    expect(normalizeStorePhone(" 02-9876543 ")).toBe("02-9876543");
    expect(normalizeStorePhone("+44 20 7946 0958")).toBe("+44 20 7946 0958");
    expect(normalizeStorePhone("০২-৯৮৭৬৫৪৩")).toBe("02-9876543");
  });
});
