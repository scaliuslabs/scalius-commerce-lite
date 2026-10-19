import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "../src/testing/sqlite-d1";
import { splitSchemaMigrationStatements } from "../src/schema-upgrade";

const migration = readFileSync(new URL("../migrations/0158_app_access_contract.sql", import.meta.url), "utf8");
// The data statements: everything but the column and the ledger insert (they are guarded, so they re-run safely).
const grants = splitSchemaMigrationStatements(migration)
  .filter((statement) => !statement.includes("ALTER TABLE") && !statement.includes("scalius_schema_migrations"));

describe("0158 app access contract", () => {
  it("gives products.adjust_stock to every role, direct grant and agent grant that could edit products, and nobody else", () => {
    const { sqlite } = createSqliteD1Database();
    try {
      const permission = (name: string) => (sqlite.prepare("SELECT id FROM permissions WHERE name = ?").get(name) as { id: string } | undefined)?.id;
      sqlite.prepare("DELETE FROM permissions WHERE name = 'products.adjust_stock'").run();
      sqlite.exec(`INSERT OR IGNORE INTO permissions (id, name, display_name, resource, action, category) VALUES
        ('perm_edit', 'products.edit', 'Edit Products', 'products', 'edit', 'Products'),
        ('perm_view', 'products.view', 'View Products', 'products', 'view', 'Products')`);
      const edit = permission("products.edit")!;
      const view = permission("products.view")!;
      sqlite.exec(`INSERT INTO user (id, name, email, email_verified, role) VALUES ('u_editor', 'Editor', 'e@shop.test', 1, 'admin'), ('u_viewer', 'Viewer', 'v@shop.test', 1, 'admin');
        INSERT INTO roles (id, name, display_name) VALUES ('role_editor', 'catalog_editor', 'Catalog editor'), ('role_viewer', 'catalog_viewer', 'Catalog viewer');
        INSERT INTO role_permissions (id, role_id, permission_id) VALUES ('rp1', 'role_editor', '${edit}'), ('rp2', 'role_viewer', '${view}');
        INSERT INTO user_permissions (id, user_id, permission_id, granted) VALUES ('up1', 'u_editor', '${edit}', 0), ('up2', 'u_viewer', '${view}', 1);`);
      for (const statement of grants) sqlite.exec(statement);
      for (const statement of grants) sqlite.exec(statement);
      const adjust = permission("products.adjust_stock");
      expect(adjust).toBe("perm_products_adjust_stock");
      expect(sqlite.prepare("SELECT role_id FROM role_permissions WHERE permission_id = ? AND role_id IN ('role_editor', 'role_viewer')").all(adjust))
        .toEqual([{ role_id: "role_editor" }]);
      // A direct grant keeps its sense (here a denial stays a denial).
      expect(sqlite.prepare("SELECT user_id, granted FROM user_permissions WHERE permission_id = ?").all(adjust))
        .toEqual([{ user_id: "u_editor", granted: 0 }]);
    } finally {
      sqlite.close();
    }
  });

  it("appends to agent grant lists that name products.edit, once", () => {
    const { sqlite } = createSqliteD1Database();
    try {
      const statement = grants.find((sql) => sql.startsWith("-- A list") || sql.includes("UPDATE `agent_grants`"))!;
      const update = statement.slice(statement.indexOf("UPDATE"));
      sqlite.exec(`CREATE TEMP TABLE probe (permissions_json TEXT)`);
      const probe = update.replace("`agent_grants`", "probe").replace(/`agent_grants`\./g, "probe.");
      sqlite.exec(`INSERT INTO probe VALUES ('["orders.view","products.edit"]'), ('["orders.view"]'), ('["products.edit","products.adjust_stock"]'), ('[]')`);
      sqlite.exec(probe);
      sqlite.exec(probe);
      expect(sqlite.prepare("SELECT permissions_json FROM probe").all().map((row) => JSON.parse((row as { permissions_json: string }).permissions_json))).toEqual([
        ["orders.view", "products.edit", "products.adjust_stock"],
        ["orders.view"],
        ["products.edit", "products.adjust_stock"],
        [],
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("defaults every webhook to no buyer contact data", () => {
    const { sqlite } = createSqliteD1Database();
    try {
      const column = (sqlite.prepare("SELECT dflt_value, \"notnull\" FROM pragma_table_info('webhook_subscriptions') WHERE name = 'customer_data'").get()) as { dflt_value: string; notnull: number };
      expect(column).toEqual({ dflt_value: "'[]'", notnull: 1 });
    } finally {
      sqlite.close();
    }
  });
});
