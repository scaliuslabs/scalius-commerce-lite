import { describe, expect, it } from "vitest";
import {
  isTrustedThemeEditorEvent,
  readThemeEditorMessage,
  readThemePreviewMessage,
  themeEditorOrigin,
} from "./theme-editor-bridge";

describe("theme editor messages", () => {
  it("reads only well-formed preview messages", () => {
    expect(readThemePreviewMessage({ source: "scalius-theme-preview", type: "select", sectionId: "hero-2" }))
      .toEqual({ source: "scalius-theme-preview", type: "select", sectionId: "hero-2" });
    expect(readThemePreviewMessage({ source: "scalius-theme-preview", type: "ready", path: "/", sections: ["hero", "faq"] })).not.toBeNull();
    for (const bad of [
      null,
      "select",
      { source: "scalius-theme-editor", type: "select", sectionId: "hero" },
      { source: "scalius-theme-preview", type: "select", sectionId: "<script>" },
      { source: "scalius-theme-preview", type: "hello", path: "//evil.test" },
      { source: "scalius-theme-preview", type: "ready", path: "/", sections: ["Hero"] },
      { source: "scalius-theme-preview", type: "unknown" },
    ]) {
      expect(readThemePreviewMessage(bad)).toBeNull();
    }
  });

  it("reads only well-formed editor messages", () => {
    expect(readThemeEditorMessage({ source: "scalius-theme-editor", type: "connect", names: { hero: "Banners" }, selected: null }))
      .toEqual({ source: "scalius-theme-editor", type: "connect", names: { hero: "Banners" }, selected: null });
    expect(readThemeEditorMessage({ source: "scalius-theme-editor", type: "section-updated", sectionIds: ["faq"] })).not.toBeNull();
    expect(readThemeEditorMessage({ source: "scalius-theme-editor", type: "go-home" })).toEqual({ source: "scalius-theme-editor", type: "go-home" });
    for (const bad of [
      { source: "scalius-theme-editor", type: "connect", names: { "a b": "x" }, selected: null },
      { source: "scalius-theme-editor", type: "connect", names: {}, selected: "../x" },
      { source: "scalius-theme-editor", type: "section-updated", sectionIds: [] },
      { source: "scalius-theme-editor", type: "scroll-to" },
      { source: "scalius-theme-preview", type: "reload" },
    ]) {
      expect(readThemeEditorMessage(bad)).toBeNull();
    }
  });

  it("trusts an event only from the expected window at the exact origin", () => {
    const frame = {};
    expect(isTrustedThemeEditorEvent({ origin: "https://shop.test", source: frame }, { origin: "https://shop.test", source: frame })).toBe(true);
    expect(isTrustedThemeEditorEvent({ origin: "https://shop.test.evil.test", source: frame }, { origin: "https://shop.test", source: frame })).toBe(false);
    expect(isTrustedThemeEditorEvent({ origin: "http://shop.test", source: frame }, { origin: "https://shop.test", source: frame })).toBe(false);
    expect(isTrustedThemeEditorEvent({ origin: "https://shop.test", source: {} }, { origin: "https://shop.test", source: frame })).toBe(false);
    expect(isTrustedThemeEditorEvent({ origin: "", source: null }, { origin: "", source: null })).toBe(false);
  });

  it("normalises a configured origin", () => {
    expect(themeEditorOrigin("https://admin.shop.test/dashboard")).toBe("https://admin.shop.test");
    expect(themeEditorOrigin("javascript:alert(1)")).toBe("");
    expect(themeEditorOrigin("https://user:pass@admin.shop.test")).toBe("");
    expect(themeEditorOrigin(undefined)).toBe("");
  });
});
