import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listMediaFiles,
  MediaDependencyConflictError,
  permanentlyDeleteMediaFile,
  restoreMediaFile,
  trashMediaFile,
} from "./media.service";
import { countMediaUsage, loadMediaUsage } from "./media.usage";
import { saveFooterConfig, saveHeaderConfig, saveSeoSettings } from "../settings/site-settings.service";
import { saveBusinessSettings } from "../settings/business-settings.service";

const BASE = "https://media.example";

function bucket() {
  const deleted: string[] = [];
  return {
    deleted,
    bucket: {
      head: async () => ({}),
      delete: async (keys: string | string[]) => { deleted.push(...[keys].flat()); },
    } as unknown as R2Bucket,
  };
}

describe("media usage", () => {
  let db: Database;
  let sqlite: DatabaseSync;

  beforeEach(() => {
    ({ db, sqlite } = createSqliteD1Database());
  });
  afterEach(() => sqlite.close());

  function seedMedia(id: string, kind: "image" | "video" = "image") {
    sqlite.prepare(`INSERT INTO media (id, filename, kind, object_key, size, mime_type, status)
      VALUES (?, ?, ?, ?, 12, ?, 'ready')`).run(
      id,
      `${id}.${kind === "image" ? "png" : "mp4"}`,
      kind,
      `media/${id}.${kind === "image" ? "png" : "mp4"}`,
      kind === "image" ? "image/png" : "video/mp4",
    );
    return `${BASE}/media/${id}.png`;
  }

  it("counts every place that shows a file, once per place", async () => {
    const photo = seedMedia("media_photo");
    const logo = seedMedia("media_logo");
    const social = seedMedia("media_social");
    seedMedia("media_unused");
    seedMedia("media_video", "video");
    sqlite.exec(`
      INSERT INTO products (id, name, price_minor, slug, description) VALUES
        ('prod_a', 'Panjabi', 1000, 'panjabi', '<p><img src="${photo}/320.webp"></p>'),
        ('prod_b', 'Kurti', 1000, 'kurti', NULL);
      UPDATE products SET deleted_at = unixepoch() WHERE id = 'prod_b';
      INSERT INTO product_media (id, product_id, media_id, is_primary, sort_order) VALUES
        ('pmed_prod_a', 'prod_a', 'media_photo', 1, 0),
        ('pmed_prod_b', 'prod_b', 'media_photo', 1, 0);
      INSERT INTO categories (id, name, slug, image_url, status) VALUES ('cat_a', 'Men', 'men', '${photo}', 'published');
      INSERT INTO collections (id, name, content, presentation, config)
        VALUES ('col_a', 'Eid picks', '<img src="${photo}">', 'grid', '{}');
      INSERT INTO pages (id, title, slug, content, content_type) VALUES
        ('page_a', 'About', 'about', '<img src="${photo}">', 'page'),
        ('post_a', 'Eid guide', 'eid-guide', '<p>No images</p>', 'article');
      INSERT INTO hero_sliders (id, type, images) VALUES ('hero_a', 'desktop', '[{"url":"${photo}"}]');
      UPDATE media SET poster_media_id = 'media_photo' WHERE id = 'media_video';
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, total_amount_minor, shipping_amount_minor)
        VALUES ('order_1', 'Buyer', '+8801700000001', 'Address', 'city', 'zone', 1000, 0);
      INSERT INTO order_items (id, order_id, product_id, quantity, unit_price_minor, product_image_media_id)
        VALUES ('item_1', 'order_1', 'prod_a', 1, 1000, 'media_photo');
    `);
    await saveHeaderConfig(db, { logo: { src: logo, alt: "Logo" }, social: [{ icon: photo }] }, 0);
    await saveFooterConfig(db, { logo: { src: logo, alt: "Logo" } }, 0);
    await saveSeoSettings(db, { socialImage: social });
    await saveBusinessSettings(db, { invoiceLogoUrl: logo });

    const counts = await countMediaUsage(db, ["media_photo", "media_logo", "media_social", "media_unused"]);
    // Panjabi (photo + description), Kurti (in trash), Men, Eid picks, About,
    // banners, navigation (header social link) and the video's cover.
    expect(counts.get("media_photo")).toEqual({ usageCount: 8, keptForOrders: true });
    // Header and footer logos are one "theme" place; the invoice is another.
    expect(counts.get("media_logo")).toEqual({ usageCount: 2, keptForOrders: false });
    expect(counts.get("media_social")).toEqual({ usageCount: 1, keptForOrders: false });
    expect(counts.get("media_unused")).toEqual({ usageCount: 0, keptForOrders: false });

    const usage = await loadMediaUsage(db, "media_photo");
    expect(usage.count).toBe(8);
    expect(usage.orderCount).toBe(1);
    expect(usage.references).toEqual([
      { kind: "product", id: "prod_b", name: "Kurti", trashed: true },
      { kind: "product", id: "prod_a", name: "Panjabi", trashed: false },
      { kind: "category", id: "cat_a", name: "Men", trashed: false },
      { kind: "collection", id: "col_a", name: "Eid picks", trashed: false },
      { kind: "page", id: "page_a", name: "About", trashed: false },
      { kind: "banner", id: null, name: null, trashed: false },
      { kind: "navigation", id: null, name: null, trashed: false },
      { kind: "video_cover", id: "media_video", name: "media_video.mp4", trashed: false },
    ]);
    expect((await loadMediaUsage(db, "media_social")).references).toEqual([
      { kind: "social_image", id: null, name: null, trashed: false },
    ]);
  });

  it("returns the count with each file of a Files page", async () => {
    seedMedia("media_one");
    seedMedia("media_two");
    sqlite.exec(`
      INSERT INTO products (id, name, price_minor, slug) VALUES ('prod_a', 'Panjabi', 1000, 'panjabi');
      INSERT INTO product_media (id, product_id, media_id, is_primary, sort_order) VALUES ('pmed_prod_a', 'prod_a', 'media_one', 1, 0);
    `);
    const { files } = await listMediaFiles(db, { sortBy: "filename", sortOrder: "asc" });
    expect(files.map(({ id, usageCount, keptForOrders }) => ({ id, usageCount, keptForOrders }))).toEqual([
      { id: "media_one", usageCount: 1, keptForOrders: false },
      { id: "media_two", usageCount: 0, keptForOrders: false },
    ]);
  });

  it("keeps a used file through trash, restores it, and refuses permanent delete until it is unused", async () => {
    const photo = seedMedia("media_desc");
    sqlite.exec(`
      INSERT INTO products (id, name, price_minor, slug, description)
        VALUES ('prod_a', 'Panjabi', 1000, 'panjabi', '<img src="${photo}">');
    `);
    const storage = bucket();
    const trashed = await trashMediaFile(db, "media_desc", 1);
    const restored = await restoreMediaFile(db, "media_desc", trashed.version);
    expect(restored.status).toBe("ready");
    const again = await trashMediaFile(db, "media_desc", restored.version);

    const error = await permanentlyDeleteMediaFile(db, "media_desc", again.version, storage.bucket).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MediaDependencyConflictError);
    expect((error as MediaDependencyConflictError).status).toBe(409);
    expect((error as MediaDependencyConflictError).details).toMatchObject({
      count: 1,
      references: [{ kind: "product", id: "prod_a", name: "Panjabi" }],
    });
    expect(storage.deleted).toEqual([]);

    sqlite.exec(`UPDATE products SET description = '<p>Plain</p>' WHERE id = 'prod_a'`);
    await permanentlyDeleteMediaFile(db, "media_desc", again.version, storage.bucket);
    expect(storage.deleted).toContain("media/media_desc.png");
    expect(sqlite.prepare("SELECT status FROM media WHERE id = 'media_desc'").get()).toEqual({ status: "deleted" });
  });

  it("refuses permanent delete while the file is the store's social sharing image", async () => {
    const social = seedMedia("media_share");
    await saveSeoSettings(db, { socialImage: social });
    const trashed = await trashMediaFile(db, "media_share", 1);
    await expect(permanentlyDeleteMediaFile(db, "media_share", trashed.version, bucket().bucket))
      .rejects.toBeInstanceOf(MediaDependencyConflictError);
  });

  it("lists a brand logo as a place and refuses permanent delete while a brand uses it", async () => {
    seedMedia("media_brand");
    sqlite.exec(`
      INSERT INTO brands (id, name, slug, logo_media_id, status) VALUES
        ('brd_walton01', 'Walton', 'walton', 'media_brand', 'published'),
        ('brd_old00001', 'Old', 'old', 'media_brand', 'draft');
      UPDATE brands SET deleted_at = unixepoch() WHERE id = 'brd_old00001';
    `);

    expect((await countMediaUsage(db, ["media_brand"])).get("media_brand")).toEqual({ usageCount: 2, keptForOrders: false });
    expect((await loadMediaUsage(db, "media_brand")).references).toEqual([
      { kind: "brand", id: "brd_old00001", name: "Old", trashed: true },
      { kind: "brand", id: "brd_walton01", name: "Walton", trashed: false },
    ]);

    const trashed = await trashMediaFile(db, "media_brand", 1);
    await expect(permanentlyDeleteMediaFile(db, "media_brand", trashed.version, bucket().bucket))
      .rejects.toBeInstanceOf(MediaDependencyConflictError);
    sqlite.exec("DELETE FROM brands");
    await permanentlyDeleteMediaFile(db, "media_brand", trashed.version, bucket().bucket);
    expect(sqlite.prepare("SELECT status FROM media WHERE id = 'media_brand'").get()).toEqual({ status: "deleted" });
  });

  it("rechecks usage inside the delete claim when a reference lands after the preflight", async () => {
    const photo = seedMedia("media_race");
    sqlite.exec(`INSERT INTO collections (id, name, content, presentation, config) VALUES ('col_a', 'Eid', '', 'grid', '{}')`);
    const trashed = await trashMediaFile(db, "media_race", 1);
    let raced = false;
    const racedDb = createSqliteD1Database({
      sqlite,
      onQuery: (query, values) => {
        if (raced || !/^update "media"/i.test(query) || !values.includes("deleting")) return;
        raced = true;
        sqlite.prepare("UPDATE collections SET content = ? WHERE id = 'col_a'").run(`<img src="${photo}">`);
      },
    }).db;
    const storage = bucket();
    const result = await permanentlyDeleteMediaFile(racedDb, "media_race", trashed.version, storage.bucket).catch((caught: unknown) => caught);
    expect(sqlite.prepare("SELECT status FROM media WHERE id = 'media_race'").get()).toEqual({ status: "trashed" });
    expect(storage.deleted).toEqual([]);
    expect(raced).toBe(true);
    expect(result).toBeInstanceOf(MediaDependencyConflictError);
  });
});
