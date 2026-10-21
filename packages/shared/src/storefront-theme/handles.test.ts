// Catalogue handles in app theme declarations: every form resolves, an
// unknown handle leaves its section out (and only it), and a declaration
// checks without a store through distinct placeholders.
import { describe, expect, it } from "vitest";
import {
  resolveStorefrontHandles,
  storefrontHandlePlaceholder,
  storefrontHandleRefs,
  type StorefrontHandleLookup,
} from "./handles";
import {
  checkStorefrontAppTemplateTheme,
  checkStorefrontPagePresetSections,
  resolveStorefrontAppTemplateTheme,
  resolveStorefrontPagePresetSections,
} from "./app-templates";
import { STOREFRONT_THEME_DOCUMENT_VERSION } from "./document";

const STORE: Record<string, string> = { "category:laptops": "cat_1", "collection:hot-deals": "col_9", "category:phones": "cat_2" };
const lookup: StorefrontHandleLookup = (ref) => STORE[`${ref.kind}:${ref.handle}`] ?? null;

const tiles = (ids: string[]) => ({ id: "tiles", type: "category_tiles", version: 1, settings: { style: "round", title: "", categoryIds: ids } });
const rail = (source: unknown) => ({ id: "rail", type: "product_rail", version: 1, settings: { title: "Deals", source, limit: 8 } });

describe("catalogue handles", () => {
  it("resolves product sources, id lists and links, and leaves other values alone", () => {
    const value = {
      source: { kind: "collection", handle: "hot-deals" },
      categoryIds: ["@category:laptops", "@category:phones", "cat_raw"],
      link: "/collections/@hot-deals?sort=new",
      category: "/categories/@laptops#top",
      plain: "@not-a-ref",
      extra: { kind: "category", handle: "laptops", more: true },
    };
    const { value: resolved, unresolved } = resolveStorefrontHandles(value, lookup);
    expect(unresolved).toEqual([]);
    expect(resolved).toEqual({
      source: { kind: "collection", collectionId: "col_9" },
      categoryIds: ["cat_1", "cat_2", "cat_raw"],
      link: "/collections/col_9?sort=new",
      category: "/categories/laptops#top",
      plain: "@not-a-ref",
      extra: { kind: "category", handle: "laptops", more: true },
    });
    expect(value.source).toEqual({ kind: "collection", handle: "hot-deals" });
    expect(storefrontHandleRefs(value).map((ref) => `${ref.kind}:${ref.handle}`)).toEqual(["collection:hot-deals", "category:laptops", "category:phones"]);
  });

  it("reports a handle the store lacks and keeps it in place", () => {
    const { value, unresolved } = resolveStorefrontHandles(["@collection:gone"], lookup);
    expect(value).toEqual(["@collection:gone"]);
    expect(unresolved).toEqual([{ kind: "collection", handle: "gone" }]);
  });

  it("gives distinct handles distinct placeholders within the record id length", () => {
    const long = "a".repeat(90);
    const first = storefrontHandlePlaceholder({ kind: "category", handle: `${long}-x` });
    const second = storefrontHandlePlaceholder({ kind: "category", handle: `${long}-y` });
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(64);
  });
});

describe("app templates and presets with handles", () => {
  const theme = { sections: [tiles(["@category:laptops", "@category:phones"]), rail({ kind: "collection", handle: "hot-deals" })] };

  it("check without a store (placeholders), resolve against one", () => {
    expect(checkStorefrontAppTemplateTheme(theme, STOREFRONT_THEME_DOCUMENT_VERSION).ok).toBe(true);
    const read = resolveStorefrontAppTemplateTheme(theme, STOREFRONT_THEME_DOCUMENT_VERSION, lookup);
    if (!read.ok) throw new Error(read.problem);
    expect(read.unresolved).toEqual([]);
    expect(read.value.sections?.map((section) => section.settings)).toEqual([
      expect.objectContaining({ categoryIds: ["cat_1", "cat_2"] }),
      expect.objectContaining({ source: { kind: "collection", collectionId: "col_9" } }),
    ]);
  });

  it("leaves out only the section naming a missing handle, and says which", () => {
    const missing = { sections: [tiles(["@category:laptops", "@category:tablets"]), rail({ kind: "collection", handle: "hot-deals" })] };
    const read = resolveStorefrontAppTemplateTheme(missing, STOREFRONT_THEME_DOCUMENT_VERSION, lookup);
    if (!read.ok) throw new Error(read.problem);
    expect(read.value.sections?.map((section) => section.id)).toEqual(["rail"]);
    expect(read.unresolved).toEqual([{ kind: "category", handle: "tablets", sectionId: "tiles" }]);
    const preset = resolveStorefrontPagePresetSections(missing.sections, STOREFRONT_THEME_DOCUMENT_VERSION, lookup);
    if (!preset.ok) throw new Error(preset.problem);
    expect(preset.value.map((section) => section.id)).toEqual(["rail"]);
    expect(checkStorefrontPagePresetSections(missing.sections, STOREFRONT_THEME_DOCUMENT_VERSION).ok).toBe(true);
  });
});
