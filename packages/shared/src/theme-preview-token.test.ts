import { describe, expect, it } from "vitest";

import { isThemePreviewToken } from "./theme-preview-token";

describe("theme preview bearer", () => {
  it("accepts only the bounded opaque preview-token format", () => {
    expect(isThemePreviewToken(`tpv_${"a".repeat(48)}`)).toBe(true);
    expect(isThemePreviewToken(`tpv_${"a".repeat(39)}`)).toBe(false);
    expect(isThemePreviewToken(`tpv_${"a".repeat(49)}`)).toBe(false);
    expect(isThemePreviewToken("published-theme")).toBe(false);
    expect(isThemePreviewToken(null)).toBe(false);
  });
});
