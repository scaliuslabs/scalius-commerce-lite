import { describe, expect, it } from "vitest";
import {
  resolveLocationOption,
  type LocationOptionLike,
} from "./location-selector-utils";

const locations: LocationOptionLike[] = [
  { id: "city_dhaka", name: "Dhaka" },
  { id: "city_chittagong", name: "Chittagong" },
];

describe("resolveLocationOption", () => {
  it("matches by id before falling back to display name", () => {
    expect(resolveLocationOption(locations, "city_dhaka", null)?.name).toBe(
      "Dhaka",
    );
    expect(resolveLocationOption(locations, null, "Chittagong")?.id).toBe(
      "city_chittagong",
    );
  });

  it("ignores empty saved values", () => {
    expect(resolveLocationOption(locations, " ", null)).toBeUndefined();
  });

  it("repairs a saved duplicate ID through its normalized display name", () => {
    expect(
      resolveLocationOption(
        [{ id: "area_canonical", name: "Mohakhali Flyover" }],
        "area_retired_duplicate",
        " mohakhali   flyover ",
      )?.id,
    ).toBe("area_canonical");
  });
});
