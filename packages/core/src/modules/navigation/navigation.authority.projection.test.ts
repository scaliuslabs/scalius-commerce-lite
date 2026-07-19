import { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getNavigationPlacementManifest,
  listNavigationMenuItems,
  listNavigationMenus,
  listPublishedNavigationMenuItems,
} from "./navigation.authority.service";

describe("navigation authority correlated projections", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE navigation_menus (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, handle TEXT NOT NULL,
        revision INTEGER NOT NULL, published_revision INTEGER,
        dependency_revision INTEGER NOT NULL, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, deleted_at INTEGER
      );
      CREATE TABLE navigation_menu_items (
        id TEXT PRIMARY KEY, menu_id TEXT NOT NULL, parent_id TEXT,
        position INTEGER NOT NULL, label TEXT NOT NULL, label_mode TEXT NOT NULL,
        target_type TEXT NOT NULL, target_id TEXT, target_value TEXT,
        target_query TEXT, open_in_new_tab INTEGER NOT NULL,
        is_enabled INTEGER NOT NULL, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE navigation_menu_publications (
        menu_id TEXT NOT NULL, revision INTEGER NOT NULL,
        published_at INTEGER NOT NULL, published_by TEXT,
        item_count INTEGER NOT NULL, checksum TEXT NOT NULL,
        PRIMARY KEY (menu_id, revision)
      );
      CREATE TABLE navigation_menu_publication_items (
        menu_id TEXT NOT NULL, revision INTEGER NOT NULL, item_id TEXT NOT NULL,
        parent_id TEXT, position INTEGER NOT NULL, label TEXT NOT NULL,
        label_mode TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT,
        target_value TEXT, target_query TEXT, open_in_new_tab INTEGER NOT NULL,
        is_enabled INTEGER NOT NULL,
        PRIMARY KEY (menu_id, revision, item_id)
      );
      CREATE TABLE navigation_placements (
        id TEXT PRIMARY KEY, surface TEXT NOT NULL, slot TEXT NOT NULL,
        position INTEGER NOT NULL, menu_id TEXT NOT NULL, label_override TEXT,
        is_enabled INTEGER NOT NULL, revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO navigation_menus VALUES
        ('menu_1', 'Main menu', 'main-menu', 1, 1, 1, 1, 1, NULL);
      INSERT INTO navigation_menu_items VALUES
        ('item_root', 'menu_1', NULL, 1024, 'Shop', 'custom', 'system', NULL, 'catalog', NULL, 0, 1, 1, 1),
        ('item_child', 'menu_1', 'item_root', 1024, 'Shoes', 'custom', 'internal_path', NULL, '/shoes', NULL, 0, 1, 1, 1);
      INSERT INTO navigation_menu_publications VALUES
        ('menu_1', 1, 1, NULL, 2, 'checksum');
      INSERT INTO navigation_menu_publication_items VALUES
        ('menu_1', 1, 'item_root', NULL, 1024, 'Shop', 'custom', 'system', NULL, 'catalog', NULL, 0, 1),
        ('menu_1', 1, 'item_child', 'item_root', 1024, 'Shoes', 'custom', 'internal_path', NULL, '/shoes', NULL, 0, 1);
      INSERT INTO navigation_placements VALUES
        ('placement_header', 'header', 'primary', 0, 'menu_1', NULL, 1, 1, 1, 1);
    `);
    db = drizzle(async (query, params, method) => {
      const statement = sqlite.prepare(query);
      statement.setReturnArrays(true);
      if (method === "run") {
        statement.run(...params);
        return { rows: [] };
      }
      if (method === "get") {
        return { rows: statement.get(...params) as unknown as unknown[] };
      }
      return { rows: statement.all(...params) as unknown as unknown[][] };
    }) as unknown as Database;
  });

  afterEach(() => sqlite.close());

  it("qualifies outer rows for menu, child, and placement counts", async () => {
    const menus = await listNavigationMenus(db, { limit: 10 });
    expect(menus.items[0]).toMatchObject({ itemCount: 2, placementCount: 1 });

    const draftRoots = await listNavigationMenuItems(db, "menu_1", {
      parentId: null,
      limit: 10,
    });
    expect(draftRoots.items[0]).toMatchObject({ childCount: 1 });

    const publishedRoots = await listPublishedNavigationMenuItems(db, "menu_1", {
      parentId: null,
      limit: 10,
    });
    expect(publishedRoots.items[0]).toMatchObject({ childCount: 1 });

    const manifest = await getNavigationPlacementManifest(db);
    expect(manifest[0]).toMatchObject({ itemCount: 2, rootCount: 1 });
  });
});
