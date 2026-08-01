import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNavigationMenu,
  createNavigationMenuItem,
  deleteNavigationMenuItem,
  getNavigationMenuMoveOptions,
  getPublishedNavigationMenuTree,
  getPublishedNavigationPlacements,
  getNavigationPlacementManifest,
  listNavigationMenus,
  listNavigationPlacements,
  listNavigationMenuItems,
  moveNavigationMenuItem,
  publishNavigationMenu,
  restoreNavigationMenu,
  rollbackNavigationMenu,
  saveNavigationPlacement,
  searchNavigationMenuItems,
  trashNavigationMenu,
  updateNavigationMenuItem,
} from "./navigation.authority.service";
import { listNavigationResources } from "./navigation.resources.service";
import {
  NavigationPlacementRevisionConflictError,
  NavigationRevisionConflictError,
} from "./navigation.authority";

interface SqliteD1Result {
  results: Record<string, SQLOutputValue>[];
  success: true;
  meta: Record<string, never>;
}

interface SqliteD1Statement {
  bind(...values: SQLInputValue[]): SqliteD1Statement;
  run(): Promise<SqliteD1Result>;
  all(): Promise<SqliteD1Result>;
  raw(): Promise<SQLOutputValue[][]>;
  first(column?: string): Promise<unknown>;
  execute(): SqliteD1Result;
}

function resultRows(
  statement: StatementSync,
  values: SQLInputValue[],
): Record<string, SQLOutputValue>[] {
  return statement.all(...values);
}

function createD1Statement(
  sqlite: DatabaseSync,
  query: string,
  values: SQLInputValue[] = [],
): SqliteD1Statement {
  const execute = (): SqliteD1Result => ({
    results: resultRows(sqlite.prepare(query), values),
    success: true,
    meta: {},
  });
  return {
    bind: (...nextValues) => createD1Statement(sqlite, query, nextValues),
    run: async () => execute(),
    all: async () => execute(),
    raw: async () => {
      const statement = sqlite.prepare(query);
      statement.setReturnArrays(true);
      return statement.all(...values) as unknown as SQLOutputValue[][];
    },
    first: async (column) => {
      const row = resultRows(sqlite.prepare(query), values)[0];
      return column ? row?.[column] ?? null : row ?? null;
    },
    execute,
  };
}

const migration = readFileSync(
  resolve(import.meta.dirname, "../../../../database/migrations/0036_absent_living_lightning.sql"),
  "utf8",
).replaceAll("--> statement-breakpoint", "");

const legacySchema = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE site_settings (
    id TEXT PRIMARY KEY NOT NULL,
    singleton_key TEXT NOT NULL,
    header_config TEXT NOT NULL,
    footer_config TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE pages (
    id TEXT PRIMARY KEY NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'page',
    title TEXT NOT NULL,
    slug TEXT NOT NULL,
    canonical_path TEXT,
    is_published INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE TABLE categories (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    canonical_path TEXT,
    status TEXT NOT NULL,
    deleted_at INTEGER
  );
  CREATE TABLE collections (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    canonical_path TEXT,
    is_active INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE TABLE products (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    canonical_path TEXT,
    is_active INTEGER NOT NULL,
    deleted_at INTEGER
  );
`;

describe("navigation authority D1 commands", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  function createDatabase(): Database {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`${legacySchema}
      INSERT INTO site_settings VALUES ('site_1', 'default', '{}', '{}', 1, 1);
      ${migration}
    `);
    const client = {
      prepare: (query: string) => createD1Statement(sqlite!, query),
      batch: async (statements: SqliteD1Statement[]) => {
        sqlite!.exec("BEGIN IMMEDIATE");
        try {
          const results = statements.map((statement) => statement.execute());
          sqlite!.exec("COMMIT");
          return results;
        } catch (error) {
          sqlite!.exec("ROLLBACK");
          throw error;
        }
      },
    };
    return drizzle(client as unknown as D1Database, { schema }) as unknown as Database;
  }

  it("pages beyond the old 100-resource cap and hydrates unavailable selections", async () => {
    const db = createDatabase();
    const insertProduct = sqlite!.prepare(
      "INSERT INTO products (id, name, slug, canonical_path, is_active, deleted_at) VALUES (?, ?, ?, NULL, ?, ?)",
    );
    for (let index = 1; index <= 125; index += 1) {
      const suffix = String(index).padStart(3, "0");
      insertProduct.run(
        `prod_${suffix}`,
        `Product ${suffix}`,
        `product-${suffix}`,
        1,
        null,
      );
    }
    insertProduct.run(
      "prod_unavailable",
      "Unavailable product",
      "unavailable-product",
      0,
      1,
    );

    const first = await listNavigationResources(db, {
      type: "product",
      limit: 100,
      selectedId: "prod_unavailable",
    });
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toEqual({
      name: "Product 100",
      id: "prod_100",
    });
    expect(first.selected).toMatchObject({
      id: "prod_unavailable",
      name: "Unavailable product",
      available: false,
    });

    const second = await listNavigationResources(db, {
      type: "product",
      limit: 100,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((item) => item.id)).toEqual(
      Array.from({ length: 25 }, (_, index) => `prod_${String(index + 101).padStart(3, "0")}`),
    );
    expect(second.nextCursor).toBeNull();
  });

  it("uses the real article route in navigation resource results", async () => {
    const db = createDatabase();
    sqlite!.prepare(
      "INSERT INTO pages (id, content_type, title, slug, canonical_path, is_published, deleted_at) VALUES (?, 'article', ?, ?, NULL, 1, NULL)",
    ).run("page_article", "Buying guide", "buying-guide");

    const result = await listNavigationResources(db, {
      type: "page",
      limit: 20,
    });

    expect(result.items).toEqual([
      expect.objectContaining({
        id: "page_article",
        url: "/blog/buying-guide",
      }),
    ]);

    const menu = await createNavigationMenu(db, { name: "Guides" });
    const item = await createNavigationMenuItem(db, menu.id, {
      expectedRevision: menu.revision,
      label: "Buying guide",
      labelMode: "resource",
      target: {
        type: "resource",
        resourceType: "page",
        resourceId: "page_article",
      },
    });
    const publication = await publishNavigationMenu(db, menu.id, {
      expectedRevision: item.revision,
    });
    expect(publication.publishedRevision).toBeGreaterThan(0);
    const tree = await getPublishedNavigationMenuTree(db, menu.id);
    expect(tree.items).toEqual([
      expect.objectContaining({ href: "/blog/buying-guide" }),
    ]);
  });

  it("creates, edits, moves, publishes, and manifests one menu with monotonic CAS", async () => {
    const db = createDatabase();
    const menu = await createNavigationMenu(db, { name: "Main menu" });
    expect(menu).toMatchObject({ handle: "main-menu", revision: 1, publishedRevision: null });

    const shop = await createNavigationMenuItem(db, menu.id, {
      expectedRevision: 1,
      label: "Shop",
      labelMode: "custom",
      target: { type: "internal_path", path: "/search" },
    });
    expect(shop.revision).toBe(2);
    const shopId = (shop.item as { id: string }).id;

    const account = await createNavigationMenuItem(db, menu.id, {
      expectedRevision: 2,
      parentId: shopId,
      label: "Account",
      labelMode: "custom",
      target: { type: "system", key: "account" },
    });
    expect(account.revision).toBe(3);
    const accountId = (account.item as { id: string }).id;

    const search = await searchNavigationMenuItems(db, menu.id, { query: "Acc" });
    expect(search.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ item: expect.objectContaining({ id: shopId }), isMatch: false }),
      expect.objectContaining({ item: expect.objectContaining({ id: accountId }), isMatch: true }),
    ]));

    const moveOptions = await getNavigationMenuMoveOptions(db, menu.id, accountId);
    expect(moveOptions).toMatchObject({
      item: { id: accountId, label: "Account", parentId: shopId },
      subtreeDepth: 1,
      currentPosition: 1,
      selectedParentId: shopId,
      positionCount: 1,
      parents: [
        expect.objectContaining({
          id: shopId,
          pathLabel: "Shop",
          resultingLevel: 2,
          childCount: 1,
        }),
      ],
    });

    const moved = await moveNavigationMenuItem(db, menu.id, accountId, {
      expectedRevision: 3,
      parentId: null,
      index: 0,
    });
    expect(moved.revision).toBe(4);
    const roots = await listNavigationMenuItems(db, menu.id, { parentId: null });
    expect(roots.items.map(({ item }) => item.label)).toEqual(["Account", "Shop"]);

    const published = await publishNavigationMenu(db, menu.id, { expectedRevision: 4 });
    expect(published).toMatchObject({ revision: 5, publishedRevision: 5, itemCount: 2 });
    expect(published.checksum).toMatch(/^[a-f0-9]{64}$/);

    const placement = await saveNavigationPlacement(db, {
      id: "placement_main",
      expectedRevision: 0,
      surface: "header",
      slot: "primary",
      position: 0,
      menuId: menu.id,
    });
    expect(placement.placement).toMatchObject({ id: "placement_main", revision: 1 });
    expect(await getNavigationPlacementManifest(db)).toEqual([
      expect.objectContaining({
        id: "placement_main",
        menuId: menu.id,
        publishedRevision: 5,
        itemCount: 2,
        rootCount: 2,
        definition: expect.objectContaining({ maxDepth: 3, maxItems: 150 }),
      }),
    ]);

    const publicMenu = await getPublishedNavigationMenuTree(db, menu.id, { maxItems: 150 });
    expect(publicMenu).toMatchObject({
      id: menu.id,
      publishedRevision: 5,
      items: [
        { title: "Account", href: "/account" },
        { title: "Shop", href: "/search" },
      ],
    });
    expect(await getPublishedNavigationPlacements(db)).toEqual([
      expect.objectContaining({
        surface: "header",
        slot: "primary",
        items: [
          { id: accountId, title: "Account", href: "/account" },
          { id: shopId, title: "Shop", href: "/search" },
        ],
      }),
    ]);

    const edited = await updateNavigationMenuItem(db, menu.id, shopId, {
      expectedRevision: 5,
      label: "Catalog",
      labelMode: "custom",
      target: { type: "internal_path", path: "/search" },
    });
    expect(edited.revision).toBe(6);
    const republished = await publishNavigationMenu(db, menu.id, { expectedRevision: 6 });
    expect(republished.publishedRevision).toBe(7);
    expect((await getPublishedNavigationMenuTree(db, menu.id)).items[1]?.title).toBe("Catalog");

    const rolledBack = await rollbackNavigationMenu(db, menu.id, {
      expectedRevision: 7,
      sourceRevision: 5,
    });
    expect(rolledBack).toMatchObject({
      revision: 8,
      publishedRevision: 8,
      sourceRevision: 5,
      itemCount: 2,
    });
    expect((await getPublishedNavigationMenuTree(db, menu.id)).items[1]?.title).toBe("Shop");
    expect(await listNavigationPlacements(db)).toEqual([
      expect.objectContaining({
        placement: expect.objectContaining({ id: "placement_main", revision: 1 }),
        publishedRevision: 8,
      }),
    ]);

    await expect(saveNavigationPlacement(db, {
      id: "placement_main",
      expectedRevision: 0,
      surface: "header",
      slot: "primary",
      position: 0,
      menuId: menu.id,
    })).rejects.toBeInstanceOf(NavigationPlacementRevisionConflictError);

    await expect(updateNavigationMenuItem(db, menu.id, shopId, {
      expectedRevision: 7,
      label: "Stale",
      labelMode: "custom",
      target: { type: "internal_path", path: "/stale" },
    })).rejects.toBeInstanceOf(NavigationRevisionConflictError);
    expect(sqlite!.prepare("SELECT revision FROM navigation_menus WHERE id = ?").get(menu.id))
      .toEqual({ revision: 8 });
  });

  it("deletes a bounded menu subtree without recursive SQL", async () => {
    const db = createDatabase();
    const menu = await createNavigationMenu(db, { name: "Delete tree" });
    const root = await createNavigationMenuItem(db, menu.id, {
      expectedRevision: 1,
      label: "Root",
      labelMode: "custom",
      target: { type: "label" },
    });
    const rootId = (root.item as { id: string }).id;
    const child = await createNavigationMenuItem(db, menu.id, {
      expectedRevision: 2,
      parentId: rootId,
      label: "Child",
      labelMode: "custom",
      target: { type: "label" },
    });
    const childId = (child.item as { id: string }).id;
    await createNavigationMenuItem(db, menu.id, {
      expectedRevision: 3,
      parentId: childId,
      label: "Grandchild",
      labelMode: "custom",
      target: { type: "internal_path", path: "/search" },
    });

    await expect(deleteNavigationMenuItem(db, menu.id, rootId, 4)).resolves.toEqual({
      deletedCount: 3,
      revision: 5,
    });
    await expect(listNavigationMenuItems(db, menu.id, { parentId: null })).resolves.toMatchObject({
      items: [],
    });
    await expect(deleteNavigationMenuItem(db, menu.id, rootId, 5))
      .rejects.toThrow("Menu item not found");
    expect(sqlite!.prepare("SELECT revision FROM navigation_menus WHERE id = ?").get(menu.id))
      .toEqual({ revision: 5 });
  });

  it("trashes only an unplaced menu and restores it without republishing", async () => {
    const db = createDatabase();
    const menu = await createNavigationMenu(db, { name: "Seasonal" });
    await createNavigationMenuItem(db, menu.id, {
      expectedRevision: 1,
      label: "Summer",
      labelMode: "custom",
      target: { type: "internal_path", path: "/search" },
    });
    await publishNavigationMenu(db, menu.id, { expectedRevision: 2 });
    await saveNavigationPlacement(db, {
      id: "placement_seasonal",
      expectedRevision: 0,
      surface: "header",
      slot: "primary",
      position: 0,
      menuId: menu.id,
    });

    await expect(trashNavigationMenu(db, menu.id, { expectedRevision: 2 }))
      .rejects.toBeInstanceOf(NavigationRevisionConflictError);
    await expect(trashNavigationMenu(db, menu.id, { expectedRevision: 3 }))
      .rejects.toThrow("Remove this menu from its storefront locations");
    await saveNavigationPlacement(db, {
      id: "placement_seasonal",
      expectedRevision: 1,
      surface: "header",
      slot: "primary",
      position: 0,
      menuId: menu.id,
      isEnabled: false,
    });
    await expect(trashNavigationMenu(db, menu.id, { expectedRevision: 3 }))
      .resolves.toEqual({ revision: 4 });
    await expect(listNavigationMenus(db)).resolves.toMatchObject({ items: [] });
    await expect(listNavigationMenus(db, { includeTrash: true })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: menu.id, revision: 4, deletedAt: expect.any(Date) })],
    });
    await expect(listNavigationPlacements(db)).resolves.toEqual([
      expect.objectContaining({
        placement: expect.objectContaining({
          id: "placement_seasonal",
          isEnabled: false,
          revision: 2,
        }),
      }),
    ]);
    await expect(getPublishedNavigationPlacements(db)).resolves.toEqual([]);

    await expect(restoreNavigationMenu(db, menu.id, { expectedRevision: 4 }))
      .resolves.toEqual({ revision: 5 });
    await expect(listNavigationMenus(db)).resolves.toMatchObject({
      items: [expect.objectContaining({ id: menu.id, revision: 5, deletedAt: null })],
    });
    await expect(getPublishedNavigationPlacements(db)).resolves.toEqual([]);
  });
});
