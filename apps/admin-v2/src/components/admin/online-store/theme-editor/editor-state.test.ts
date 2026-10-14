import { describe, expect, it } from "vitest";
import { PLUGIN_HOME_SECTIONS_MAX } from "@scalius/shared/plugins/storefront";
import {
  DEFAULT_STOREFRONT_THEME,
  STOREFRONT_MAX_SECTIONS,
  storefrontSectionDefault,
  storefrontThemeDocumentSchema,
  storefrontVisibleSection,
  type StorefrontSection,
  type StorefrontSectionType,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import type { ThemeApp, ThemeAppSettingField } from "~/lib/api-query-options/online-store";
import {
  HISTORY_COALESCE_MS,
  addBlock,
  addBlockedReason,
  appSectionInvalid,
  appSectionsByKey,
  blockList,
  canAddSectionType,
  canRemoveBlock,
  changedLeaf,
  draftedSections,
  duplicateBlock,
  duplicateSection,
  editorHistory,
  fromPageItems,
  insertItem,
  mapSection,
  moveBlock,
  moveItem,
  newAppSection,
  newSection,
  pageItems,
  removeBlock,
  removeSection,
  startHistory,
  toggleBlockHidden,
  unopenedAiSections,
  withoutAiMark,
  type PageItem,
} from "./editor-state";

type Theme = StorefrontThemeDocument;

const section = (type: StorefrontSectionType, id: string, settings: Record<string, unknown> = {}) =>
  ({ ...storefrontSectionDefault(type, id), settings: { ...storefrontSectionDefault(type, id).settings, ...settings } }) as StorefrontSection;

const HOME = [section("hero", "hero"), section("product-rail", "rail", { title: "New" }), section("faq", "faq")];
const withSections = (base: Theme, home: StorefrontSection[]): Theme => ({ ...base, pages: { ...base.pages, home } });
const theme = (home: StorefrontSection[] = HOME): Theme => withSections(DEFAULT_STOREFRONT_THEME, home);
const ids = (sections: readonly StorefrontSection[]) => sections.map((each) => each.id);
const itemIds = (items: readonly PageItem[]) => items.map((item) => item.kind === "fixed" ? "<main>" : item.section.id);
const setTitle = (title: string) => (current: Theme) => withSections(current, current.pages.home.map((each) =>
  each.id === "rail" ? { ...each, settings: { ...each.settings, title } } as StorefrontSection : each));
const homeItems = pageItems(HOME, null);

describe("editor history", () => {
  it("undoes and redoes edits; a new edit drops the redo branch", () => {
    let state = startHistory(theme());
    state = editorHistory(state, { type: "edit", update: setTitle("A"), at: 0 });
    state = editorHistory(state, { type: "edit", update: (current) => withSections(current, moveItem(current.pages.home, 2, 0)), at: 5_000 });
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
    expect(changedLeaf(before, withSections(before, moveItem(before.pages.home, 0, 2)))).toBeNull();
    expect(changedLeaf(before, before)).toBeNull();
  });

  it("drops an AI mark from every step once the section is opened, so undo never brings it back", () => {
    const drafted = { ...section("faq", "faq-2"), aiDraft: true } as StorefrontSection;
    let state = startHistory(theme());
    state = editorHistory(state, { type: "edit", update: (current) => withSections(current, [...current.pages.home, drafted]), at: 0 });
    state = editorHistory(state, { type: "edit", update: setTitle("A"), at: 5_000 });
    expect(unopenedAiSections(state.present).map((each) => each.id)).toEqual(["faq-2"]);
    state = editorHistory(state, { type: "opened", id: "faq-2" });
    expect(unopenedAiSections(state.present)).toEqual([]);
    state = editorHistory(state, { type: "undo" });
    expect(ids(state.present.pages.home)).toContain("faq-2");
    expect(unopenedAiSections(state.present)).toEqual([]);
    // Opening a section without a mark changes nothing.
    expect(editorHistory(state, { type: "opened", id: "hero" })).toBe(state);
  });

  it("finds AI marks on landing pages and templates too", () => {
    const marked = { ...section("faq", "faq"), aiDraft: true } as StorefrontSection;
    const base = theme();
    const document: Theme = {
      ...base,
      pages: {
        ...base.pages,
        landing: { sale: { title: "Sale", description: "", sections: [marked] } },
        templates: { ...base.pages.templates, cart: { sections: [{ ...marked, id: "faq-cart" } as StorefrontSection], main: 0 } },
      },
    };
    expect(unopenedAiSections(document).map((each) => each.id)).toEqual(["faq", "faq-cart"]);
    expect(unopenedAiSections(withoutAiMark(document, "faq-cart")).map((each) => each.id)).toEqual(["faq"]);
    // Unchanged lists keep their identity.
    expect(withoutAiMark(document, "nothing")).toBe(document);
  });
});

describe("a page's items", () => {
  it("puts a template's fixed part at its place and reads it back", () => {
    const items = pageItems(HOME, 1);
    expect(itemIds(items)).toEqual(["hero", "<main>", "rail", "faq"]);
    expect(fromPageItems(moveItem(items, 1, 3))).toEqual({ sections: HOME, main: 3 });
    expect(fromPageItems(homeItems)).toEqual({ sections: HOME, main: null });
    // A place past the end is the end.
    expect(itemIds(pageItems(HOME, 9))).toEqual(["hero", "rail", "faq", "<main>"]);
  });

  it("moves an item, and leaves the list alone out of range", () => {
    expect(moveItem(["hero", "rail", "faq"], 0, 2)).toEqual(["rail", "faq", "hero"]);
    expect(moveItem(["hero", "rail", "faq"], 2, 0)).toEqual(["faq", "hero", "rail"]);
    expect(moveItem(["hero", "rail", "faq"], 0, 5)).toEqual(["hero", "rail", "faq"]);
  });
});

describe("sections", () => {
  it("adds and duplicates under free ids, one hero per page, at most 24 sections", () => {
    const faq = newSection("faq", HOME);
    expect(faq.id).toBe("faq-2");
    expect(itemIds(insertItem(homeItems, faq, 1))).toEqual(["hero", "faq-2", "rail", "faq"]);
    const copy = duplicateSection(homeItems, "rail")!;
    expect(copy.id).toBe("product-rail");
    expect(itemIds(copy.items)).toEqual(["hero", "rail", "product-rail", "faq"]);
    expect(fromPageItems(copy.items).sections[2]!.settings).toEqual(HOME[1]!.settings);
    expect(duplicateSection(homeItems, "hero")).toBeNull();
    expect(canAddSectionType(HOME, "hero")).toBe(false);
    expect(addBlockedReason(HOME, "hero")).toBe("one-hero");
    expect(addBlockedReason(HOME, "faq")).toBeNull();
    const full = Array.from({ length: STOREFRONT_MAX_SECTIONS }, (_, index) => section("faq", `faq-${index}`));
    expect(canAddSectionType(full, "faq")).toBe(false);
    expect(addBlockedReason(full, "faq")).toBe("limit");
  });

  it("never copies an AI mark", () => {
    const items = pageItems([{ ...section("faq", "faq"), aiDraft: true } as StorefrontSection], null);
    const copy = duplicateSection(items, "faq")!;
    expect(fromPageItems(copy.items).sections[1]!.aiDraft).toBeUndefined();
  });

  it("removes a section with what Undo needs, and keeps a template's fixed part", () => {
    const removed = removeSection(pageItems(HOME, 1), "rail")!;
    expect(itemIds(removed.items)).toEqual(["hero", "<main>", "faq"]);
    expect(removed.removed.id).toBe("rail");
    expect(removed.index).toBe(2);
    expect(removeSection(homeItems, "missing")).toBeNull();
  });

  it("replaces one section by id and leaves the others alone", () => {
    const items = mapSection(homeItems, "rail", (each) => ({ ...each, hidden: true }) as StorefrontSection);
    expect(fromPageItems(items).sections[1]!.hidden).toBe(true);
    expect(items[0]).toBe(homeItems[0]);
  });

  it("makes AI-drafted sections the page's own: fresh ids, marked", () => {
    const added = draftedSections([section("faq", "faq"), section("faq", "faq")], HOME);
    expect(added.map((each) => [each.id, each.aiDraft])).toEqual([["faq-2", true], ["faq-3", true]]);
  });
});

describe("blocks", () => {
  const faq = section("faq", "faq", { items: [{ question: "Shipping?", answer: "Two days." }] });
  const tabs = storefrontSectionDefault("product-tabs", "tabs") as StorefrontSection;

  it("adds, duplicates, moves and removes the items of a block list", () => {
    const added = addBlock(faq, "items")!;
    expect(blockList(added, "items")).toHaveLength(2);
    const copied = duplicateBlock(faq, "items", 0)!;
    expect(blockList(copied, "items")).toEqual([blockList(faq, "items")[0], blockList(faq, "items")[0]]);
    const edited = { ...copied, settings: { ...copied.settings, items: [{ question: "A?", answer: "a" }, { question: "B?", answer: "b" }] } } as StorefrontSection;
    expect(blockList(moveBlock(edited, "items", 1, 0), "items").map((item) => (item as { question: string }).question)).toEqual(["B?", "A?"]);
    expect(blockList(removeBlock(edited, "items", 0), "items")).toEqual([{ question: "B?", answer: "b" }]);
    expect(duplicateBlock(faq, "items", 5)).toBeNull();
  });

  it("stops at a list's maximum and keeps its minimum", () => {
    const full = section("faq", "faq", { items: Array.from({ length: 20 }, (_, index) => ({ question: `Q${index}?`, answer: "a" })) });
    expect(addBlock(full, "items")).toBeNull();
    expect(duplicateBlock(full, "items", 0)).toBeNull();
    // A tab strip keeps two tabs.
    expect(canRemoveBlock(tabs, "tabs")).toBe(true);
    const two = removeBlock(tabs, "tabs", 2);
    expect(blockList(two, "tabs")).toHaveLength(2);
    expect(canRemoveBlock(two, "tabs")).toBe(false);
    expect(canRemoveBlock(faq, "items")).toBe(true);
  });

  it("gives a new slide a centred focal point", () => {
    const hero = addBlock(section("hero", "hero"), "slides")!;
    expect(blockList(hero, "slides").at(-1)).toMatchObject({ focalPoint: { x: 50, y: 50 } });
  });

  it("hides a block from buyers and shows it again; the document accepts it", () => {
    const hidden = toggleBlockHidden(faq, "items", 0);
    expect(blockList(hidden, "items")[0]).toEqual({ question: "Shipping?", answer: "Two days.", hidden: true });
    expect(blockList(storefrontVisibleSection(hidden), "items")).toEqual([]);
    expect(storefrontThemeDocumentSchema.safeParse(theme([hidden])).success).toBe(true);
    expect(blockList(toggleBlockHidden(hidden, "items", 0), "items")[0]).toEqual({ question: "Shipping?", answer: "Two days." });
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
      component: true,
    }],
    skins: [],
    templates: [], pagePresets: [],
    productBlocks: [],
  }];
  const byKey = appSectionsByKey(APPS);

  it("adds an app section under a free id with its values, and the document accepts it", () => {
    const first = newAppSection("acme.reviews/carousel", { heading: "What buyers say", count: 4 }, HOME);
    expect(first).toEqual({
      id: "app",
      type: "app",
      version: 1,
      settings: { app: "acme.reviews/carousel", values: { heading: "What buyers say", count: 4 } },
    });
    const sections = [...HOME, first];
    expect(newAppSection("acme.reviews/carousel", {}, sections).id).toBe("app-2");
    expect(storefrontThemeDocumentSchema.safeParse(theme(sections)).success).toBe(true);
    const copy = duplicateSection(pageItems(sections, null), "app")!;
    expect(copy.id).toBe("app-2");
    expect(fromPageItems(copy.items).sections[4]).toMatchObject({ type: "app", settings: first.settings });
  });

  it("lets app sections fill a page, and stops where the page does", () => {
    const apps = Array.from({ length: PLUGIN_HOME_SECTIONS_MAX }, (_, index) => ({ ...newAppSection("acme.reviews/carousel", {}, []), id: `app-${index}` }));
    expect(canAddSectionType(apps.slice(1), "app")).toBe(true);
    expect(canAddSectionType(apps, "app")).toBe(false);
    expect(addBlockedReason(apps, "app")).toBe("limit");
    expect(duplicateSection(pageItems(apps, null), "app-0")).toBeNull();
  });

  it("judges values against the app, never a section whose app is not active", () => {
    const valid = newAppSection("acme.reviews/carousel", { heading: "Reviews", count: 4 }, HOME);
    expect(appSectionInvalid(valid, byKey)).toBe(false);
    expect(appSectionInvalid({ ...valid, settings: { ...valid.settings, values: { count: 40 } } }, byKey)).toBe(true);
    expect(appSectionInvalid(newAppSection("acme.gone/banner", { anything: "kept" }, HOME), byKey)).toBe(false);
    expect(appSectionInvalid(HOME[0]!, byKey)).toBe(false);
  });
});

describe("discrete canvas text history", () => {
  it("keeps a completed canvas session separate from both neighboring pane edits", () => {
    let state = startHistory(theme());
    state = editorHistory(state, { type: "edit", update: setTitle("Pane before"), at: 1 });
    state = editorHistory(state, { type: "edit", update: setTitle("Canvas session"), at: 2, discrete: true });
    state = editorHistory(state, { type: "edit", update: setTitle("Pane after"), at: 3 });
    expect(state.past).toHaveLength(3);
    state = editorHistory(state, { type: "undo" });
    expect(state.present.pages.home[1]?.settings).toMatchObject({ title: "Canvas session" });
    state = editorHistory(state, { type: "undo" });
    expect(state.present.pages.home[1]?.settings).toMatchObject({ title: "Pane before" });
    state = editorHistory(state, { type: "redo" });
    expect(state.present.pages.home[1]?.settings).toMatchObject({ title: "Canvas session" });
  });
});
