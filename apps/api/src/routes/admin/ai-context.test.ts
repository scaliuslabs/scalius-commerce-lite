import { describe, expect, it } from "vitest";
import {
  isAttributeVisibleForAiContext,
  isCategoryVisibleForAiContext,
  isProductVisibleForAiContext,
  isVariantVisibleForAiContext,
} from "./ai-context";

describe("AI context catalog visibility", () => {
  it("only exposes active, non-deleted products", () => {
    expect(isProductVisibleForAiContext({ isActive: true, deletedAt: null })).toBe(true);
    expect(isProductVisibleForAiContext({ isActive: false, deletedAt: null })).toBe(false);
    expect(isProductVisibleForAiContext({ isActive: true, deletedAt: new Date() })).toBe(false);
  });

  it("excludes deleted categories, variants, and attributes", () => {
    expect(isCategoryVisibleForAiContext({ deletedAt: null })).toBe(true);
    expect(isCategoryVisibleForAiContext({ deletedAt: new Date() })).toBe(false);
    expect(isVariantVisibleForAiContext({ deletedAt: null })).toBe(true);
    expect(isVariantVisibleForAiContext({ deletedAt: new Date() })).toBe(false);
    expect(isAttributeVisibleForAiContext({ deletedAt: null })).toBe(true);
    expect(isAttributeVisibleForAiContext({ deletedAt: new Date() })).toBe(false);
  });
});
