import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { seedHomepageCategories, seedHomepageTheme } from "./seed-large.mjs";

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE categories (id TEXT PRIMARY KEY, status TEXT, deleted_at INTEGER, parent_id TEXT, image_url TEXT);
    CREATE TABLE products (id TEXT PRIMARY KEY, category_id TEXT);
    CREATE INDEX products_category_id_idx ON products (category_id);
    CREATE TABLE product_media (product_id TEXT, media_id TEXT, is_primary INTEGER, sort_order INTEGER);
    CREATE TABLE media (id TEXT PRIMARY KEY, kind TEXT, object_key TEXT, variant_width INTEGER, width INTEGER, height INTEGER);
    CREATE TABLE collections (id TEXT PRIMARY KEY, is_active INTEGER, deleted_at INTEGER, sort_order INTEGER);
    CREATE TABLE theme_settings (id TEXT PRIMARY KEY, colors TEXT, revision INTEGER, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE theme_settings_drafts (id TEXT PRIMARY KEY, theme TEXT);`);
  return db;
}

it("seeds a bounded, published category tile set with available category photos", () => {
  const db = database();
  const insert = db.prepare("INSERT INTO categories VALUES (?, ?, NULL, NULL, NULL)");
  for (let i = 14; i >= 0; i -= 1) insert.run(`cat_${String(i).padStart(2, "0")}`, "published");
  insert.run("draft", "draft");
  db.exec("UPDATE categories SET image_url = 'https://photos.test/already.webp' WHERE id = 'cat_00'");
  db.exec("INSERT INTO products VALUES ('product', 'cat_01'); INSERT INTO media (id, kind, object_key, variant_width) VALUES ('photo', 'image', 'media/pool/p001.jpg', 1600); INSERT INTO product_media VALUES ('product', 'photo', 1, 0)");

  const ids = seedHomepageCategories(db, "http://localhost:4603/");
  expect(ids).toEqual(Array.from({ length: 12 }, (_, i) => `cat_${String(i).padStart(2, "0")}`));
  expect(db.prepare("SELECT image_url FROM categories WHERE id = 'cat_00'").get().image_url).toBe("https://photos.test/already.webp");
  expect(db.prepare("SELECT image_url FROM categories WHERE id = 'cat_01'").get().image_url).toBe("http://localhost:4603/media/pool/p001.jpg/1600.webp");
  expect(seedHomepageCategories(db, "http://localhost:4603/")).toEqual(ids);
  db.close();
});

it("writes the homepage into the published theme: slides by media id, category tiles and collections", () => {
  const db = database();
  const media = db.prepare("INSERT INTO media (id, kind, object_key, variant_width, width, height) VALUES (?, 'image', ?, 2400, ?, ?)");
  for (const [id, width, height] of [["med_fid_h000", 2400, 920], ["med_fid_h001", 2400, 920], ["med_fid_h002", 2400, 920], ["med_fid_h003", 1080, 1080], ["med_fid_h004", 1080, 1080], ["med_fid_poster", 1280, 720]]) {
    media.run(id, `media/pool/${id}.jpg`, width, height);
  }
  const collection = db.prepare("INSERT INTO collections VALUES (?, ?, ?, ?)");
  for (let i = 0; i < 10; i += 1) collection.run(`col_${i}`, i === 2 ? 0 : 1, i === 3 ? 1 : null, 9 - i);
  db.exec("INSERT INTO theme_settings_drafts VALUES ('default', '{}')");
  const theme = {
    version: 6,
    template: "department-mall",
    pages: {
      home: [
        { id: "hero", type: "hero", version: 1, settings: { layout: "contained-banners", slides: [] } },
        { id: "collections", type: "collections", version: 1, settings: { carousel: "large", collectionIds: [] } },
        { id: "categories", type: "category_tiles", version: 1, settings: { style: "photo", title: "", categoryIds: [] } },
        { id: "delivery", type: "usp_strip", version: 1, settings: { style: "icons", source: { kind: "delivery-facts" } } },
      ],
      homeMode: { kind: "sections" },
    },
  };

  const seeded = seedHomepageTheme(db, theme, { categoryIds: ["cat_00", "cat_01"] });
  const stored = JSON.parse(db.prepare("SELECT colors FROM theme_settings WHERE id = 'default'").get().colors);
  const [hero, collections, categories, delivery] = stored.pages.home;
  expect(hero.settings.slides).toEqual([
    { image: "med_fid_h000", phoneImage: "med_fid_h003", focalPoint: { x: 50, y: 50 }, alt: "Mega sale banner 1", link: "/search?q=laptop" },
    { image: "med_fid_h001", phoneImage: "med_fid_h004", focalPoint: { x: 50, y: 50 }, alt: "Mega sale banner 2", link: "/search?q=laptop" },
    { image: "med_fid_h002", focalPoint: { x: 50, y: 50 }, alt: "Mega sale banner 3", link: "/search?q=laptop" },
  ]);
  // Active, live collections by sort order, at most eight (the section's limit).
  expect(collections.settings).toEqual({ carousel: "large", collectionIds: ["col_9", "col_8", "col_7", "col_6", "col_5", "col_4", "col_1", "col_0"] });
  expect(categories.settings).toEqual({ style: "photo", title: "Shop by category", categoryIds: ["cat_00", "cat_01"] });
  expect(delivery).toEqual(theme.pages.home[3]);
  expect(seeded.collectionIds).toEqual(collections.settings.collectionIds);
  expect(db.prepare("SELECT count(*) AS n FROM theme_settings_drafts").get().n).toBe(0);

  seedHomepageTheme(db, theme, { categoryIds: ["cat_00", "cat_01"] });
  expect(db.prepare("SELECT revision FROM theme_settings WHERE id = 'default'").get().revision).toBe(2);
  expect(() => seedHomepageTheme(db, { ...theme, pages: { ...theme.pages, home: theme.pages.home.slice(0, 1) } }, { categoryIds: [] }))
    .toThrow(/no category_tiles, collections section/);
  db.close();
});
