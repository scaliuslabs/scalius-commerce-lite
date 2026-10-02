import { describe, expect, it } from "vitest";
import {
  DEFAULT_STOREFRONT_THEME,
  STOREFRONT_MAX_SECTIONS,
  storefrontSectionDefault,
  type StorefrontSection,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import {
  HISTORY_COALESCE_MS,
  addSection,
  canAddSectionType,
  changedLeaf,
  duplicateSection,
  editorHistory,
  mergeDrafts,
  moveSectionTo,
  previewChange,
  removeSection,
  restoreSection,
  startHistory,
  withSections,
} from "./editor-state";

type Theme = StorefrontThemeDocument;

const section = (type: StorefrontSection["type"], id: string, settings: Record<string, unknown> = {}) =>
  ({ ...storefrontSectionDefault(type, id), settings: { ...storefrontSectionDefault(type, id).settings, ...settings } }) as StorefrontSection;

const HOME = [section("hero", "hero"), section("product-rail", "rail", { title: "New" }), section("faq", "faq")];
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

describe("merging edits onto a newer draft", () => {
  it("keeps the merchant's section edits and the other session's, section by section", () => {
    const base = theme();
    const mine = setTitle("Mine")(base);
    const theirs = withSections(base, base.pages.home.map((each) => each.id === "faq" ? { ...each, settings: { ...each.settings, heading: "Theirs" } } as StorefrontSection : each));
    const merged = mergeDrafts(mine, base, theirs);
    expect(merged.pages.home.find((each) => each.id === "rail")!.settings).toMatchObject({ title: "Mine" });
    expect(merged.pages.home.find((each) => each.id === "faq")!.settings).toMatchObject({ heading: "Theirs" });
  });

  it("keeps sections added on either side, drops ones removed, and follows the order the merchant set", () => {
    const base = theme();
    const mine = withSections(base, [...moveSectionTo(HOME, 2, 0), section("seo-text", "seo")]);
    const theirs = withSections(base, [...HOME.filter((each) => each.id !== "hero"), section("brand-wall", "brands")]);
    expect(ids(mergeDrafts(mine, base, theirs).pages.home)).toEqual(["faq", "rail", "seo", "brands"]);
    // Without a reorder here, their order wins.
    const added = withSections(base, [...HOME, section("seo-text", "seo")]);
    expect(ids(mergeDrafts(added, base, theirs).pages.home)).toEqual(["rail", "faq", "brands", "seo"]);
  });

  it("takes the newer value for fields the merchant left alone", () => {
    const base = theme();
    const mine = setTitle("Mine")(base);
    const theirs = { ...base, tokens: { ...base.tokens, density: "airy" as const } };
    const merged = mergeDrafts(mine, base, theirs);
    expect(merged.tokens.density).toBe("airy");
  });
});
