import { describe, expect, it } from "vitest";

import { resolveStorefrontThemeColors } from "./storefront.service";

describe("storefront theme projection", () => {
  it("prefers the versioned document and sanitizes its tokens", () => {
    expect(resolveStorefrontThemeColors(
      JSON.stringify({ primary: " #2563eb ", unsafe: "url(evil)" }),
      JSON.stringify({ primary: "#be123c" }),
    )).toEqual({ primary: "#2563eb" });
  });

  it("uses the legacy row only when no versioned document exists", () => {
    expect(resolveStorefrontThemeColors(
      undefined,
      JSON.stringify({ primary: "#047857" }),
    )).toEqual({ primary: "#047857" });
    expect(resolveStorefrontThemeColors("{}", JSON.stringify({ primary: "#047857" })))
      .toEqual({});
  });
});
