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
  getPublishedNavigationMenuTree,
  getPublishedNavigationPlacements,
  getNavigationPlacementManifest,
  listNavigationPlacements,
  listNavigationMenuItems,
  moveNavigationMenuItem,
  publishNavigationMenu,
  rollbackNavigationMenu,
  saveNavigationPlacement,
  searchNavigationMenuItems,
  updateNavigationMenuItem,
} from "./navigation.authority.service";
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

    const moved = await moveNavigationMenuItem(db, menu.id, accountId, {
      expectedRevision: 3,
      parentId: null,
      beforeId: shopId,
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
});
