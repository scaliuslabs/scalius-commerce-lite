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
  STOREFRONT_PRODUCT_MODULES,
  STOREFRONT_PRODUCT_STICKY,
  STOREFRONT_SECTION_REGISTRY,
  STOREFRONT_SECTION_TYPES,
  STOREFRONT_TEMPLATE_IDS,
  STOREFRONT_THEME_PALETTE_KEYS,
  storefrontThemeDocumentSchema,
  type StorefrontBlockSlot,
} from "@scalius/shared/storefront-theme";
import { entryId, galleryEntries } from "./entries";
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

  it("has every template on every page kind, every product module, sticky bar and palette", () => {
    for (const template of STOREFRONT_TEMPLATE_IDS) {
      for (const page of ["home", "product", "category", "cart", "cms page"]) expect(ids.has(entryId("template", template, page)), `${template} ${page}`).toBe(true);
    }
    for (const module of Object.keys(STOREFRONT_PRODUCT_MODULES)) expect(ids.has(entryId("product", "module", module)), module).toBe(true);
    for (const [position, values] of Object.entries(STOREFRONT_PRODUCT_STICKY)) {
      for (const value of values) expect(ids.has(entryId("product", "sticky", `${position}=${value}`)), `${position}=${value}`).toBe(true);
    }
    for (const palette of STOREFRONT_THEME_PALETTE_KEYS) expect(families.has(`palette:${palette}`), palette).toBe(true);
    for (const family of ["app:section", "app:product-block", "app:checkout-block", "locale:bn", "locale:rtl", "page:cart", "page:cms", "page:landing"]) expect(families.has(family), family).toBe(true);
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
