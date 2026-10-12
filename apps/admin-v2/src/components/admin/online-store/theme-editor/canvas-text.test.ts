import { describe, expect, it } from "vitest";
import { DEFAULT_STOREFRONT_THEME, storefrontSectionDefault, type StorefrontSection, type StorefrontThemeDocument } from "@scalius/shared/storefront-theme";
import { canvasTextField, commitCanvasText, type CanvasTextTarget } from "./canvas-text";
const banner = { ...storefrontSectionDefault("banner", "a"), settings: { ...storefrontSectionDefault("banner", "a").settings, heading: "Same", text: "Same", cta: { label: "Same", href: "/" } } };
const theme = (home: StorefrontSection[] = [banner]): StorefrontThemeDocument => ({ ...DEFAULT_STOREFRONT_THEME, pages: { ...DEFAULT_STOREFRONT_THEME.pages, home } });
const target: CanvasTextTarget = { page: { kind: "home" }, id: "a", type: "banner", layout: banner.settings.layout, field: "heading", baseline: "Same" };

describe("canvas scalar field edits", () => {
  it("addresses exactly one setting, preserving identical sibling words", () => {
    const result = commitCanvasText(theme(), target, "Changed");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.theme.pages.home[0]?.settings).toMatchObject({ heading: "Changed", text: "Same", cta: { label: "Same" } });
  });
  it("refuses list indices, unsupported sections and absent nullable CTA data", () => {
    expect(canvasTextField(storefrontSectionDefault("faq", "faq"), "items.0.question")).toBeNull();
    expect(canvasTextField(storefrontSectionDefault("product-rail", "rail"), "title")).toBeNull();
    expect(canvasTextField({ ...banner, settings: { ...banner.settings, cta: null } }, "cta.label")).toBeNull();
  });
  it("uses schema-derived bounds and preserves plain paragraph text", () => {
    const story = { ...storefrontSectionDefault("editorial", "a"), settings: { layout: "rich-text", heading: "Same", body: "First\n\nSecond" } } as StorefrontSection;
    const field = canvasTextField(story, "body")!;
    expect(field).toMatchObject({ multiline: true, patch: false, value: "First\n\nSecond" });
    const bodyTarget = { ...target, type: "editorial", layout: "rich-text", field: "body", baseline: field.value } as const;
    expect(commitCanvasText(theme([story]), bodyTarget, "x".repeat(field.maxLength + 1))).toEqual({ ok: false, reason: "too-long" });
    const result = commitCanvasText(theme([story]), bodyTarget, "বাংলা\n\n<plain text>");
    expect(result.ok && result.theme.pages.home[0]?.settings).toMatchObject({ body: "বাংলা\n\n<plain text>" });
  });
  it("compares the captured baseline before replacement and rechecks explicit replace", () => {
    const changed = theme([{ ...banner, settings: { ...banner.settings, heading: "Elsewhere" } }]);
    expect(commitCanvasText(changed, target, "Mine")).toEqual({ ok: false, reason: "changed", current: "Elsewhere" });
    expect(commitCanvasText(changed, target, "Mine", "Elsewhere").ok).toBe(true);
    expect(commitCanvasText(changed, target, "Mine", "Another change").ok).toBe(false);
  });
  it("refuses removed, hidden, retyped or relaid-out sections and preserves no-op identity", () => {
    for (const current of [theme([]), theme([{ ...banner, hidden: true }]), theme([storefrontSectionDefault("faq", "a")]), theme([{ ...banner, settings: { ...banner.settings, layout: "four-up" } }])]) {
      expect(commitCanvasText(current, target, "Mine")).toEqual({ ok: false, reason: "missing" });
    }
    const current = theme();
    expect(commitCanvasText(current, target, "Same")).toEqual({ ok: true, theme: current });
  });
  it("writes only the captured page even when another page has the same ID", () => {
    const current = theme();
    current.pages.templates = { ...current.pages.templates, cart: { sections: [banner], main: 1 } };
    const result = commitCanvasText(current, { ...target, page: { kind: "cart" } }, "Cart");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.pages.home).toBe(current.pages.home);
    expect(result.theme.pages.templates.cart.main).toBe(1);
    expect(result.theme.pages.templates.cart.sections[0]?.settings).toMatchObject({ heading: "Cart" });
  });
});
