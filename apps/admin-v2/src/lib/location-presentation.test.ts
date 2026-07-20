import { describe, expect, it } from "vitest";

import { formatLocationParts } from "./location-presentation";

describe("location presentation", () => {
  it("combines free-form and structured location parts", () => {
    expect(formatLocationParts(
      "House 20, Road 7",
      null,
      "Dhanmondi",
      "Dhaka",
    )).toBe("House 20, Road 7, Dhanmondi, Dhaka");
  });

  it("deduplicates normalized comma-separated segments", () => {
    expect(formatLocationParts(
      "House 20, Road 7, Dhanmondi, DHAKA",
      "Dhanmondi",
      "Dhaka",
    )).toBe("House 20, Road 7, Dhanmondi, DHAKA");
  });
});
