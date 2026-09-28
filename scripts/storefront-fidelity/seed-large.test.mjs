import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { seedHomepageCategories } from "./seed-large.mjs";

it("seeds a bounded, published homepage rail with available category photos", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE categories (id TEXT PRIMARY KEY, status TEXT, deleted_at INTEGER, parent_id TEXT, image_url TEXT);
    CREATE TABLE products (id TEXT PRIMARY KEY, category_id TEXT);
    CREATE INDEX products_category_id_idx ON products (category_id);
    CREATE TABLE product_media (product_id TEXT, media_id TEXT, is_primary INTEGER, sort_order INTEGER);
    CREATE TABLE media (id TEXT PRIMARY KEY, kind TEXT, object_key TEXT, variant_width INTEGER);
    CREATE TABLE settings (id TEXT PRIMARY KEY, key TEXT, value TEXT, type TEXT, category TEXT, revision INTEGER);`);
  const insert = db.prepare("INSERT INTO categories VALUES (?, ?, NULL, NULL, NULL)");
  for (let i = 14; i >= 0; i -= 1) insert.run(`cat_${String(i).padStart(2, "0")}`, "published");
  insert.run("draft", "draft");
  db.exec("UPDATE categories SET image_url = 'https://photos.test/already.webp' WHERE id = 'cat_00'");
  db.exec("INSERT INTO products VALUES ('product', 'cat_01'); INSERT INTO media VALUES ('photo', 'image', 'media/pool/p001.jpg', 1600); INSERT INTO product_media VALUES ('product', 'photo', 1, 0)");

  const ids = seedHomepageCategories(db, "http://localhost:4603/");
  expect(ids).toEqual(Array.from({ length: 12 }, (_, i) => `cat_${String(i).padStart(2, "0")}`));
  expect(db.prepare("SELECT image_url FROM categories WHERE id = 'cat_00'").get().image_url).toBe("https://photos.test/already.webp");
  expect(db.prepare("SELECT image_url FROM categories WHERE id = 'cat_01'").get().image_url).toBe("http://localhost:4603/media/pool/p001.jpg/1600.webp");
  const config = JSON.parse(db.prepare("SELECT value FROM settings WHERE category = 'homepage' AND key = 'document'").get().value);
  expect(config.categoryRail).toEqual({ enabled: true, title: "Shop by category", categoryIds: ids });
  expect(seedHomepageCategories(db, "http://localhost:4603/")).toEqual(ids);
  expect(db.prepare("SELECT count(*) AS n FROM settings WHERE category = 'homepage'").get().n).toBe(1);
  db.close();
});
