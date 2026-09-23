import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
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
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.exec(`
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
