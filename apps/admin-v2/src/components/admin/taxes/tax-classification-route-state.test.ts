import { describe, expect, it } from "vitest";

import {
  DEFAULT_TAX_CLASSIFICATION_ROUTE_STATE,
  normalizeTaxClassificationRouteState,
} from "./tax-classification-route-state";

describe("tax classification route state", () => {
  it("preserves a valid SKU search and page", () => {
    expect(normalizeTaxClassificationRouteState({
      kind: "variant",
      query: "  CLOG-39  ",
      page: "3",
    })).toEqual({
      kind: "variant",
      search: "CLOG-39",
      page: 3,
    });
  });

  it("normalizes invalid and unbounded route input", () => {
    expect(normalizeTaxClassificationRouteState({
      kind: "unknown",
      query: "x".repeat(220),
      page: -2,
    })).toEqual({
      ...DEFAULT_TAX_CLASSIFICATION_ROUTE_STATE,
      search: "x".repeat(180),
    });
    expect(normalizeTaxClassificationRouteState({ page: "1.5" })).toEqual(
      DEFAULT_TAX_CLASSIFICATION_ROUTE_STATE,
    );
  });
});
