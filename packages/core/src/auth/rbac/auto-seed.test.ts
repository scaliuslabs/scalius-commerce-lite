import { describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
  autoSeedRbacIfNeeded,
  getRbacSeedCacheKey,
  isRbacSeedCacheCurrent,
  markRbacSeedCacheCurrent,
  rbacSeedMarker,
} from "./auto-seed";
import { PERMISSIONS } from "./permissions";

describe("RBAC seed cache marker", () => {
  it("uses a compact versioned key derived from the seed definitions", () => {
    expect(getRbacSeedCacheKey()).toMatch(/^rbac:seed-current:v5:[a-f0-9]{8}$/);
  });

  it("reads and writes the current marker through the per-colo hint", async () => {
    const values = new Map<string, string>();
    const marker = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
    };

    await expect(isRbacSeedCacheCurrent(marker)).resolves.toBe(false);
    await markRbacSeedCacheCurrent(marker);
    await expect(isRbacSeedCacheCurrent(marker)).resolves.toBe(true);

    expect(marker.put).toHaveBeenCalledWith(getRbacSeedCacheKey(), "1");
  });

  it("has no marker without the Cache API or a Worker version", () => {
    expect(rbacSeedMarker({})).toBeNull();
    expect(rbacSeedMarker({ CF_VERSION_METADATA: { id: "v1" } })).toBeNull();
  });
});

describe("system RBAC reconciliation on the real schema", () => {
  const grantsOf = (sqlite: ReturnType<typeof createSqliteD1Database>["sqlite"], role: string) =>
    sqlite.prepare(`
      SELECT p.name FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
      WHERE r.name = ?
    `).all(role).map((row) => row.name);

  it("restores code-owned grants, removes stale ones, and never assigns users to roles", async () => {
    const { sqlite, db } = createSqliteD1Database();
    sqlite.exec(`INSERT INTO user (id, name, email, email_verified, role)
      VALUES ('legacy_admin', 'Legacy', 'legacy@example.com', 1, 'admin')`);

    await autoSeedRbacIfNeeded(db);
    expect(grantsOf(sqlite, "super_admin")).toHaveLength(Object.values(PERMISSIONS).length);
    expect(grantsOf(sqlite, "manager")).not.toContain(PERMISSIONS.ORDERS_REFUND);
    // Managers see and use apps; managing them stays with the Super Admin.
    expect(grantsOf(sqlite, "manager")).toEqual(expect.arrayContaining([PERMISSIONS.APPS_VIEW, PERMISSIONS.APPS_USE]));
    expect(grantsOf(sqlite, "manager")).not.toContain(PERMISSIONS.APPS_MANAGE);

    sqlite.exec(`
      INSERT INTO role_permissions (id, role_id, permission_id, created_at)
      SELECT 'stale_refund', r.id, p.id, unixepoch() FROM roles r, permissions p
      WHERE r.name = 'manager' AND p.name = '${PERMISSIONS.ORDERS_REFUND}';
      DELETE FROM role_permissions WHERE role_id = (SELECT id FROM roles WHERE name = 'sales_rep')
        AND permission_id = (SELECT id FROM permissions WHERE name = '${PERMISSIONS.ORDERS_VIEW}');
    `);
    await autoSeedRbacIfNeeded(db);

    expect(grantsOf(sqlite, "manager")).not.toContain(PERMISSIONS.ORDERS_REFUND);
    expect(grantsOf(sqlite, "sales_rep")).toContain(PERMISSIONS.ORDERS_VIEW);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM user_roles").get()).toEqual({ count: 0 });
  });

  it("skips database reads once the marker is current", async () => {
    const queries: string[] = [];
    const { db } = createSqliteD1Database({ onQuery: (query) => queries.push(query) });
    const kv = { get: vi.fn(async () => "1"), put: vi.fn() };

    await autoSeedRbacIfNeeded(db, kv);
    expect(queries).toEqual([]);
    expect(kv.put).not.toHaveBeenCalled();
  });
});
