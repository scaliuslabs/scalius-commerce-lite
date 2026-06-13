import { beforeEach, describe, expect, it, vi } from "vitest";
import { notifyAiContextWarnings } from "./ai-context-warnings";

const { warningMock } = vi.hoisted(() => ({
  warningMock: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    warning: warningMock,
  },
}));

describe("notifyAiContextWarnings", () => {
  beforeEach(() => {
    warningMock.mockClear();
  });

  it("warns when selected context is truncated or unavailable", () => {
    notifyAiContextWarnings({
      products: [],
      categories: [],
      collections: [],
      warnings: {
        productsTruncated: true,
        categoriesTruncated: true,
        collectionsTruncated: false,
        productsUnavailable: 2,
        categoriesUnavailable: 1,
        collectionsUnavailable: 0,
        maxProducts: 20,
        maxCategories: 50,
        maxCollections: 10,
      },
    });

    expect(warningMock.mock.calls.map(([message]) => message)).toEqual([
      "Using the first 20 selected products for this AI request.",
      "Using up to 50 categories for this AI request.",
      "2 selected products were skipped because they are not storefront-visible.",
      "1 selected category was skipped because it is deleted.",
    ]);
  });
});
