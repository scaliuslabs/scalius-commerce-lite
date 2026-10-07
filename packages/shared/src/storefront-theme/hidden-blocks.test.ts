import { describe, expect, it } from "vitest";
import {
  STOREFRONT_SECTION_BLOCKS,
  storefrontSectionBlockLists,
  storefrontSectionDefault,
  storefrontSectionNeedsContent,
  storefrontSectionSchema,
  storefrontSettingAt,
  storefrontSettingWith,
  storefrontVisibleSection,
} from "./sections";

function faqWith(items: Array<{ question: string; answer: string; hidden?: boolean }>) {
  const section = storefrontSectionDefault("faq", "questions");
  return { ...section, settings: { ...section.settings, items } };
}

describe("hidden blocks", () => {
  it("drops hidden items from the visible section and keeps the stored one untouched", () => {
    const section = faqWith([
      { question: "Shipping?", answer: "Two days." },
      { question: "Returns?", answer: "Thirty days.", hidden: true },
    ]);
    const visible = storefrontVisibleSection(section);
    expect(visible.settings.items).toEqual([{ question: "Shipping?", answer: "Two days." }]);
    expect(section.settings.items).toHaveLength(2);
    expect(visible.id).toBe("questions");
  });

  it("returns the same object when nothing is hidden, or the section has no blocks", () => {
    const plain = faqWith([{ question: "Shipping?", answer: "Two days." }]);
    expect(storefrontVisibleSection(plain)).toBe(plain);
    const newsletter = storefrontSectionDefault("newsletter", "signup");
    expect(storefrontVisibleSection(newsletter)).toBe(newsletter);
  });

  it("treats a section whose blocks are all hidden as having nothing to show", () => {
    const hero = storefrontSectionDefault("hero", "hero");
    expect(storefrontSectionNeedsContent(hero)).toBe(true);
    const section = faqWith([{ question: "Q?", answer: "A.", hidden: true }]);
    expect(storefrontVisibleSection(section).settings.items).toEqual([]);
  });

  it("stores hidden as a boolean on a block", () => {
    expect(storefrontSectionSchema.safeParse(faqWith([{ question: "Q?", answer: "A.", hidden: true }])).success).toBe(true);
    const bad = faqWith([{ question: "Q?", answer: "A.", hidden: "yes" as unknown as boolean }]);
    expect(storefrontSectionSchema.safeParse(bad).success).toBe(false);
  });

  it("lists the block lists of each type and none for a type without blocks or an app", () => {
    expect(storefrontSectionBlockLists("faq")).toEqual([{ path: "items", kind: "question" }]);
    expect(storefrontSectionBlockLists("hero").map((each) => each.path)).toEqual(["slides", "sideBanners"]);
    expect(storefrontSectionBlockLists("newsletter")).toEqual([]);
    expect(storefrontSectionBlockLists("app")).toEqual([]);
    for (const [type, lists] of Object.entries(STOREFRONT_SECTION_BLOCKS)) {
      expect(storefrontSectionBlockLists(type as never), type).toEqual(lists);
    }
  });

  it("reads and writes a dotted settings path without touching the original", () => {
    const settings = { source: { kind: "custom", items: [1, 2] }, other: 1 };
    expect(storefrontSettingAt(settings, "source.items")).toEqual([1, 2]);
    expect(storefrontSettingAt(settings, "source.missing.deep")).toBeUndefined();
    expect(storefrontSettingAt(null, "a")).toBeUndefined();
    const next = storefrontSettingWith(settings, "source.items", [3]);
    expect(next).toEqual({ source: { kind: "custom", items: [3] }, other: 1 });
    expect(settings.source.items).toEqual([1, 2]);
    expect(next.other).toBe(settings.other);
  });
});

describe("AI-drafted sections", () => {
  it("accepts aiDraft: true only", () => {
    const section = faqWith([]);
    expect(storefrontSectionSchema.safeParse({ ...section, aiDraft: true }).success).toBe(true);
    expect(storefrontSectionSchema.safeParse({ ...section, aiDraft: false }).success).toBe(false);
  });
});
