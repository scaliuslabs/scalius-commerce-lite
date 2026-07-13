import { describe, expect, it } from "vitest";

import {
  normalizeThemeColors,
  rebaseThemeColorDraft,
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
});
