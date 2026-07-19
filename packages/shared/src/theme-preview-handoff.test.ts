import { describe, expect, it } from "vitest";

import {
  isThemePreviewHandoffMessage,
  isThemePreviewToken,
  THEME_PREVIEW_HANDOFF_READY,
  THEME_PREVIEW_HANDOFF_TOKEN,
} from "./theme-preview-handoff";

describe("theme preview handoff protocol", () => {
  it("accepts only the bounded opaque preview-token format", () => {
    expect(isThemePreviewToken(`tpv_${"a".repeat(48)}`)).toBe(true);
    expect(isThemePreviewToken(`tpv_${"a".repeat(39)}`)).toBe(false);
    expect(isThemePreviewToken("published-theme")).toBe(false);
    expect(isThemePreviewToken(null)).toBe(false);
  });

  it("matches exact versioned message types without trusting payload shape", () => {
    expect(
      isThemePreviewHandoffMessage(
        { type: THEME_PREVIEW_HANDOFF_READY },
        THEME_PREVIEW_HANDOFF_READY,
      ),
    ).toBe(true);
    expect(
      isThemePreviewHandoffMessage(
        { type: THEME_PREVIEW_HANDOFF_TOKEN },
        THEME_PREVIEW_HANDOFF_READY,
      ),
    ).toBe(false);
    expect(isThemePreviewHandoffMessage(null, THEME_PREVIEW_HANDOFF_READY)).toBe(false);
  });
});
