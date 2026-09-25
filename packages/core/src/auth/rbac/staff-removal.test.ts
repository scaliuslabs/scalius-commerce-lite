import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteD1Database, type SqliteTestDatabase } from "@scalius/database/testing/sqlite-d1";

import { autoSeedRbacIfNeeded } from "./auto-seed";
import { getFreshUserPermissionsFromD1 } from "./helpers";
import { removedStaffEmail, removeStaffMember } from "./staff-removal";

let database: SqliteTestDatabase;

const count = (sql: string, ...params: string[]) =>
  (database.sqlite.prepare(sql).get(...params) as { n: number }).n;

beforeEach(async () => {
  database = createSqliteD1Database();
  await autoSeedRbacIfNeeded(database.db);
  database.sqlite.exec(`
    INSERT INTO user (id, name, email, email_verified, role, is_super_admin, two_factor_enabled)
    VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1, 1),
           ('manager', 'Mina Manager', 'mina@shop.test', 1, 'admin', 0, 1),
           ('staff', 'Rafi Staff', 'rafi@shop.test', 1, 'admin', 0, 1);
    INSERT INTO user_roles (id, user_id, role_id, created_at)
      SELECT 'ur_manager', 'manager', id, unixepoch() FROM roles WHERE name = 'manager';
    INSERT INTO user_roles (id, user_id, role_id, created_at)
      SELECT 'ur_staff', 'staff', id, unixepoch() FROM roles WHERE name = 'sales_rep';
    INSERT INTO user_permissions (id, user_id, permission_id, granted, created_at)
      SELECT 'up_staff', 'staff', id, 1, unixepoch() FROM permissions WHERE name = 'products.edit';
    INSERT INTO account (id, user_id, account_id, provider_id, issuer, password)
      VALUES ('acc_staff', 'staff', 'staff', 'credential', 'scalius', 'hash');
    INSERT INTO session (id, user_id, token, expires_at) VALUES ('ses_staff', 'staff', 'tok', unixepoch() + 3600);
    INSERT INTO two_factor (id, user_id, secret, backup_codes) VALUES ('tf_staff', 'staff', 'secret', 'codes');
    INSERT INTO verification (id, identifier, value, expires_at)
      VALUES ('ver_staff', 'reset-password:abc', 'staff', unixepoch() + 3600);
    -- History the staff member left behind: an invite they sent.
    INSERT INTO admin_invitations (id, user_id, invited_by_user_id, name, email, status)
      VALUES ('inv_other', 'manager', 'staff', 'Mina Manager', 'mina@shop.test', 'accepted');
    INSERT INTO settings (id, key, value, type, category, revision)
      VALUES ('set_staff_keys', 'document', '{"shortcuts":{}}', 'json', 'staff-shortcuts:staff', 1),
             ('set_manager_keys', 'document', '{"shortcuts":{}}', 'json', 'staff-shortcuts:manager', 1);
  `);
});

afterEach(() => database.sqlite.close());

describe("remove staff", () => {
  it("ends sign-in and access for good but keeps their name on history", async () => {
    await removeStaffMember(database.db, { actorId: "manager", userId: "staff" });

    for (const table of ["session", "account", "two_factor", "user_roles", "user_permissions"]) {
      expect(count(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, "staff")).toBe(0);
    }
    expect(count("SELECT COUNT(*) AS n FROM verification WHERE value = ?", "staff")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM settings WHERE category = ?", "staff-shortcuts:staff")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM settings WHERE category = ?", "staff-shortcuts:manager")).toBe(1);
    expect(await getFreshUserPermissionsFromD1(database.db, "staff")).toEqual(new Set());

    const person = database.sqlite.prepare("SELECT name, email, banned, role FROM user WHERE id = 'staff'").get();
    expect(person).toEqual({ name: "Rafi Staff", email: removedStaffEmail("staff"), banned: 1, role: "user" });
    expect(database.sqlite.prepare(`
      SELECT u.name FROM admin_invitations i JOIN user u ON u.id = i.invited_by_user_id WHERE i.id = 'inv_other'
    `).get()).toEqual({ name: "Rafi Staff" });

    // The address is free to invite again.
    expect(count("SELECT COUNT(*) AS n FROM user WHERE email = 'rafi@shop.test'")).toBe(0);
    // Other staff are untouched.
    expect(count("SELECT COUNT(*) AS n FROM user_roles WHERE user_id = 'manager'")).toBe(1);
  });

  it("refuses the store owner and yourself", async () => {
    await expect(removeStaffMember(database.db, { actorId: "manager", userId: "owner" }))
      .rejects.toThrow("store owner");
    await expect(removeStaffMember(database.db, { actorId: "staff", userId: "staff" }))
      .rejects.toThrow("yourself");
    expect(count("SELECT COUNT(*) AS n FROM session WHERE user_id = 'staff'")).toBe(1);
  });
});
