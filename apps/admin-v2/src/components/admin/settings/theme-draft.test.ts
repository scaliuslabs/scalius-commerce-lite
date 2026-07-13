import { describe, expect, it } from "vitest";
import { DEFAULT_STOREFRONT_THEME_SETTINGS } from "@scalius/shared/storefront-theme";

import {
  normalizeThemeColors,
  rebaseThemeSettingsDraft,
  rebaseThemeColorDraft,
  themeSettingsDraftsEqual,
  themeColorRecordsEqual,
} from "./theme-draft";

describe("theme color draft", () => {
  it("normalizes whitespace and drops cleared overrides", () => {
    expect(
      normalizeThemeColors({ primary: "  #123456 ", accent: "  " }),
    ).toEqual({ primary: "#123456" });
  });

  it("does not report a draft when only insignificant whitespace differs", () => {
    expect(
      themeColorRecordsEqual(
        { primary: "#123456", accent: "" },
        { primary: " #123456 " },
      ),
    ).toBe(true);
  });

  it("replays local changes without overwriting unrelated published changes", () => {
    expect(
      rebaseThemeColorDraft({
        base: { primary: "#111111", accent: "#222222", border: "#333333" },
        local: { primary: "#aaaaaa", border: "#333333" },
        latest: {
          primary: "#bbbbbb",
          accent: "#222222",
          border: "#cccccc",
          ring: "#dddddd",
        },
      }),
    ).toEqual({
      primary: "#aaaaaa",
      border: "#cccccc",
      ring: "#dddddd",
    });
  });

  it("compares the complete semantic document", () => {
    const base = DEFAULT_STOREFRONT_THEME_SETTINGS;
    expect(themeSettingsDraftsEqual(base, { ...base, colors: {} })).toBe(true);
    expect(
      themeSettingsDraftsEqual(base, {
        ...base,
        density: "compact",
      }),
    ).toBe(false);
  });

  it("keeps an invalid color draft dirty so the blocked input can be discarded", () => {
    const base = DEFAULT_STOREFRONT_THEME_SETTINGS;
    expect(
      themeSettingsDraftsEqual(base, {
        ...base,
        colors: { primary: "not-a-safe-color" },
      }),
    ).toBe(false);
  });

  it("rebases semantic leaves without erasing unrelated published changes", () => {
    const base = DEFAULT_STOREFRONT_THEME_SETTINGS;
    expect(
      rebaseThemeSettingsDraft({
        base,
        local: {
          ...base,
          typography: { ...base.typography, heading: "editorial" },
        },
        latest: {
          ...base,
          density: "compact",
          components: { ...base.components, cards: "elevated" },
        },
      }),
    ).toMatchObject({
      typography: { heading: "editorial" },
      density: "compact",
      components: { cards: "elevated" },
    });
  });
});
