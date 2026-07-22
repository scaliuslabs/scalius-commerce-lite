import { describe, expect, it } from "vitest";
import { shouldShowCatalogControls } from "./catalog-control-visibility";

describe("catalog control visibility", () => {
  it.each([0, 1])(
    "keeps a canonical %i-product listing compact",
    (resultCount) => {
      expect(
        shouldShowCatalogControls({ resultCount, activeFilterCount: 0 }),
      ).toBe(false);
    },
  );

  it("shows browsing controls when the catalog can be meaningfully sorted or filtered", () => {
    expect(
      shouldShowCatalogControls({ resultCount: 2, activeFilterCount: 0 }),
    ).toBe(true);
  });

  it.each([0, 1])(
    "keeps recovery controls available for a refined %i-result listing",
    (resultCount) => {
      expect(
        shouldShowCatalogControls({ resultCount, activeFilterCount: 1 }),
      ).toBe(true);
    },
  );
});
