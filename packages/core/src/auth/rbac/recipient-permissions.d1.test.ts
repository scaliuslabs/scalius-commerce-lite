import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { user } from "@scalius/database/schema";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { getFreshUserPermissionsFromD1, staffPermissionSql } from "./helpers";
import type { PermissionName } from "./types";

let sqlite: DatabaseSync;
let db: Database;
beforeEach(() => {
  ({ sqlite, db } = createSqliteD1Database());
  sqlite.exec(`
    INSERT INTO user (id,name,email,role) VALUES ('staff','Staff','staff@example.test','admin');
    INSERT INTO roles (id,name,display_name) VALUES ('role','test','Test');
    INSERT INTO user_roles (id,user_id,role_id) VALUES ('assignment','staff','role');
  `);
  for (const name of ["orders.view", "conversations.view", "inventory.view", "products.view", "products.delete", "products.permanent_delete"]) {
    sqlite.prepare("INSERT INTO permissions (id,name,display_name,resource,action,category) VALUES (?,?,?,?,?,?)")
      .run(name, name, name, name.split(".")[0]!, name.split(".")[1]!, "test");
  }
});
afterEach(() => sqlite.close());

async function allowed(permission: PermissionName) {
  const rows = await db.select({ id: user.id }).from(user).where(staffPermissionSql(user.id, permission));
  return rows.some((row) => row.id === "staff");
}
async function matchesResolver(permission: PermissionName, expected: boolean) {
  expect((await getFreshUserPermissionsFromD1(db, "staff")).has(permission)).toBe(expected);
  expect(await allowed(permission)).toBe(expected);
}
function grant(name: string) {
  sqlite.prepare("INSERT INTO role_permissions (id,role_id,permission_id) VALUES (?,'role',?)").run(name, name);
}

describe("fresh SQL recipient permission authority", () => {
  it("matches role/direct grants, explicit denial and immediate revocation without legacy-role fallback", async () => {
    await matchesResolver("orders.view", false);
    grant("orders.view");
    await matchesResolver("orders.view", true);
    sqlite.exec("INSERT INTO user_permissions (id,user_id,permission_id,granted) VALUES ('override','staff','orders.view',0)");
    await matchesResolver("orders.view", false);
    sqlite.exec("UPDATE user_permissions SET granted=1 WHERE id='override'; DELETE FROM user_roles");
    await matchesResolver("orders.view", true);
    sqlite.exec("DELETE FROM user_permissions");
    await matchesResolver("orders.view", false);
  });

  it("matches transitive and cross-area prerequisite denial", async () => {
    for (const name of ["inventory.view", "products.view", "products.delete", "products.permanent_delete"]) grant(name);
    await matchesResolver("inventory.view", true);
    await matchesResolver("products.permanent_delete", true);
    sqlite.exec("INSERT INTO user_permissions (id,user_id,permission_id,granted) VALUES ('deny','staff','products.view',0)");
    await matchesResolver("inventory.view", false);
    await matchesResolver("products.permanent_delete", false);
    sqlite.exec("DELETE FROM user_permissions; DELETE FROM role_permissions WHERE permission_id='products.delete'");
    await matchesResolver("products.permanent_delete", false);
    await matchesResolver("inventory.view", true);
  });

  it("matches super-admin override but never bypasses current bans or missing users", async () => {
    sqlite.exec("UPDATE user SET is_super_admin=1; INSERT INTO user_permissions (id,user_id,permission_id,granted) VALUES ('deny','staff','orders.view',0)");
    await matchesResolver("orders.view", true);
    expect(await db.select({ id: user.id }).from(user).where(staffPermissionSql(user.id, "super_admin"))).toHaveLength(1);
    sqlite.exec("UPDATE user SET banned=1,ban_expires=NULL");
    expect(await allowed("orders.view")).toBe(false);
    sqlite.exec("UPDATE user SET ban_expires=unixepoch()+3600");
    expect(await allowed("orders.view")).toBe(false);
    sqlite.exec("UPDATE user SET ban_expires=unixepoch()-1");
    expect(await allowed("orders.view")).toBe(true);
    const [missing] = await db.select({ allowed: staffPermissionSql(sql`${"missing"}`, "orders.view") }).from(user);
    expect(missing?.allowed).toBe(0);
  });
});
