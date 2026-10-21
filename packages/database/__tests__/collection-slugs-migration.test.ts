// Migration 0170: collections get a handle, backfilled from the name (an
// ASCII reading; collection-<id> when the name reads as nothing; a repeated
// handle takes the id as suffix), so the unique index always builds. Its
// update trigger is reinstalled with the new visible column, and the theme
// permission reaches everyone who could edit general settings.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { cacheDepTriggersForMigration } from "../scripts/cache-dep-triggers";
import { splitSchemaMigrationStatements } from "../src/schema-upgrade";

const NAME = "0170_collection_slugs_and_theme_permission";
const migration = (dir = "") => readFileSync(join(import.meta.dirname, `../migrations/${dir}${NAME}.sql`), "utf8");
const statements = splitSchemaMigrationStatements(migration());
const backfill = statements.filter((statement) => statement.startsWith("ALTER TABLE `collections`") || statement.startsWith("UPDATE `collections`") || statement.startsWith("CREATE UNIQUE INDEX `collections_slug_idx`"));

describe(`${NAME}: collection handles`, () => {
  it("backfills a unique, well-formed handle for every collection", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE collections (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
    const rows: Array<[string, string]> = [
      ["a1", "Hot Deals!"],
      ["a2", "Hot deals"],
      ["a3", "  Summer & Sun (2026)  "],
      ["a4", "শাড়ি"],
      ["a5", "Ab"],
      ["A_x-Y", "Hot Deals"],
    ];
    for (const [id, name] of rows) db.prepare("INSERT INTO collections VALUES (?, ?)").run(id, name);
    expect(backfill).toHaveLength(5);
    for (const statement of backfill) db.exec(statement);
    const slugs = Object.fromEntries((db.prepare("SELECT id, slug FROM collections").all() as Array<{ id: string; slug: string }>).map((row) => [row.id, row.slug]));
    expect(slugs).toEqual({
      "A_x-Y": "hot-deals",
      a1: "hot-deals-a1",
      a2: "hot-deals-a2",
      a3: "summer-sun-2026",
      a4: "collection-a4",
      a5: "collection-a5",
    });
    for (const slug of Object.values(slugs)) expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    db.close();
  });

  it("reinstalls the generated update trigger with the handle on every provider", () => {
    const [trigger, ...rest] = cacheDepTriggersForMigration(NAME);
    expect(rest).toEqual([]);
    expect(trigger!.name).toBe("cdep_collections_upd");
    expect(trigger!.sqlite).toContain("OLD.`slug` IS NOT NEW.`slug`");
    expect(migration()).toContain("DROP TRIGGER IF EXISTS `cdep_collections_upd`;");
    expect(migration()).toContain(`${trigger!.sqlite};`);
    expect(migration("postgres/")).toContain(`${trigger!.postgres};`);
    expect(trigger!.sqlite).not.toMatch(/\bCASE\b/);
  });

  it("gives settings.theme.edit to every role that could edit general settings", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE permissions (id TEXT PRIMARY KEY, name TEXT UNIQUE, display_name TEXT, description TEXT, resource TEXT, action TEXT, category TEXT, is_sensitive INTEGER);
      CREATE TABLE role_permissions (id TEXT PRIMARY KEY, role_id TEXT, permission_id TEXT);
      CREATE TABLE user_permissions (id TEXT PRIMARY KEY, user_id TEXT, permission_id TEXT, granted INTEGER, assigned_by TEXT);
      CREATE TABLE agent_grants (id TEXT PRIMARY KEY, permissions_json TEXT);
      CREATE TABLE agent_device_authorizations (id TEXT PRIMARY KEY, requested_permissions_json TEXT);
      INSERT INTO permissions (id, name) VALUES ('p_general', 'settings.general.edit'), ('p_view', 'settings.general.view');
      INSERT INTO role_permissions VALUES ('r1', 'manager', 'p_general'), ('r2', 'viewer', 'p_view');
      INSERT INTO user_permissions VALUES ('u1', 'ana', 'p_general', 1, 'owner');
      INSERT INTO agent_grants VALUES ('g1', '["settings.general.edit"]'), ('g2', '["orders.view"]');
      INSERT INTO agent_device_authorizations VALUES ('d1', '[ "settings.general.edit" ]');`);
    for (const statement of statements.filter((each) => /`(permissions|role_permissions|user_permissions|agent_grants|agent_device_authorizations)`/.test(each.split("\n").find((line) => !line.startsWith("--")) ?? ""))) {
      db.exec(statement);
      db.exec(statement);
    }
    expect(db.prepare("SELECT role_id FROM role_permissions WHERE permission_id = 'perm_settings_theme_edit'").all()).toEqual([{ role_id: "manager" }]);
    expect(db.prepare("SELECT user_id FROM user_permissions WHERE permission_id = 'perm_settings_theme_edit'").all()).toEqual([{ user_id: "ana" }]);
    expect(db.prepare("SELECT permissions_json AS p FROM agent_grants ORDER BY id").all()).toEqual([{ p: '["settings.general.edit","settings.theme.edit"]' }, { p: '["orders.view"]' }]);
    expect(JSON.parse((db.prepare("SELECT requested_permissions_json AS p FROM agent_device_authorizations").get() as { p: string }).p)).toEqual(["settings.general.edit", "settings.theme.edit"]);
    db.close();
  });
});
