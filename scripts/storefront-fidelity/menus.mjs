#!/usr/bin/env node
// The five scale menus of the fidelity audit (§1), published straight into a
// local state the harness owns (no Worker may be writing it):
//   fid-20    20 links: 8 departments, 12 children
//   fid-150   150 links, 2 levels (25 roots x 5 children)
//   fid-mega  136 links, 3 levels (8 roots x 4 groups x 3 links + group)
//   fid-1k    1,150 links, 3 levels, published directly as a re-publish allows
//   fid-live  the live store's flat 12-item menu (duplicate "Footwear", junk
//             collection names, a system "Track your order" link)
//
//   node scripts/storefront-fidelity/menus.mjs --state <dir>
import { pathToFileURL } from "node:url";
import { openDb, tx } from "./lib/context.mjs";

export const MENUS = Object.freeze({ "20": "menu_fid_20", "150": "menu_fid_150", mega: "menu_fid_mega", "1k": "menu_fid_1k", live: "menu_fid_live" });

function publishMenu(db, id, name, handle, items, now) {
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  run("DELETE FROM navigation_menu_publication_items WHERE menu_id = ?", id);
  run("DELETE FROM navigation_menu_publications WHERE menu_id = ?", id);
  run("DELETE FROM navigation_menu_items WHERE menu_id = ?", id);
  run("DELETE FROM navigation_placements WHERE menu_id = ?", id);
  run("DELETE FROM navigation_menus WHERE id = ?", id);
  run("INSERT INTO navigation_menus (id, name, handle, revision, published_revision, dependency_revision, created_at, updated_at) VALUES (?, ?, ?, 2, 2, 1, ?, ?)", id, name, handle, now, now);
  run("INSERT INTO navigation_menu_publications (menu_id, revision, published_at, item_count, checksum) VALUES (?, 2, ?, ?, 'fidelity')", id, now, items.length);
  const pos = new Map();
  for (const it of items) {
    const key = it.parent ?? "";
    const p = pos.get(key) ?? 0;
    pos.set(key, p + 1);
    const [tt, tid, tval] = it.type === "system" ? ["system", null, it.target] : ["category", it.target, null];
    run("INSERT INTO navigation_menu_items (id, menu_id, parent_id, position, label, label_mode, target_type, target_id, target_value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'custom', ?, ?, ?, ?, ?)", it.id, id, it.parent ?? null, p, it.label, tt, tid, tval, now, now);
    run("INSERT INTO navigation_menu_publication_items (menu_id, revision, item_id, parent_id, position, label, label_mode, target_type, target_id, target_value, target_query, open_in_new_tab, is_enabled) VALUES (?, 2, ?, ?, ?, ?, 'custom', ?, ?, ?, NULL, 0, 1)", id, it.id, it.parent ?? null, p, it.label, tt, tid, tval);
  }
  return items.length;
}

/** Publishes all five menus and points the header at fid-150, the footer at fid-20 + fid-live. */
export function seedMenus(stateDir, { log = console.log } = {}) {
  const db = openDb(stateDir);
  const now = Math.floor(Date.now() / 1000);
  const q = (sql, ...a) => db.prepare(sql).all(...a);
  const cats = q("SELECT id, name FROM categories WHERE id LIKE 'cat_scale_%' ORDER BY id");
  const roots = q("SELECT id, name FROM categories WHERE id LIKE 'cat_scale_%' AND parent_id IS NULL ORDER BY id");
  if (roots.length < 10) throw new Error(`expected the 25-root category tree, found ${roots.length} roots (run seed-large first)`);
  const kids = (id) => q("SELECT id, name FROM categories WHERE parent_id = ? ORDER BY id", id);
  let seq = 0;
  const nid = (p) => `nmi_${p}_${String(seq++).padStart(5, "0")}`;
  const cat = (p, label, target, parent) => ({ id: nid(p), label, type: "category", target, parent });
  const counts = {};
  tx(db, () => {
    const m20 = roots.slice(0, 8).map((r) => cat("f20", r.name, r.id));
    for (let i = 0; i < 12; i += 1) {
      const c = kids(roots[i % 4].id)[Math.floor(i / 4)];
      m20.push(cat("f20", c.name, c.id, m20[i % 4].id));
    }
    counts["20"] = publishMenu(db, MENUS["20"], "Fidelity 20", "fid-20", m20, now);

    const m150 = [];
    for (const r of roots) {
      const top = cat("f150", r.name, r.id);
      m150.push(top);
      for (const c of kids(r.id)) m150.push(cat("f150", c.name, c.id, top.id));
    }
    counts["150"] = publishMenu(db, MENUS["150"], "Fidelity 150", "fid-150", m150, now);

    const mega = [];
    for (const r of roots.slice(0, 8)) {
      const top = cat("mega", r.name, r.id);
      mega.push(top);
      for (const c of kids(r.id).slice(0, 4)) {
        const group = cat("mega", c.name, c.id, top.id);
        mega.push(group);
        const leaves = [...kids(c.id), ...kids(c.id).flatMap((x) => kids(x.id))];
        for (const l of leaves.slice(0, 2)) mega.push(cat("mega", l.name, l.id, group.id));
        mega.push(cat("mega", `${c.name} deals`, c.id, group.id));
      }
    }
    counts.mega = publishMenu(db, MENUS.mega, "Fidelity mega", "fid-mega", mega, now);

    const m1k = [];
    for (const r of roots) {
      const top = cat("f1k", r.name, r.id);
      m1k.push(top);
      for (const c of kids(r.id)) {
        const mid = cat("f1k", c.name, c.id, top.id);
        m1k.push(mid);
        for (const l of kids(c.id)) {
          m1k.push(cat("f1k", l.name, l.id, mid.id));
          for (const ll of kids(l.id)) m1k.push(cat("f1k", ll.name, ll.id, mid.id));
        }
        for (let j = 0; j < 6; j += 1) {
          const any = cats[(m1k.length * 13) % cats.length];
          m1k.push(cat("f1k", `${any.name} Deals ${j + 1}`, any.id, mid.id));
        }
      }
    }
    counts["1k"] = publishMenu(db, MENUS["1k"], "Fidelity 1k", "fid-1k", m1k, now);

    const byName = (n) => roots.find((r) => r.name.includes(n)) ?? roots[0];
    const live = [
      { id: nid("live"), label: "Shop", type: "system", target: "shop" },
      cat("live", "Footwear", byName("Laptop").id),
      cat("live", "Home & Living", byName("ফ্রিজ").id),
      cat("live", "Kitchen & Table", roots[2].id),
      cat("live", "Desk & Mobile Tech", byName("Desk & Mobile").id),
      cat("live", "Bags & Carry", roots[5].id),
      cat("live", "Footwear", byName("Laptop").id),
      cat("live", "Live Long Manual Collection 1786605259350", roots[6].id),
      cat("live", "Aster Studio Clogs", roots[7].id),
      cat("live", "Block Print Wool Shawl - 2027", roots[8].id),
      cat("live", "Jewellery", roots[9].id),
      { id: nid("live"), label: "Track your order", type: "system", target: "track-order" },
    ];
    counts.live = publishMenu(db, MENUS.live, "Fidelity live", "fid-live", live, now);

    db.prepare("DELETE FROM navigation_placements").run();
    const place = db.prepare("INSERT INTO navigation_placements (id, surface, slot, position, menu_id, is_enabled, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)");
    place.run("nplc_fid_header", "header", "primary", 0, MENUS["150"], now, now);
    place.run("nplc_fid_footer0", "footer", "column", 0, MENUS["20"], now, now);
    place.run("nplc_fid_footer1", "footer", "column", 1, MENUS.live, now, now);
  });
  db.close();
  log(`  menus: ${Object.entries(counts).map(([k, n]) => `fid-${k}=${n}`).join(" ")}`);
  return counts;
}

/** Points the header placement at `menuId` (called while the stack runs). */
export function setHeaderMenu(db, menuId) {
  db.prepare("UPDATE navigation_placements SET menu_id = ?, is_enabled = 1, revision = revision + 1, updated_at = unixepoch() WHERE surface = 'header'").run(menuId);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const i = process.argv.indexOf("--state");
  if (i < 0) {
    console.error("Usage: node scripts/storefront-fidelity/menus.mjs --state <dir>");
    process.exit(1);
  }
  seedMenus(process.argv[i + 1]);
}
