import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STOREFRONT_THEME, storefrontSectionDefault, type StorefrontThemeDocument } from "@scalius/shared/storefront-theme";
import { assertThemeBindings } from "./theme-bindings";
import { publishThemeDraft, saveThemeDraft } from "./site-settings.service";

describe("theme dynamic source writes", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  beforeEach(() => { ({ sqlite, db } = createSqliteD1Database()); });
  afterEach(() => sqlite.close());

  function themeWith(source: string, path = "heading"): StorefrontThemeDocument {
    const theme = structuredClone(DEFAULT_STOREFRONT_THEME);
    theme.pages.home = [];
    theme.pages.templates.product.sections = [{ ...storefrontSectionDefault("seo-text", "details"), bindings: { [path]: { source } } }];
    return theme;
  }

  function field(type = "single_line_text", owner = "product", visible = true): void {
    sqlite.prepare(`INSERT INTO custom_field_definitions (id, owner_type, namespace, key, name, type, storefront_visible)
      VALUES (?, ?, 'custom', 'details', 'Details', ?, ?)`).run(`cfd_${owner}_details`, owner, type, Number(visible));
  }

  it("does no reads when bindings and card fields are absent", async () => {
    const select = vi.fn(() => { throw new Error("Unexpected read"); });
    await assertThemeBindings({ select } as unknown as Database, DEFAULT_STOREFRONT_THEME);
    expect(select).not.toHaveBeenCalled();
  });

  it("accepts resource fields without reads, only in a matching resource placement", async () => {
    const select = vi.fn(() => { throw new Error("Unexpected read"); });
    const theme = themeWith("resource.title");
    await expect(assertThemeBindings({ select } as unknown as Database, theme)).resolves.toBeUndefined();
    theme.pages.home = theme.pages.templates.product.sections;
    await expect(assertThemeBindings(db, theme)).rejects.toMatchObject({ status: 400 });
    expect(select).not.toHaveBeenCalled();
  });

  it("checks destination existence, active union branches and list bounds", async () => {
    for (const path of ["missing", "heading.missing", "constructor"]) {
      await expect(assertThemeBindings(db, themeWith("resource.title", path))).rejects.toMatchObject({ status: 400 });
    }
    const theme = themeWith("resource.title");
    theme.pages.templates.product.sections = [{ ...storefrontSectionDefault("hero", "hero"), bindings: { "slides.0.heading": { source: "resource.title" } } }];
    await expect(assertThemeBindings(db, theme)).rejects.toMatchObject({ status: 400 });
    const hero = theme.pages.templates.product.sections[0]!;
    if (hero.type !== "hero") throw new Error("Expected hero");
    hero.settings.slides.push({ image: "image", alt: "Image", heading: "Fallback", focalPoint: { x: 50, y: 50 }, link: null });
    await expect(assertThemeBindings(db, theme)).resolves.toBeUndefined();
  });

  it("accepts public custom fields and refuses private, wrong-owner or incompatible fields", async () => {
    field();
    await expect(assertThemeBindings(db, themeWith("resource.cf.custom.details"))).resolves.toBeUndefined();
    sqlite.exec("UPDATE custom_field_definitions SET storefront_visible = 0");
    await expect(assertThemeBindings(db, themeWith("resource.cf.custom.details"))).rejects.toMatchObject({ status: 400 });
    sqlite.exec("DELETE FROM custom_field_definitions");
    field("single_line_text", "page");
    await expect(assertThemeBindings(db, themeWith("resource.cf.custom.details"))).rejects.toMatchObject({ status: 400 });
    sqlite.exec("DELETE FROM custom_field_definitions");
    field("boolean");
    await expect(assertThemeBindings(db, themeWith("resource.cf.custom.details"))).rejects.toMatchObject({ status: 400 });
  });

  it("checks public object type/field definitions and rejects missing types", async () => {
    const theme = themeWith("object.custom.testimonials.first.title");
    await expect(assertThemeBindings(db, theme)).rejects.toMatchObject({ status: 400 });
    sqlite.prepare(`INSERT INTO object_types (id, namespace, type, name, fields_json, storefront, handle)
      VALUES ('oty_custom.testimonials', 'custom', 'testimonials', 'Testimonials', ?, 1, 1)`)
      .run(JSON.stringify([{ key: "title", name: "Title", type: "single_line_text" }]));
    await expect(assertThemeBindings(db, theme)).resolves.toBeUndefined();
    await expect(assertThemeBindings(db, themeWith("object.custom.testimonials.first.missing"))).rejects.toMatchObject({ status: 400 });
    sqlite.exec("UPDATE object_types SET storefront = 0");
    await expect(assertThemeBindings(db, theme)).rejects.toMatchObject({ status: 400 });
  });

  it("validates app destinations against their current manifest declaration", async () => {
    const theme = themeWith("resource.title");
    theme.pages.templates.product.sections = [{ id: "app", type: "app", version: 1, settings: { app: "demo.theme/intro", values: { title: "Fallback" } }, bindings: { title: { source: "resource.title" } } }];
    await expect(assertThemeBindings(db, theme)).rejects.toMatchObject({ status: 400 });
    const manifest = { storefront: { sections: [{ type: "intro", settings: [{ key: "title", label: "Title", type: "text" }] }] } };
    sqlite.prepare(`INSERT INTO plugin_installations (plugin_id, version, source, bundle_sha256, manifest_json, grant_json, grant_key, status)
      VALUES ('demo.theme', '1.0.0', 'bundled', ?, ?, '{}', 'grant', 'active')`).run("a".repeat(64), JSON.stringify(manifest));
    await expect(assertThemeBindings(db, theme)).resolves.toBeUndefined();
    manifest.storefront.sections[0]!.settings[0]!.type = "boolean";
    sqlite.prepare("UPDATE plugin_installations SET manifest_json = ?").run(JSON.stringify(manifest));
    await expect(assertThemeBindings(db, theme)).rejects.toMatchObject({ status: 400 });
  });

  it("only maps object lists to compatible item fields", async () => {
    const theme = structuredClone(DEFAULT_STOREFRONT_THEME);
    theme.pages.home = [{ ...storefrontSectionDefault("utility-cards", "cards"), bindings: { cards: { source: "object.custom.cards" } } }];
    sqlite.prepare(`INSERT INTO object_types (id, namespace, type, name, fields_json, storefront)
      VALUES ('oty_custom.cards', 'custom', 'cards', 'Cards', ?, 1)`)
      .run(JSON.stringify([{ key: "title", type: "single_line_text" }, { key: "text", type: "multi_line_text" }, { key: "href", type: "url" }, { key: "extra", type: "boolean" }]));
    await expect(assertThemeBindings(db, theme)).resolves.toBeUndefined();
    sqlite.prepare("UPDATE object_types SET fields_json = ?").run(JSON.stringify([{ key: "title", type: "boolean" }]));
    await expect(assertThemeBindings(db, theme)).rejects.toMatchObject({ status: 400 });
    theme.pages.home = [{ ...storefrontSectionDefault("category-tiles", "categories"), bindings: { categoryIds: { source: "object.custom.cards" } } }];
    await expect(assertThemeBindings(db, theme)).rejects.toMatchObject({ status: 400 });
  });

  it("counts global sources toward each page's four object type limit", async () => {
    const theme = themeWith("object.custom.first.record.title");
    theme.blocks.footer.bindings = { tagline: { source: "object.custom.global.record.title" } };
    theme.pages.templates.product.sections = ["first", "second", "third", "fourth"].map((type) => ({
      ...storefrontSectionDefault("seo-text", type), bindings: { heading: { source: `object.custom.${type}.record.title` } },
    }));
    const select = vi.fn(() => { throw new Error("Unexpected read"); });
    await expect(assertThemeBindings({ select } as unknown as Database, theme)).rejects.toMatchObject({ status: 400, message: "Connect at most four object types on one page." });
    expect(select).not.toHaveBeenCalled();
  });

  it("shares the object type budget with standalone sections and deduplicates their types", async () => {
    const theme = structuredClone(DEFAULT_STOREFRONT_THEME);
    theme.pages.home = ["first", "second", "third", "fourth"].map((type) => ({
      ...storefrontSectionDefault("objects", type), settings: { heading: "", typeId: `oty_custom.${type}`, layout: "list", limit: 12 },
    }));
    const select = vi.fn(() => { throw new Error("Unexpected read"); });
    await expect(assertThemeBindings({ select } as unknown as Database, theme)).resolves.toBeUndefined();
    theme.pages.home.push({ ...theme.pages.home[0]!, id: "first-again" });
    await expect(assertThemeBindings({ select } as unknown as Database, theme)).resolves.toBeUndefined();
    theme.blocks.footer.bindings = { tagline: { source: "object.custom.fifth.record.title" } };
    await expect(assertThemeBindings({ select } as unknown as Database, theme)).rejects.toMatchObject({ status: 400, message: "Connect at most four object types on one page." });
    expect(select).not.toHaveBeenCalled();
  });

  it("checks skin targets and their live setting schemas", async () => {
    const theme = structuredClone(DEFAULT_STOREFRONT_THEME);
    theme.apps = { skins: { "product-main": { app: "demo.theme/main", values: { title: "Fallback" }, bindings: { title: { source: "resource.title" } } } } };
    const manifest = { storefront: { skins: [{ id: "main", target: "product-main", settings: [{ key: "title", label: "Title", type: "text" }] }] } };
    sqlite.prepare(`INSERT INTO plugin_installations (plugin_id, version, source, bundle_sha256, manifest_json, grant_json, grant_key, status)
      VALUES ('demo.theme', '1.0.0', 'bundled', ?, ?, '{}', 'grant', 'active')`).run("a".repeat(64), JSON.stringify(manifest));
    await expect(assertThemeBindings(db, theme)).resolves.toBeUndefined();
    manifest.storefront.skins[0]!.target = "footer";
    sqlite.prepare("UPDATE plugin_installations SET manifest_json = ?").run(JSON.stringify(manifest));
    await expect(assertThemeBindings(db, theme)).rejects.toMatchObject({ status: 400 });
  });

  it("only accepts storefront-visible product card fields", async () => {
    const theme = structuredClone(DEFAULT_STOREFRONT_THEME);
    theme.blocks.card.fields = ["custom.details"];
    field("single_line_text", "page");
    await expect(assertThemeBindings(db, theme)).rejects.toMatchObject({ status: 400 });
    field();
    await expect(assertThemeBindings(db, theme)).resolves.toBeUndefined();
  });

  it("rechecks source visibility when the saved draft is published", async () => {
    field();
    await saveThemeDraft(db, themeWith("resource.cf.custom.details"), 0, 0);
    sqlite.exec("UPDATE custom_field_definitions SET storefront_visible = 0");
    await expect(publishThemeDraft(db, 0, 1)).rejects.toMatchObject({ status: 400 });
    expect(sqlite.prepare("SELECT count(*) AS count FROM theme_settings").get()).toEqual({ count: 0 });
  });
});
