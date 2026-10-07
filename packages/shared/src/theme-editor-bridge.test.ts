import { describe, expect, it } from "vitest";
import {
  THEME_PREVIEW_BODY_MAX,
  isTrustedThemeEditorEvent,
  readThemeEditorMessage,
  readThemePreviewMessage,
  themeEditorOrigin,
} from "./theme-editor-bridge";

const preview = (message: Record<string, unknown>) => ({ source: "scalius-theme-preview", ...message });
const editor = (message: Record<string, unknown>) => ({ source: "scalius-theme-editor", ...message });

describe("theme editor messages", () => {
  it("reads only well-formed preview messages", () => {
    expect(readThemePreviewMessage(preview({ type: "select", id: "hero-2" }))).toEqual(preview({ type: "select", id: "hero-2" }));
    expect(readThemePreviewMessage(preview({ type: "ready", path: "/", marks: ["hero", "faq"] }))).not.toBeNull();
    expect(readThemePreviewMessage(preview({ type: "layout", rects: { hero: [0, -40, 1280, 600] }, scrollY: 40, height: 3000 })))
      .toEqual(preview({ type: "layout", rects: { hero: [0, -40, 1280, 600] }, scrollY: 40, height: 3000 }));
    expect(readThemePreviewMessage(preview({ type: "hover", id: null }))).toEqual(preview({ type: "hover", id: null }));
    expect(readThemePreviewMessage(preview({ type: "key", key: "z", mod: true, shift: false, alt: false }))).not.toBeNull();
    for (const bad of [
      null,
      "select",
      editor({ type: "select", id: "hero" }),
      preview({ type: "select", id: "<script>" }),
      preview({ type: "hello", path: "//evil.test" }),
      preview({ type: "ready", path: "/", marks: ["Hero"] }),
      preview({ type: "layout", rects: { hero: [0, 0, -1, 10] }, scrollY: 0, height: 10 }),
      preview({ type: "layout", rects: { hero: [0, 0, 1] }, scrollY: 0, height: 10 }),
      preview({ type: "layout", rects: {}, scrollY: Number.NaN, height: 10 }),
      preview({ type: "key", key: "q", mod: true, shift: false, alt: false }),
      preview({ type: "unknown" }),
    ]) {
      expect(readThemePreviewMessage(bad)).toBeNull();
    }
  });

  it("reads only well-formed editor messages", () => {
    expect(readThemeEditorMessage(editor({ type: "connect", inspector: true, scrollY: null })))
      .toEqual(editor({ type: "connect", inspector: true, scrollY: null }));
    expect(readThemeEditorMessage(editor({ type: "tokens", vars: { primary: "#112233", "theme-font-heading": "\"Inter\", sans-serif" } }))).not.toBeNull();
    expect(readThemeEditorMessage(editor({ type: "text", id: "hero", from: "Eid", to: "Eid sale" }))).not.toBeNull();
    expect(readThemeEditorMessage(editor({ type: "arrange", region: "page", order: ["faq", "hero"] }))).not.toBeNull();
    expect(readThemeEditorMessage(editor({ type: "render", body: { scope: { kind: "home" }, sections: [] }, after: null }))).not.toBeNull();
    for (const bad of [
      editor({ type: "connect", inspector: "yes", scrollY: null }),
      editor({ type: "reveal", id: "../x" }),
      // Token values never carry CSS structure.
      editor({ type: "tokens", vars: { primary: "red; } body { display: none" } }),
      editor({ type: "tokens", vars: { "Primary Color": "#fff" } }),
      editor({ type: "render", body: { big: "x".repeat(THEME_PREVIEW_BODY_MAX) }, after: null }),
      editor({ type: "render", body: [], after: null }),
      editor({ type: "paint", theme: "document" }),
      preview({ type: "reveal", id: "hero" }),
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
