#!/usr/bin/env node
// The 30k-product fidelity store (AUDIT §1 "Data"), built from nothing in a
// state directory the harness owns:
//   1. apply every local D1 migration;
//   2. scripts/catalog-scale-seed.mjs (30,000 products, ~83,700 SKUs, 400
//      categories, 300-value Brand attribute; orders trimmed, they never render);
//   3. the media pool (pool.mjs) in <state>/pool, served by lib/media-server.mjs;
//      every seeded image points at one of 240 pool photos with real
//      renditions, 1% of primaries are legacy originals with no renditions,
//      2% of products have no photo;
//   4. the 400 categories reshaped into a 25/125/125/125 four-level tree with
//      long and Bangla names; the 300 brands as brand entities;
//   5. three video products (video first with a poster, video second, a raw
//      27 MB video with no poster), two hero sliders, the five scale menus;
//   6. the catalogue projections (migration 0091's statements).
// Writes <state>/fidelity-store.json with the page paths the checks measure.
//
//   node scripts/storefront-fidelity/seed-large.mjs --state <new dir> [--api-port 9001 --media-port 4603]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { API_DIR, ROOT, assertOwnedState, childEnv, openDb, origins, tx, wranglerBin } from "./lib/context.mjs";
import { seedMenus } from "./menus.mjs";
import { LEGACY_POOL_INDEXES, POOL_SIZE, generatePool } from "./pool.mjs";

export const STORE_FILE = "fidelity-store.json";
export const POOL_DIR = "pool";
const slugify = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";

export function migrate(stateDir) {
  assertOwnedState(stateDir);
  execFileSync(process.execPath, [wranglerBin(), "d1", "migrations", "apply", "scalius-commerce", "--local", "--persist-to", stateDir, "--config", "wrangler.local.jsonc"], {
    cwd: API_DIR, env: childEnv(), stdio: ["ignore", "ignore", "pipe"],
  });
}

/** Migration 0091's statements: fill product_buyer_state and product_facet_values. */
export function fillProjections(db) {
  const sql = readFileSync(join(ROOT, "packages/database/migrations/0091_catalogue_projection_fill.sql"), "utf8")
    .split("--> statement-breakpoint")
    .filter((s) => !/scalius_schema_migrations/.test(s))
    .join(";\n");
  db.exec(`BEGIN; ${sql}; COMMIT;`);
}

/** Points the local Platform document at this stack's origins (dev-ports.mjs contract). */
export async function syncPlatform(db, ports) {
  const { platformSyncSql } = await import(pathToFileURL(join(ROOT, "scripts/dev-ports.mjs")).href);
  db.prepare(platformSyncSql(origins(ports))).all();
}

function shapeStore(stateDir, pool, ports, log) {
  const db = openDb(stateDir);
  const q = (sql, ...a) => db.prepare(sql).all(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const now = Math.floor(Date.now() / 1000);

  // Media: 240 shared pool rows (object keys are unique) and 3 legacy rows with
  // no renditions; every seeded product image is repointed at one of them.
  let legacy = 0;
  const guard = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'product_media_identity_update_guard'").get()?.sql;
  tx(db, () => {
    const ins = db.prepare("INSERT OR REPLACE INTO media (id, filename, kind, object_key, size, mime_type, alt_text, width, height, variant_width, status, created_at, updated_at) VALUES (?, ?, 'image', ?, ?, 'image/jpeg', NULL, ?, ?, ?, 'ready', ?, ?)");
    pool.products.forEach((p, i) => ins.run(`med_pool_${String(i).padStart(3, "0")}`, p.key, `media/pool/${p.key}`, p.size, p.w, p.h, p.master, now, now));
    LEGACY_POOL_INDEXES.forEach((poolIndex, i) => {
      const p = pool.products[poolIndex];
      ins.run(`med_legacy_${i}`, p.key, `media/legacy/${p.key}`, p.size, p.w, p.h, null, now, now);
    });
    if (guard) db.exec("DROP TRIGGER product_media_identity_update_guard");
    const up = db.prepare("UPDATE product_media SET media_id = ? WHERE id = ?");
    for (const r of q("SELECT id, media_id FROM product_media WHERE media_id LIKE 'med_scale_%'")) {
      const index = Number(r.media_id.slice(10, 16));
      const m = Number(r.media_id.slice(17));
      let target = `med_pool_${String((index * 7 + m * 61) % POOL_SIZE).padStart(3, "0")}`;
      if (m === 0 && index % 100 === 11) {
        target = `med_legacy_${legacy % LEGACY_POOL_INDEXES.length}`;
        legacy += 1;
      }
      up.run(target, r.id);
    }
    if (guard) db.exec(guard);
    db.exec("DELETE FROM media WHERE id LIKE 'med_scale_%' AND NOT EXISTS (SELECT 1 FROM product_media pm WHERE pm.media_id = media.id)");
  });
  log(`  media: pool photos on every seeded image, ${legacy} legacy primaries`);

  // Category tree: 25 roots x 5 children, each child with a 2-deep chain.
  const cats = q("SELECT id, name FROM categories WHERE id LIKE 'cat_scale_%' ORDER BY id");
  if (cats.length !== 400) throw new Error(`expected 400 scale categories, got ${cats.length}`);
  tx(db, () => {
    for (let f = 0; f < 25; f += 1) {
      const block = cats.slice(f * 16, f * 16 + 16);
      for (let k = 0; k < 5; k += 1) {
        run("UPDATE categories SET parent_id = ?, revision = revision + 1 WHERE id = ?", block[0].id, block[1 + k * 3].id);
        run("UPDATE categories SET parent_id = ?, revision = revision + 1 WHERE id = ?", block[1 + k * 3].id, block[2 + k * 3].id);
        run("UPDATE categories SET parent_id = ?, revision = revision + 1 WHERE id = ?", block[2 + k * 3].id, block[3 + k * 3].id);
      }
    }
    const renames = {
      Laptop: "Laptop & Notebook",
      "Phone Case": "মোবাইল কভার ও স্ক্রিন প্রোটেক্টর",
      Television: "টেলিভিশন ও হোম থিয়েটার সিস্টেম",
      "Power Bank": "Desk & Mobile Tech Accessories",
      "Air Conditioner": "Air Conditioner, Air Cooler & Ceiling Fan (Inverter / Non-Inverter)",
      Refrigerator: "ফ্রিজ ও ফ্রিজার",
      "Smart Watch": "Smart Watch & Fitness Band",
      "Graphics Card": "Graphics Card (GPU)",
    };
    for (const [from, to] of Object.entries(renames)) run("UPDATE categories SET name = ? WHERE id LIKE 'cat_scale_%' AND name = ?", to, from);
  });
  const depth = q("SELECT max(c.depth) AS d, count(*) AS n FROM category_closure c");
  log(`  categories: 4-level tree (closure rows ${depth[0].n}, max depth ${depth[0].d})`);

  // Brand entities from the Brand attribute.
  tx(db, () => {
    const names = q("SELECT DISTINCT value FROM product_attribute_values WHERE attribute_id = 'attr_scale_brand' ORDER BY value").map((r) => r.value);
    names.forEach((name, i) => run("INSERT OR IGNORE INTO brands (id, name, slug, status, sort_order, created_at, updated_at) VALUES (?, ?, ?, 'published', ?, ?, ?)", `brd_fid_${String(i).padStart(4, "0")}`, name, `${slugify(name)}-${i}`, i, now, now));
    db.exec("UPDATE products SET brand_id = (SELECT b.id FROM product_attribute_values v JOIN brands b ON b.name = v.value WHERE v.product_id = products.id AND v.attribute_id = 'attr_scale_brand' LIMIT 1) WHERE id LIKE 'prod_scale_%'");
    // 2% of products have no photo.
    db.exec("UPDATE product_variants SET image_id = NULL WHERE image_id IN (SELECT id FROM product_media WHERE product_id IN (SELECT id FROM products WHERE id LIKE 'prod_scale_%' AND CAST(substr(id, 12) AS INTEGER) % 50 = 3))");
    db.exec("DELETE FROM product_media WHERE product_id IN (SELECT id FROM products WHERE id LIKE 'prod_scale_%' AND CAST(substr(id, 12) AS INTEGER) % 50 = 3)");
  });
  log(`  brands: ${q("SELECT count(*) AS n FROM brands")[0].n}`);

  fillProjections(db);

  // Video products: the three newest public products.
  const video = {};
  const v1 = join(pool.dir, "video1.mp4");
  const v2 = join(pool.dir, "video2-noposter-big.mp4");
  if (existsSync(v1) && existsSync(v2)) {
    const poster = pool.heroes.find((h) => h.key === "v000.jpg");
    const [a, b, c] = q("SELECT p.id, p.slug FROM products p JOIN product_buyer_state s ON s.product_id = p.id WHERE p.id LIKE 'prod_scale_%' AND s.is_public = 1 ORDER BY p.created_at DESC, p.id LIMIT 3");
    tx(db, () => {
      run("INSERT OR REPLACE INTO media (id, filename, kind, object_key, size, mime_type, width, height, variant_width, status, created_at, updated_at) VALUES ('med_fid_poster', 'poster.jpg', 'image', 'media/pool/v000.jpg', ?, 'image/jpeg', 1280, 720, 1280, 'ready', ?, ?)", poster.size, now, now);
      run("INSERT OR REPLACE INTO media (id, filename, kind, object_key, size, mime_type, width, height, duration_ms, poster_media_id, status, created_at, updated_at) VALUES ('med_fid_video1', 'demo.mp4', 'video', 'media/pool/video1.mp4', ?, 'video/mp4', 1280, 720, 20000, 'med_fid_poster', 'ready', ?, ?)", statSync(v1).size, now, now);
      run("INSERT OR REPLACE INTO media (id, filename, kind, object_key, size, mime_type, width, height, duration_ms, status, created_at, updated_at) VALUES ('med_fid_video2', 'raw-upload.mp4', 'video', 'media/pool/video2-noposter-big.mp4', ?, 'video/mp4', 1080, 1350, 30000, 'ready', ?, ?)", statSync(v2).size, now, now);
      run("UPDATE product_media SET is_primary = 0, sort_order = sort_order + 10 WHERE product_id = ?", a.id);
      run("INSERT INTO product_media (id, product_id, media_id, is_primary, sort_order, created_at, updated_at) VALUES ('pmed_fid_va', ?, 'med_fid_video1', 1, 0, ?, ?)", a.id, now, now);
      run("UPDATE product_media SET sort_order = sort_order + 10 WHERE product_id = ? AND sort_order > 0", b.id);
      run("INSERT INTO product_media (id, product_id, media_id, is_primary, sort_order, created_at, updated_at) VALUES ('pmed_fid_vb', ?, 'med_fid_video1', 0, 1, ?, ?)", b.id, now, now);
      run("UPDATE product_variants SET image_id = NULL WHERE product_id = ?", c.id);
      run("DELETE FROM product_media WHERE product_id = ?", c.id);
      run("INSERT INTO product_media (id, product_id, media_id, is_primary, sort_order, created_at, updated_at) VALUES ('pmed_fid_vc', ?, 'med_fid_video2', 1, 0, ?, ?)", c.id, now, now);
    });
    Object.assign(video, { pdpvideo: `/products/${a.slug}`, pdpvideo2nd: `/products/${b.slug}`, pdprawvideo: `/products/${c.slug}` });
  }

  // Hero sliders (desktop: three wide banners; mobile: two squares).
  const media = origins(ports).mediaUrl;
  tx(db, () => {
    for (const h of pool.heroes.filter((m) => m.key.startsWith("h"))) {
      run("INSERT OR REPLACE INTO media (id, filename, kind, object_key, size, mime_type, width, height, variant_width, status, created_at, updated_at) VALUES (?, ?, 'image', ?, ?, 'image/jpeg', ?, ?, ?, 'ready', ?, ?)", `med_fid_${h.key.slice(0, 4)}`, h.key, `media/pool/${h.key}`, h.size, h.w, h.h, h.master, now, now);
    }
    const url = (h) => `${media}/media/pool/${h.key}/${h.master}.webp`;
    const heroes = pool.heroes.filter((m) => m.key.startsWith("h"));
    const d = heroes.filter((m) => m.w > m.h).map((h, i) => ({ id: `s${i}`, url: url(h), title: `Mega sale banner ${i + 1}`, heading: "", buttonLabel: "", link: "/search?q=laptop", focalPoint: { x: 50, y: 50 } }));
    const m = heroes.filter((x) => x.w === x.h).map((h, i) => ({ id: `m${i}`, url: url(h), title: `Mobile banner ${i + 1}`, heading: "", buttonLabel: "", link: "/search?q=phone", focalPoint: { x: 50, y: 50 } }));
    db.exec("DELETE FROM hero_sliders");
    run("INSERT INTO hero_sliders (id, type, images, is_active, created_at, updated_at) VALUES ('slider_fid_d', 'desktop', ?, 1, ?, ?)", JSON.stringify(d), now, now);
    run("INSERT INTO hero_sliders (id, type, images, is_active, created_at, updated_at) VALUES ('slider_fid_m', 'mobile', ?, 1, ?, ?)", JSON.stringify(m), now, now);
  });

  fillProjections(db);
  // Units sold in the last 30 days, as the nightly refresh computes them
  // (core catalog refreshProductSalesStats), so cards can show real "sold" facts.
  db.exec(`DELETE FROM product_sales_stats;
    INSERT INTO product_sales_stats (product_id, sold_30d, computed_at)
    SELECT line.product_id, SUM(line.quantity), unixepoch()
    FROM orders o JOIN order_items line ON line.order_id = o.id
    WHERE o.status IN ('pending', 'processing', 'confirmed', 'shipped', 'delivered', 'completed')
      AND o.deleted_at IS NULL AND o.created_at >= unixepoch() - ${30 * 86_400} AND line.quantity > 0
      AND EXISTS (SELECT 1 FROM products p WHERE p.id = line.product_id)
    GROUP BY line.product_id;`);
  // Two delivery rates, as every Bangladeshi store has: cards read the cheapest.
  db.exec(`INSERT OR REPLACE INTO shipping_methods (id, name, is_active, sort_order, fee_minor, kind) VALUES
    ('ship_fid_dhaka', 'Inside Dhaka', 1, 0, 6000, 'delivery'), ('ship_fid_outside', 'Outside Dhaka', 1, 1, 12000, 'delivery');`);
  // The scale seed's 1,500 orders over two years give no product ten sales
  // in 30 days, so the "sold" fact would never render. One discounted public
  // product in seven with a colour axis gets a deterministic 30-day count
  // (10 to 1,209) in this projection: test data for the card facts, never
  // shown outside the harness store.
  db.exec(`INSERT OR REPLACE INTO product_sales_stats (product_id, sold_30d, computed_at)
    SELECT s.product_id, 10 + (CAST(substr(s.product_id, 12) AS INTEGER) * 37) % 1200, unixepoch()
    FROM product_buyer_state s
    WHERE s.is_public = 1 AND s.has_discount = 1 AND s.product_id LIKE 'prod_scale_%'
      AND CAST(substr(s.product_id, 12) AS INTEGER) % 7 = 0
      AND EXISTS (SELECT 1 FROM product_option_definitions axis WHERE axis.product_id = s.product_id
        AND axis.deleted_at IS NULL AND (axis.standard_mapping = 'color' OR axis.normalized_name IN ('color', 'colour')));`);
  log(`  sales stats: ${q("SELECT count(*) AS n FROM product_sales_stats WHERE sold_30d >= 10")[0].n} products with 10+ sold in 30 days`);
  const pages = resolvePages(db, video);
  db.close();
  return pages;
}

/**
 * The audit's page set. Prefers the audit's exact slugs (the seed is
 * deterministic), falling back to an equivalent product when a slug moved.
 */
export function resolvePages(db, extra = {}) {
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const slugOr = (slug, fallbackSql) => (one("SELECT slug FROM products WHERE slug = ?", slug) ?? one(fallbackSql))?.slug;
  const catOr = (slug, fallbackSql) => (one("SELECT slug FROM categories WHERE slug = ?", slug) ?? one(fallbackSql))?.slug;
  const plp = catOr("laptop-0", "SELECT slug FROM categories WHERE parent_id IS NULL AND id LIKE 'cat_scale_%' ORDER BY id LIMIT 1");
  const leaf = catOr("audio-technica-2-in-1-laptop-3", "SELECT c.slug FROM categories c JOIN product_buyer_state s ON s.category_id = c.id AND s.is_public = 1 WHERE c.parent_id IS NOT NULL GROUP BY c.id HAVING count(*) BETWEEN 10 AND 60 ORDER BY c.id LIMIT 1");
  const pdp = slugOr("lenovo-max-note-e308s-phone-case-10593", "SELECT p.slug FROM products p JOIN product_buyer_state s ON s.product_id = p.id AND s.is_public = 1 WHERE (SELECT count(*) FROM product_variants v WHERE v.product_id = p.id) BETWEEN 4 AND 12 AND (SELECT count(*) FROM product_media m WHERE m.product_id = p.id) = 4 ORDER BY p.id LIMIT 1");
  const pdp100 = slugOr("a4tech-pro-tune-l182z-leather-phone-case-29330", "SELECT p.slug FROM products p JOIN product_buyer_state s ON s.product_id = p.id AND s.is_public = 1 ORDER BY (SELECT count(*) FROM product_variants v WHERE v.product_id = p.id) DESC LIMIT 1");
  const pdplegacy = slugOr("dell-flip-b838z-silicone-phone-case-11", "SELECT p.slug FROM products p JOIN product_buyer_state s ON s.product_id = p.id AND s.is_public = 1 JOIN product_media pm ON pm.product_id = p.id AND pm.is_primary = 1 JOIN media m ON m.id = pm.media_id AND m.variant_width IS NULL WHERE m.kind = 'image' ORDER BY p.id LIMIT 1");
  const out = {
    home: "/",
    plp: `/categories/${plp}`,
    leaf: `/categories/${leaf}`,
    search: "/search?q=laptop",
    pdp: `/products/${pdp}`,
    pdp100: `/products/${pdp100}`,
    pdplegacy: `/products/${pdplegacy}`,
    ...extra,
  };
  return out;
}

export async function seedLarge({ stateDir, ports, log = console.log }) {
  assertOwnedState(stateDir);
  mkdirSync(stateDir, { recursive: true });
  const t0 = Date.now();
  const step = (m) => log(`[seed ${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
  step("migrations");
  migrate(stateDir);
  step("catalog-scale-seed (30k products)");
  execFileSync(process.execPath, [join(ROOT, "scripts/catalog-scale-seed.mjs"), "--state", stateDir, "--customers", "500", "--orders", "1500"], { stdio: ["ignore", "ignore", "pipe"], env: childEnv() });
  step("media pool");
  const poolDir = join(stateDir, POOL_DIR);
  const pool = await generatePool(poolDir, { log });
  pool.dir = poolDir;
  step("store shape");
  const pages = shapeStore(stateDir, pool, ports, log);
  step("menus");
  seedMenus(stateDir, { log });
  const db = openDb(stateDir);
  await syncPlatform(db, ports);
  const counts = Object.fromEntries(["products", "product_variants", "categories", "brands", "media"].map((t) => [t, db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n]));
  counts.publicProducts = db.prepare("SELECT count(*) AS n FROM product_buyer_state WHERE is_public = 1").get().n;
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  db.close();
  const store = { builtAt: new Date().toISOString(), ports, pages, counts };
  writeFileSync(join(stateDir, STORE_FILE), JSON.stringify(store, null, 2));
  step(`done: ${JSON.stringify(counts)}`);
  return store;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
  const stateDir = arg("--state");
  if (!stateDir) {
    console.error("Usage: node scripts/storefront-fidelity/seed-large.mjs --state <new dir> [--api-port 9001 --storefront-port 4601 --admin-port 4602 --media-port 4603]");
    process.exit(1);
  }
  const ports = { api: Number(arg("--api-port", 9001)), storefront: Number(arg("--storefront-port", 4601)), admin: Number(arg("--admin-port", 4602)), media: Number(arg("--media-port", 4603)) };
  await seedLarge({ stateDir, ports });
}
