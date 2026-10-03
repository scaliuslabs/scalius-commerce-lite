import { describe, expect, it } from "vitest";
import { PLUGIN_HOME_SECTIONS_MAX } from "@scalius/shared/plugins/storefront";
import {
  DEFAULT_STOREFRONT_THEME,
  STOREFRONT_MAX_SECTIONS,
  storefrontSectionDefault,
  storefrontThemeDocumentSchema,
  type StorefrontSection,
  type StorefrontSectionType,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import type { ThemeApp, ThemeAppSettingField } from "~/lib/api-query-options/online-store";
import {
  HISTORY_COALESCE_MS,
  addAppSection,
  addSection,
  appSectionsByKey,
  appSectionsInvalid,
  canAddSectionType,
  changedLeaf,
  duplicateSection,
  editorHistory,
  moveSectionTo,
  previewChange,
  removeSection,
  restoreSection,
  setAppSectionValues,
  startHistory,
} from "./editor-state";

type Theme = StorefrontThemeDocument;

const section = (type: StorefrontSectionType, id: string, settings: Record<string, unknown> = {}) =>
  ({ ...storefrontSectionDefault(type, id), settings: { ...storefrontSectionDefault(type, id).settings, ...settings } }) as StorefrontSection;

const HOME = [section("hero", "hero"), section("product-rail", "rail", { title: "New" }), section("faq", "faq")];
const withSections = (base: Theme, home: StorefrontSection[]): Theme => ({ ...base, pages: { ...base.pages, home } });
const theme = (home: StorefrontSection[] = HOME): Theme => withSections(DEFAULT_STOREFRONT_THEME, home);
const ids = (sections: readonly StorefrontSection[]) => sections.map((each) => each.id);
const setTitle = (title: string) => (current: Theme) => withSections(current, current.pages.home.map((each) =>
  each.id === "rail" ? { ...each, settings: { ...each.settings, title } } as StorefrontSection : each));

describe("editor history", () => {
  it("undoes and redoes edits; a new edit drops the redo branch", () => {
    let state = startHistory(theme());
    state = editorHistory(state, { type: "edit", update: setTitle("A"), at: 0 });
    state = editorHistory(state, { type: "edit", update: (current) => withSections(current, moveSectionTo(current.pages.home, 2, 0)), at: 5_000 });
    expect(ids(state.present.pages.home)).toEqual(["faq", "hero", "rail"]);
    state = editorHistory(state, { type: "undo" });
    expect(ids(state.present.pages.home)).toEqual(["hero", "rail", "faq"]);
    state = editorHistory(state, { type: "redo" });
    expect(ids(state.present.pages.home)).toEqual(["faq", "hero", "rail"]);
    state = editorHistory(state, { type: "undo" });
    state = editorHistory(state, { type: "edit", update: setTitle("B"), at: 10_000 });
    expect(state.future).toEqual([]);
    expect(editorHistory(state, { type: "redo" })).toBe(state);
  });

  it("makes typing in one field one step, and a pause or another field a new one", () => {
    let state = startHistory(theme());
    state = editorHistory(state, { type: "edit", update: setTitle("N"), at: 0 });
    state = editorHistory(state, { type: "edit", update: setTitle("Ne"), at: 200 });
    state = editorHistory(state, { type: "edit", update: setTitle("New honey"), at: 400 });
    expect(state.past).toHaveLength(1);
    state = editorHistory(state, { type: "edit", update: setTitle("New honey!"), at: 400 + HISTORY_COALESCE_MS + 1 });
    expect(state.past).toHaveLength(2);
    state = editorHistory(state, { type: "edit", update: (current) => ({ ...current, brand: { ...current.brand, logoWidth: 200 } }), at: 500 + HISTORY_COALESCE_MS });
    expect(state.past).toHaveLength(3);
  });

  it("ignores an edit that changes nothing, and starts again from a replaced draft", () => {
    const state = startHistory(theme());
    expect(editorHistory(state, { type: "edit", update: (current) => current, at: 0 })).toBe(state);
    const edited = editorHistory(state, { type: "edit", update: setTitle("A"), at: 0 });
    const replaced = editorHistory(edited, { type: "replace", theme: theme() });
    expect(replaced.past).toEqual([]);
    expect(replaced.future).toEqual([]);
  });

  it("finds the one value an edit changed", () => {
    const before = theme();
    expect(changedLeaf(before, setTitle("A")(before))).toBe("pages.home.1.settings.title");
    expect(changedLeaf(before, withSections(before, moveSectionTo(before.pages.home, 0, 2)))).toBeNull();
    expect(changedLeaf(before, before)).toBeNull();
  });
});

describe("homepage section operations", () => {
  it("moves a section to another place, and leaves the list alone out of range", () => {
    expect(ids(moveSectionTo(HOME, 0, 2))).toEqual(["rail", "faq", "hero"]);
    expect(ids(moveSectionTo(HOME, 2, 0))).toEqual(["faq", "hero", "rail"]);
    expect(ids(moveSectionTo(HOME, 0, 5))).toEqual(["hero", "rail", "faq"]);
  });

  it("adds and duplicates under free ids, one hero per page, at most 24 sections", () => {
    const added = addSection(HOME, "faq", 0);
    expect(added.id).toBe("faq-2");
    expect(ids(added.sections)).toEqual(["hero", "faq-2", "rail", "faq"]);
    const copy = duplicateSection(HOME, "rail")!;
    expect(ids(copy.sections)).toEqual(["hero", "rail", "product-rail", "faq"]);
    expect(copy.sections[2]!.settings).toEqual(HOME[1]!.settings);
    expect(duplicateSection(HOME, "hero")).toBeNull();
    expect(canAddSectionType(HOME, "hero")).toBe(false);
    const full = Array.from({ length: STOREFRONT_MAX_SECTIONS }, (_, index) => section("faq", `faq-${index}`));
    expect(canAddSectionType(full, "faq")).toBe(false);
  });

  it("removes a section and puts it back where it was", () => {
    const removed = removeSection(HOME, "rail")!;
    expect(ids(removed.sections)).toEqual(["hero", "faq"]);
    expect(ids(restoreSection(removed.sections, removed.removed, removed.index))).toEqual(["hero", "rail", "faq"]);
    // Restoring twice never duplicates an id.
    expect(ids(restoreSection(HOME, removed.removed, removed.index))).toEqual(["hero", "rail", "faq"]);
  });
});

describe("what a saved change means for the preview", () => {
  it("swaps the sections whose settings changed", () => {
    expect(previewChange(theme(), setTitle("A")(theme()))).toEqual({ kind: "sections", ids: ["rail"] });
    expect(previewChange(theme(), theme())).toEqual({ kind: "none" });
  });

  it("reloads for order, added or removed sections, home mode, tokens, blocks and brand", () => {
    const base = theme();
    expect(previewChange(base, withSections(base, moveSectionTo(HOME, 0, 1)))).toEqual({ kind: "reload" });
    expect(previewChange(base, withSections(base, HOME.slice(1)))).toEqual({ kind: "reload" });
    expect(previewChange(base, { ...base, pages: { ...base.pages, homeMode: { kind: "product", productId: "p" } } })).toEqual({ kind: "reload" });
    expect(previewChange(base, { ...base, tokens: { ...base.tokens, density: "airy" } })).toEqual({ kind: "reload" });
    expect(previewChange(base, { ...base, brand: { ...base.brand, logo: "m" } })).toEqual({ kind: "reload" });
  });
});

describe("app sections", () => {
  const field = (key: string, extra: Partial<ThemeAppSettingField> = {}): ThemeAppSettingField => ({
    key, label: key, help: null, type: "text", required: false, options: null, default: null,
    min: null, max: null, integer: false, maxLength: 80, ...extra,
  });
  const APPS: ThemeApp[] = [{
    id: "acme.reviews",
    name: "Acme Reviews",
    sections: [{
      key: "acme.reviews/carousel",
      type: "carousel",
      name: "Reviews carousel",
      description: null,
      settings: [field("heading", { default: "What buyers say" }), field("count", { type: "number", min: 1, max: 12, integer: true, default: 4, maxLength: null })],
    }],
    productBlocks: [],
  }];
  const byKey = appSectionsByKey(APPS);
  const appSection = (id: string) => ({ ...addAppSection([], "acme.reviews/carousel", {}).sections[0]!, id });

  it("adds an app section under a free id with its values, and the document accepts it", () => {
    const first = addAppSection(HOME, "acme.reviews/carousel", { heading: "What buyers say", count: 4 }, 0);
    expect(first.id).toBe("app");
    expect(first.sections[1]).toEqual({
      id: "app",
      type: "app",
      version: 1,
      settings: { app: "acme.reviews/carousel", values: { heading: "What buyers say", count: 4 } },
    });
    const second = addAppSection(first.sections, "acme.reviews/carousel", {});
    expect(second.id).toBe("app-2");
    expect(ids(second.sections)).toEqual(["hero", "app", "rail", "faq", "app-2"]);
    expect(storefrontThemeDocumentSchema.safeParse(theme(second.sections)).success).toBe(true);
    // A copy is another app section with the same values.
    const copy = duplicateSection(second.sections, "app")!;
    expect(copy.id).toBe("app-3");
    expect(copy.sections[2]).toMatchObject({ type: "app", settings: first.sections[1]!.settings });
  });

  it("stops at the app sections a homepage draws", () => {
    const apps = Array.from({ length: PLUGIN_HOME_SECTIONS_MAX }, (_, index) => appSection(`app-${index}`));
    expect(canAddSectionType(apps.slice(1), "app")).toBe(true);
    expect(canAddSectionType(apps, "app")).toBe(false);
    expect(duplicateSection(apps, "app-0")).toBeNull();
    // Platform sections still fit.
    expect(canAddSectionType(apps, "faq")).toBe(true);
    // Undo cannot bring one back past the limit.
    const removed = removeSection(apps, "app-0")!;
    const refilled = [...removed.sections, appSection("app-new")];
    expect(restoreSection(refilled, removed.removed, removed.index)).toHaveLength(PLUGIN_HOME_SECTIONS_MAX);
  });

  it("writes values and judges them against the app, never a section whose app is not active", () => {
    const added = addAppSection(HOME, "acme.reviews/carousel", { heading: "Reviews", count: 4 });
    expect(appSectionsInvalid(added.sections, byKey)).toBe(false);
    const broken = setAppSectionValues(added.sections, "app", { heading: "Reviews", count: 40 });
    expect(broken.find((each) => each.id === "app")!.settings).toEqual({ app: "acme.reviews/carousel", values: { heading: "Reviews", count: 40 } });
    expect(appSectionsInvalid(broken, byKey)).toBe(true);
    // Other sections keep their identity.
    expect(broken[0]).toBe(added.sections[0]);
    const gone = addAppSection(HOME, "acme.gone/banner", { anything: "kept" });
    expect(appSectionsInvalid(gone.sections, byKey)).toBe(false);
  });

  it("swaps an app section in the preview when only its values changed", () => {
    const added = theme(addAppSection(HOME, "acme.reviews/carousel", { count: 4 }).sections);
    const edited = withSections(added, setAppSectionValues(added.pages.home, "app", { count: 6 }));
    expect(previewChange(added, edited)).toEqual({ kind: "sections", ids: ["app"] });
    expect(previewChange(theme(), added)).toEqual({ kind: "reload" });
  });

});

describe("preview changes on other pages", () => {
  const withLanding = (sections: StorefrontSection[]): Theme => ({
    ...theme(),
    pages: { ...theme().pages, landing: { sale: { title: "Sale", description: "", sections } } },
  });
  const sale = { kind: "landing", slug: "sale" } as const;

  it("swaps a landing page's own sections in place, and reloads for its order or another page's edits", () => {
    const before = withLanding([section("faq", "faq"), section("seo-text", "seo")]);
    const edited = withLanding([section("faq", "faq", { heading: "Questions" }), section("seo-text", "seo")]);
    expect(previewChange(before, edited, sale)).toEqual({ kind: "sections", ids: ["faq"] });
    expect(previewChange(before, withLanding([section("seo-text", "seo"), section("faq", "faq")]), sale)).toEqual({ kind: "reload" });
    // The homepage's preview reloads for a landing page edit (it is another page).
    expect(previewChange(before, edited)).toEqual({ kind: "reload" });
    // Hiding a section reloads: it leaves the page.
    expect(previewChange(before, withLanding([{ ...section("faq", "faq"), hidden: true }, section("seo-text", "seo")]), sale)).toEqual({ kind: "reload" });
  });

  it("reloads product and listing pages for any change, and leaves an unchanged draft alone", () => {
    const before = theme();
    const product = { kind: "product" } as const;
    const reordered = { ...before, blocks: { ...before.blocks, product: { ...before.blocks.product, below: [...before.blocks.product.below].reverse() } } };
    expect(previewChange(before, reordered, product)).toEqual({ kind: "reload" });
    expect(previewChange(before, structuredClone(before), product)).toEqual({ kind: "none" });
  });

  it("moves any list item, as the tree's rows do for product modules", () => {
    expect(moveSectionTo(["description", "reviews", "related"], 2, 0)).toEqual(["related", "description", "reviews"]);
  });
});
