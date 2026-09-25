#!/usr/bin/env node
// The small-catalogue pass (AUDIT §3.3): the 30k store cut down to 20 active
// products in two leaf categories (14 + 6), with the 20-link menu. Toggles
// products.is_active (backed up in fid_active_backup) and refills the
// catalogue projections; `--restore` puts the large store back.
//
//   node scripts/storefront-fidelity/seed-tiny.mjs --state <dir> [--restore]
import { pathToFileURL } from "node:url";
import { openDb, tx } from "./lib/context.mjs";
import { MENUS, setHeaderMenu } from "./menus.mjs";
import { fillProjections } from "./seed-large.mjs";

const PREFERRED = [["audio-technica-2-in-1-laptop-3", 14], ["amd-wireless-monitor-38", 6]];

function leafWith(db, slug, n, exclude) {
  const bySlug = db.prepare("SELECT c.id, c.slug FROM categories c WHERE c.slug = ? AND (SELECT count(*) FROM product_buyer_state s WHERE s.category_id = c.id AND s.is_public = 1) >= ?").get(slug, n);
  if (bySlug && bySlug.id !== exclude) return bySlug;
  return db.prepare("SELECT c.id, c.slug FROM categories c JOIN product_buyer_state s ON s.category_id = c.id AND s.is_public = 1 WHERE c.id <> ? AND NOT EXISTS (SELECT 1 FROM categories k WHERE k.parent_id = c.id) GROUP BY c.id HAVING count(*) >= ? ORDER BY c.id LIMIT 1").get(exclude ?? "", n);
}

/** Leaves exactly 20 products active; returns the two leaf paths. */
export function applyTiny(db) {
  const a = leafWith(db, PREFERRED[0][0], PREFERRED[0][1], null);
  const b = leafWith(db, PREFERRED[1][0], PREFERRED[1][1], a?.id);
  if (!a || !b) throw new Error("no leaf categories with enough public products for the small-catalogue pass");
  const pick = (id, n) => db.prepare("SELECT p.id FROM products p JOIN product_buyer_state s ON s.product_id = p.id AND s.is_public = 1 WHERE p.category_id = ? ORDER BY p.id LIMIT ?").all(id, n).map((r) => r.id);
  const keep = [...pick(a.id, 14), ...pick(b.id, 6)];
  tx(db, () => {
    db.exec("CREATE TABLE IF NOT EXISTS fid_active_backup AS SELECT id, is_active FROM products");
    db.exec("CREATE TEMP TABLE IF NOT EXISTS fid_keep (id TEXT PRIMARY KEY)");
    db.exec("DELETE FROM fid_keep");
    const ins = db.prepare("INSERT INTO fid_keep (id) VALUES (?)");
    for (const id of keep) ins.run(id);
    db.exec("UPDATE products SET is_active = 0 WHERE id NOT IN (SELECT id FROM fid_keep) AND is_active = 1");
    setHeaderMenu(db, MENUS["20"]);
  });
  fillProjections(db);
  const active = db.prepare("SELECT count(*) AS n FROM product_buyer_state WHERE is_public = 1").get().n;
  return { active, leaf14: `/categories/${a.slug}`, leaf6: `/categories/${b.slug}`, pdp: `/products/${db.prepare("SELECT slug FROM products WHERE id = ?").get(keep[0]).slug}` };
}

export function restoreLarge(db) {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'fid_active_backup'").get();
  if (!has) return false;
  tx(db, () => {
    db.exec("UPDATE products SET is_active = (SELECT b.is_active FROM fid_active_backup b WHERE b.id = products.id)");
    db.exec("DROP TABLE fid_active_backup");
    setHeaderMenu(db, MENUS["150"]);
  });
  fillProjections(db);
  return true;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const i = process.argv.indexOf("--state");
  if (i < 0) {
    console.error("Usage: node scripts/storefront-fidelity/seed-tiny.mjs --state <dir> [--restore]");
    process.exit(1);
  }
  const db = openDb(process.argv[i + 1]);
  console.log(process.argv.includes("--restore") ? { restored: restoreLarge(db) } : applyTiny(db));
  db.close();
}
