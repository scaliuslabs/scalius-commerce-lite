import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const migration = [
  "0036_absent_living_lightning.sql",
  "0037_thick_ikaris.sql",
].map((file) => readFileSync(
  resolve(import.meta.dirname, `../migrations/${file}`),
  "utf8",
)).join("\n").replaceAll("--> statement-breakpoint", "");

const existingSchema = `
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

function sqlText(value: unknown): string {
  return JSON.stringify(value).replaceAll("'", "''");
}

describe("normalized navigation authority migration", () => {
  it("backfills nested typed menus, immutable publications, and placements", () => {
    const header = {
      logo: { src: "/logo.svg", alt: "Store" },
      navigation: [
        {
          id: "shop",
          target: {
            type: "resource",
            resourceType: "category",
            resourceId: "cat_1",
            query: "?sort=newest",
          },
          labelMode: "resource",
          lastKnownLabel: "Shop",
          subMenu: [
            {
              id: "account",
              target: { type: "internal_path", path: "/account" },
              labelMode: "custom",
              customLabel: "Account",
            },
          ],
        },
      ],
    };
    const footer = {
      menus: [
        {
          id: "help",
          title: "Help",
          links: [
            {
              id: "returns",
              target: { type: "resource", resourceType: "page", resourceId: "page_1" },
              labelMode: "resource",
              lastKnownLabel: "Returns",
            },
          ],
        },
      ],
    };

    const result = spawnSync("sqlite3", [":memory:"], {
      input: `.bail on
        ${existingSchema}
        INSERT INTO categories VALUES ('cat_1', 'Shop', 'shop', NULL, 'published', NULL);
        INSERT INTO pages VALUES ('page_1', 'Returns', 'returns', NULL, 1, NULL);
        INSERT INTO site_settings VALUES (
          'site_1', 'default', '${sqlText(header)}', '${sqlText(footer)}', 10, 20
        );
        ${migration}
        SELECT count(*) || ':' || sum(published_revision IS NOT NULL)
          FROM navigation_menus;
        SELECT count(*) || ':' || sum(parent_id IS NOT NULL) || ':' ||
          sum(target_query = '?sort=newest')
          FROM navigation_menu_items;
        SELECT count(*) || ':' || sum(item_count)
          FROM navigation_menu_publications;
        SELECT group_concat(surface || '.' || slot || ':' || position, ',')
          FROM navigation_placements ORDER BY surface, position;
        UPDATE categories SET name = 'New shop' WHERE id = 'cat_1';
        SELECT dependency_revision FROM navigation_menus
          WHERE id = 'menu_legacy_header_primary';
      `,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "2:2",
      "3:1:1",
      "2:3",
      "header.primary:0,footer.column:0",
      "2",
    ]);
  });

  it("fails closed on ambiguous identities and malformed target rows", () => {
    const result = spawnSync("sqlite3", [":memory:"], {
      input: `.bail off
        ${existingSchema}
        INSERT INTO site_settings VALUES ('site_1', 'default', '{}', '{}', 10, 20);
        ${migration}
        INSERT INTO navigation_menus (id, name, handle) VALUES ('menu_a', 'A', 'main');
        INSERT INTO navigation_menus (id, name, handle) VALUES ('menu_b', 'B', ' MAIN ');
        INSERT INTO navigation_menu_items (
          id, menu_id, position, label, label_mode, target_type
        ) VALUES ('item_bad', 'menu_a', 1024, 'Broken', 'custom', 'product');
      `,
      encoding: "utf8",
    });

    expect(result.stderr).toContain("navigation_menus_handle_normalized");
    expect(result.stderr).toContain("navigation_menu_items_target_shape");
  });

  it("normalizes legacy footer locations and drops only unsupported overflow placements", () => {
    const footer = {
      menus: Array.from({ length: 5 }, (_, index) => ({
        id: `menu-${index + 1}`,
        title: `Menu ${index + 1}`,
        links: [],
      })),
    };
    const result = spawnSync("sqlite3", [":memory:"], {
      input: `.bail on
        ${existingSchema}
        INSERT INTO site_settings VALUES (
          'site_1', 'default', '{}', '${sqlText(footer)}', 10, 20
        );
        ${migration}
        SELECT count(*) FROM navigation_menus;
        SELECT count(*) || ':' || group_concat(position, ',')
          FROM (
            SELECT position
            FROM navigation_placements
            WHERE surface = 'footer' AND slot = 'column'
            ORDER BY position
          );
      `,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "5",
      "4:0,1,2,3",
    ]);
  });

  it("leaves a fresh or invalid legacy document unclaimed", () => {
    const result = spawnSync("sqlite3", [":memory:"], {
      input: `.bail on
        ${existingSchema}
        INSERT INTO site_settings VALUES ('site_1', 'default', '{bad', '{bad', 10, 20);
        ${migration}
        SELECT count(*) || ':' || (SELECT count(*) FROM navigation_placements)
          FROM navigation_menus;
      `,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("0:0");
  });
});
