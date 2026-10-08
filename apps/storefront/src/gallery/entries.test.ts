// @vitest-environment node
/**
 * The gallery stays in sync with the theme registry: every section type,
 * every closed choice of its settings, every block variant, template,
 * product module, sticky bar and palette has an entry; every entry is a
 * saveable document; the fixture store is as large as promised; and no
 * storefront code outside this folder imports it (so no build carries it).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  STOREFRONT_BLOCK_REGISTRY,
  STOREFRONT_CARD_ACTIONS,
  STOREFRONT_CARD_FACTS,
  STOREFRONT_PRODUCT_MODULES,
  STOREFRONT_PRODUCT_STICKY,
  STOREFRONT_SECTION_REGISTRY,
  STOREFRONT_SECTION_TYPES,
  STOREFRONT_TEMPLATE_IDS,
  STOREFRONT_THEME_PALETTE_KEYS,
  storefrontThemeDocumentSchema,
  type StorefrontBlockSlot,
} from "@scalius/shared/storefront-theme";
import { cardEntryId, entryId, galleryEntries } from "./entries";
import { galleryCartSeed, fixtureProductSoldOut } from "./cart-seed";
import { galleryIndex } from "./server";
import { SECTION_CONTENT } from "./section-content";
import { settingChoices, type SettingsSchema } from "./variants";
import { fixtureFacets, fixtureMenu, menuLinkCount } from "./fixtures";

const entries = galleryEntries();
const ids = new Set(entries.map((entry) => entry.id));
const families = new Set(entries.map((entry) => entry.family));

describe("the storefront gallery", () => {
  it("has unique ids and only saveable theme documents", () => {
    expect(ids.size).toBe(entries.length);
    for (const entry of entries) expect(storefrontThemeDocumentSchema.safeParse(entry.theme).success, entry.id).toBe(true);
  });

  it("has content and entries for every section type and every value of its closed choices", () => {
    for (const type of STOREFRONT_SECTION_TYPES) {
      expect(SECTION_CONTENT[type], type).toBeDefined();
      expect(families.has(`section:${type}`), type).toBe(true);
      const sectionEntries = entries.filter((entry) => entry.family === `section:${type}`);
      for (const { path, values } of settingChoices(STOREFRONT_SECTION_REGISTRY[type].settings as SettingsSchema)) {
        for (const value of values) {
          // Each value renders in some entry of the section (the base, or the entry varying it).
          const shown = sectionEntries.some((entry) => {
            const section = entry.theme.pages.home.find((each) => each.id === "gallery");
            return section && path.split(".").reduce<unknown>((current, key) => (current as Record<string, unknown> | undefined)?.[key], section.settings) === value;
          });
          // A value the schema refuses over the base content (none today) is the only exception.
          expect(shown, `${type} ${path}=${String(value)}`).toBe(true);
        }
      }
    }
  });

  it("has an entry for every block variant", () => {
    for (const slot of Object.keys(STOREFRONT_BLOCK_REGISTRY) as StorefrontBlockSlot[]) {
      for (const variant of Object.keys(STOREFRONT_BLOCK_REGISTRY[slot])) {
        expect(ids.has(entryId("block", slot, variant, "default")), `${slot}/${variant}`).toBe(true);
      }
    }
  });

  it("has an entry for every product card facts x action combination", () => {
    for (const facts of STOREFRONT_CARD_FACTS) {
      for (const action of STOREFRONT_CARD_ACTIONS) expect(ids.has(cardEntryId(facts, action)), `${facts} ${action}`).toBe(true);
    }
  });

  it("has every template on every page kind, every product module, sticky bar and palette", () => {
    for (const template of STOREFRONT_TEMPLATE_IDS) {
      for (const page of ["home", "product", "category", "cart", "cms page"]) expect(ids.has(entryId("template", template, page)), `${template} ${page}`).toBe(true);
    }
    for (const module of Object.keys(STOREFRONT_PRODUCT_MODULES)) expect(ids.has(entryId("product", "module", module)), module).toBe(true);
    for (const [position, values] of Object.entries(STOREFRONT_PRODUCT_STICKY)) {
      for (const value of values) expect(ids.has(entryId("product", "sticky", `${position}=${value}`)), `${position}=${value}`).toBe(true);
    }
    for (const palette of STOREFRONT_THEME_PALETTE_KEYS) expect(families.has(`palette:${palette}`), palette).toBe(true);
    for (const family of ["app:section", "app:product-block", "locale:bn", "locale:rtl", "page:cart", "page:cms", "page:landing"]) expect(families.has(family), family).toBe(true);
  });

  it("audits the cart page with lines in it: 1, 3 and 10 lines, a sold-out line and a Bangla cart", () => {
    const seeded = entries.filter((entry) => entry.page === "cart" && entry.scenario.cart);
    expect(seeded.map((entry) => entry.scenario.cart).sort()).toEqual(["bangla", "one", "sold-out", "ten", "three"]);
    const lines = (kind: Parameters<typeof galleryCartSeed>[0]) => Object.keys(galleryCartSeed(kind).items);
    expect([lines("one").length, lines("three").length, lines("ten").length]).toEqual([1, 3, 10]);
    // The sold-out cart carries a product the fixture API answers "sold out" for.
    const soldOut = Object.values(galleryCartSeed("sold-out").items) as Array<{ id: string; variantId: string }>;
    expect(soldOut.some((line) => fixtureProductSoldOut(line.id))).toBe(true);
    // Every line has the persisted ids the cart store requires.
    for (const line of soldOut) expect(line.variantId).toMatch(/^var_/);
    // The index hands the harness the seed (and an empty cart none).
    const index = galleryIndex();
    expect(index.find((entry) => entry.id === entryId("page", "cart", "three"))?.cartSeed?.discountCodes).toEqual([]);
    expect(index.find((entry) => entry.id === entryId("page", "cart"))?.cartSeed).toBeNull();
  });

  it("uses a large fixture store: a 1,000+ link menu and 50+ facets", () => {
    expect(menuLinkCount(fixtureMenu())).toBeGreaterThanOrEqual(1000);
    expect(fixtureFacets().length).toBeGreaterThanOrEqual(50);
  });

  it("is imported by nothing outside its own folder", () => {
    const src = fileURLToPath(new URL("..", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== "gallery") walk(path);
        } else if (/\.(astro|ts|tsx|js|mjs)$/.test(name)) files.push(path);
      }
    };
    walk(src);
    const importers = files.filter((file) => /from\s+["'][^"']*\/gallery(\/|["'])|import\(["'][^"']*\/gallery/.test(readFileSync(file, "utf8")));
    expect(importers.map((file) => relative(src, file))).toEqual([]);
  });
});
