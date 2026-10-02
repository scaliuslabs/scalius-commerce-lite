import { describe, expect, it } from "vitest";
import {
  isSafeThemePreviewContinuation,
  isSafeThemePreviewPath,
} from "./ThemePreviewAction";

describe("theme preview handoff", () => {
  const continuation = {
    url: "https://shop.example/theme-preview/continue",
    method: "POST",
    fields: { continuationCode: `tpc_${"x".repeat(48)}`, path: "/search?q=keyboard", device: "mobile" },
  };

  it("keeps preview paths on public storefront routes", () => {
    expect(isSafeThemePreviewPath("/search?q=keyboard")).toBe(true);
    expect(isSafeThemePreviewPath("/categories/keyboard")).toBe(true);
    expect(isSafeThemePreviewPath("/products/keyboard")).toBe(true);
    expect(isSafeThemePreviewPath("/pages/eid-offers")).toBe(true);
    expect(isSafeThemePreviewPath("/pages/../checkout")).toBe(false);
    expect(isSafeThemePreviewPath("//attacker.example/")).toBe(false);
    expect(isSafeThemePreviewPath("/checkout")).toBe(false);
    expect(isSafeThemePreviewPath("/products/../checkout")).toBe(false);
  });

  it("accepts only a body-only continuation at the configured storefront origin", () => {
    expect(isSafeThemePreviewContinuation(continuation, "https://shop.example", "/search?q=keyboard", "mobile")).toBe(true);
    expect(isSafeThemePreviewContinuation(
      { ...continuation, url: "https://attacker.example/theme-preview/continue" },
      "https://shop.example", "/search?q=keyboard", "mobile",
    )).toBe(false);
    expect(isSafeThemePreviewContinuation(
      { ...continuation, url: `${continuation.url}?continuationCode=secret` },
      "https://shop.example", "/search?q=keyboard", "mobile",
    )).toBe(false);
    expect(isSafeThemePreviewContinuation(
      { ...continuation, fields: { ...continuation.fields, path: "/" } },
      "https://shop.example", "/search?q=keyboard", "mobile",
    )).toBe(false);
    expect(isSafeThemePreviewContinuation(
      { ...continuation, url: "http://localhost:4322/theme-preview/continue" },
      "http://localhost:4322", "/search?q=keyboard", "mobile",
    )).toBe(true);
  });
});
