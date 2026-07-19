import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOMEPAGE_PRESENTATION,
  MAX_HOMEPAGE_CATEGORY_IDS,
  parseHomepagePresentationConfig,
  sanitizeHomepagePresentationConfig,
} from "./homepage-presentation";

describe("homepage presentation", () => {
  it("fails safely to a disabled presentation", () => {
    expect(parseHomepagePresentationConfig("not json")).toEqual(
      DEFAULT_HOMEPAGE_PRESENTATION,
    );
  });

  it("normalizes copy and exact category order without duplicates", () => {
    expect(sanitizeHomepagePresentationConfig({
      categoryRail: {
        enabled: true,
        title: "  Browse   the store  ",
        categoryIds: ["cat-2", "cat-1", "cat-2", "", null],
      },
      trustStrip: { enabled: true },
    })).toEqual({
      categoryRail: {
        enabled: true,
        title: "Browse the store",
        categoryIds: ["cat-2", "cat-1"],
      },
      trustStrip: { enabled: true },
    });
  });

  it("bounds the category rail", () => {
    const categoryIds = Array.from(
      { length: MAX_HOMEPAGE_CATEGORY_IDS + 5 },
      (_, index) => `cat-${index}`,
    );
    expect(sanitizeHomepagePresentationConfig({
      categoryRail: { categoryIds },
    }).categoryRail.categoryIds).toHaveLength(MAX_HOMEPAGE_CATEGORY_IDS);
  });
});
