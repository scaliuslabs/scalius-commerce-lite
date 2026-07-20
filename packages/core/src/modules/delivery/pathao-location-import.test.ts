import { describe, expect, it } from "vitest";

import { preparePathaoLocationItems } from "./pathao-location-import";

describe("Pathao location import preparation", () => {
  it("normalizes buyer locations and separates provider routing artifacts", () => {
    const result = preparePathaoLocationItems([
      { name: "  Dhanmondi  ", type: "zone", parentId: "city_1", pathaoId: 1 },
      { name: "On-demand  transfer", type: "zone", parentId: "city_1", pathaoId: 2 },
      { name: "Central Road", type: "zone", parentId: "city_1", pathaoId: 3 },
      { name: "lost", type: "zone", parentId: "city_1", pathaoId: 4 },
      { name: "Section   10", type: "area", parentId: "zone_1", pathaoId: 5 },
      { name: "Invalid ID", type: "area", parentId: "zone_1", pathaoId: 0 },
    ]);

    expect(result.accepted).toMatchObject([
      { name: "Dhanmondi", pathaoId: 1 },
      { name: "Central Road", pathaoId: 3 },
      { name: "Section 10", pathaoId: 5 },
    ]);
    expect(result.rejected).toMatchObject([
      { name: "On-demand transfer", pathaoId: 2 },
      { name: "lost", pathaoId: 4 },
      { name: "Invalid ID", pathaoId: 0 },
    ]);
  });

  it("keeps one deterministic choice for duplicate provider identities", () => {
    const result = preparePathaoLocationItems([
      { name: "Mohakhali Flyover", type: "area", parentId: "zone_1", pathaoId: 16547 },
      { name: " mohakhali   flyover ", type: "area", parentId: "zone_1", pathaoId: 16487 },
      { name: "Different label", type: "area", parentId: "zone_1", pathaoId: 16487 },
      { name: "Mohakhali Flyover", type: "area", parentId: "zone_2", pathaoId: 16548 },
    ]);

    expect(result.accepted).toMatchObject([
      { name: "mohakhali flyover", parentId: "zone_1", pathaoId: 16487 },
      { name: "Mohakhali Flyover", parentId: "zone_2", pathaoId: 16548 },
    ]);
    expect(result.rejected).toHaveLength(2);
  });
});
