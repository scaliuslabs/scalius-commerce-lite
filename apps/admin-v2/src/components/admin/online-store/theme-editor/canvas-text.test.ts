import { describe, expect, it } from "vitest";
import { DEFAULT_STOREFRONT_THEME, storefrontSectionDefault, type StorefrontSection, type StorefrontThemeDocument } from "@scalius/shared/storefront-theme";
import { canvasTextControlId, canvasTextField, commitCanvasText, type CanvasTextTarget } from "./canvas-text";
import { appSectionsByKey } from "./editor-state";
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

describe("canvas text in app sections", () => {
  const setting = (key: string, type: "text" | "textarea" | "number", extra: { default?: string; maxLength?: number } = {}) => ({
    key, label: `${key} label`, help: null, type, required: false, options: null, default: extra.default ?? null,
    min: null, max: null, integer: false, maxLength: extra.maxLength ?? null,
  });
  const apps = () => appSectionsByKey([{
    id: "acme.studio", name: "Studio", skins: [], templates: [], pagePresets: [], components: [],
    sections: [{ key: "acme.studio/quote", type: "quote", name: "Quote", description: null,
      settings: [setting("quote", "textarea"), setting("author", "text", { default: "A buyer", maxLength: 40 }), setting("size", "number")] }],
  }]);
  const quote: StorefrontSection = { id: "app", type: "app", version: 1, settings: { app: "acme.studio/quote", values: { quote: "Loved it" } } };
  const quoteTarget: CanvasTextTarget = { page: { kind: "home" }, id: "app", type: "app", layout: "acme.studio/quote", field: "author", baseline: "A buyer" };

  it("edits a text setting the section's app declares, from its default, and writes only its value", () => {
    expect(canvasTextField(quote, "author", apps())).toMatchObject({ value: "A buyer", maxLength: 40, multiline: false, patch: true, label: "author label" });
    expect(canvasTextField(quote, "quote", apps())).toMatchObject({ value: "Loved it", maxLength: 2000, multiline: true, patch: false });
    const result = commitCanvasText(theme([quote]), quoteTarget, "Rahim", undefined, apps());
    expect(result.ok && result.theme.pages.home[0]).toEqual({ ...quote, settings: { ...quote.settings, values: { quote: "Loved it", author: "Rahim" } } });
    expect(commitCanvasText(theme([quote]), quoteTarget, "x".repeat(41), undefined, apps())).toEqual({ ok: false, reason: "too-long" });
  });

  it("refuses other settings, inactive apps and a section that changed app", () => {
    for (const field of ["size", "missing", "values.author", "heading"]) expect(canvasTextField(quote, field, apps()), field).toBeNull();
    expect(canvasTextField(quote, "author")).toBeNull();
    const moved = { ...quote, settings: { ...quote.settings, app: "acme.other/quote" } } as StorefrontSection;
    expect(commitCanvasText(theme([moved]), quoteTarget, "Rahim", undefined, apps())).toEqual({ ok: false, reason: "missing" });
  });

  it("names the app setting's own control", () => {
    expect(canvasTextControlId(quote, "author")).toBe("theme-section-app-values-author");
    expect(canvasTextControlId(banner, "cta.label")).toBe("theme-section-a-cta-label");
  });
});
