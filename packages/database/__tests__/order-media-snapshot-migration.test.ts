import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(import.meta.dirname, "../migrations/0019_loose_living_mummy.sql"),
  "utf8",
);

const oldSchema = `
PRAGMA foreign_keys = ON;
CREATE TABLE media (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE order_items (
  id TEXT PRIMARY KEY NOT NULL,
  quantity INTEGER NOT NULL
);
INSERT INTO media VALUES
  ('med_ready_image', 'image', 'ready'),
  ('med_trashed_image', 'image', 'trashed'),
  ('med_ready_video', 'video', 'ready'),
  ('med_deleting_image', 'image', 'deleting');
`;

function runSql(sql: string, bail: "on" | "off" = "on") {
  return spawnSync("sqlite3", [":memory:"], {
    input: `.bail ${bail}\n${oldSchema}\n${migration}\n${sql}`,
    encoding: "utf8",
  });
}

describe("order image snapshot migration", () => {
  it("uses remote-D1-safe triggers and accepts retained image snapshots", () => {
    expect(migration).not.toContain("SELECT CASE WHEN");
    expect(migration).toContain("order_items_product_image_media_insert_guard");
    expect(migration).toContain("order_items_product_image_media_update_guard");

    const result = runSql(`
      INSERT INTO order_items (id, quantity, product_image_media_id)
        VALUES ('item_ready', 1, 'med_ready_image');
      INSERT INTO order_items (id, quantity, product_image_media_id)
        VALUES ('item_trashed', 1, 'med_trashed_image');
      INSERT INTO order_items (id, quantity, product_image_media_id)
        VALUES ('item_none', 1, NULL);
      SELECT id, coalesce(product_image_media_id, 'none')
      FROM order_items ORDER BY id;
    `);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "item_none|none",
      "item_ready|med_ready_image",
      "item_trashed|med_trashed_image",
    ]);
  });

  it("rejects videos, deleting assets, missing assets, and snapshot reassignment", () => {
    const result = runSql(`
      INSERT INTO order_items (id, quantity, product_image_media_id)
        VALUES ('item_video', 1, 'med_ready_video');
      INSERT INTO order_items (id, quantity, product_image_media_id)
        VALUES ('item_deleting', 1, 'med_deleting_image');
      INSERT INTO order_items (id, quantity, product_image_media_id)
        VALUES ('item_missing', 1, 'med_missing');
      INSERT INTO order_items (id, quantity, product_image_media_id)
        VALUES ('item_valid', 1, 'med_ready_image');
      UPDATE order_items SET quantity = 2 WHERE id = 'item_valid';
      UPDATE order_items
      SET product_image_media_id = 'med_trashed_image'
      WHERE id = 'item_valid';
      UPDATE order_items
      SET product_image_media_id = NULL
      WHERE id = 'item_valid';
      SELECT id, product_image_media_id, quantity FROM order_items ORDER BY id;
    `, "off");

    expect(result.status).toBe(1);
    expect(
      result.stderr.match(/order item image snapshot must reference a retained image/gu)?.length,
    ).toBe(3);
    expect(result.stderr.match(/IMMUTABLE_ORDER_ITEM_IMAGE_SNAPSHOT/gu)?.length).toBe(2);
    expect(result.stdout.trim()).toBe("item_valid|med_ready_image|2");
  });

  it("keeps the historical media row retained while an order item references it", () => {
    const result = runSql(`
      INSERT INTO order_items (id, quantity, product_image_media_id)
        VALUES ('item_valid', 1, 'med_ready_image');
      DELETE FROM media WHERE id = 'med_ready_image';
    `, "off");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("FOREIGN KEY constraint failed");
  });
});
