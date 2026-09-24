import { describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
  autoSeedRbacIfNeeded,
  getRbacSeedCacheKey,
  isRbacSeedCacheCurrent,
  markRbacSeedCacheCurrent,
} from "./auto-seed";
import { PERMISSIONS } from "./permissions";

describe("RBAC seed cache marker", () => {
  it("uses a compact versioned key derived from the seed definitions", () => {
    expect(getRbacSeedCacheKey()).toMatch(/^rbac:seed-current:v5:[a-f0-9]{8}$/);
  });

  it("reads and writes the current marker through KV", async () => {
    const values = new Map<string, string>();
    const kv = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
    } as unknown as Pick<KVNamespace, "get" | "put">;

    await expect(isRbacSeedCacheCurrent(kv)).resolves.toBe(false);
    await markRbacSeedCacheCurrent(kv);
    await expect(isRbacSeedCacheCurrent(kv)).resolves.toBe(true);

    expect(kv.put).toHaveBeenCalledWith(getRbacSeedCacheKey(), "1", {
      expirationTtl: 21600,
    });
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

  it("skips database reads once the KV marker is current", async () => {
    const queries: string[] = [];
    const { db } = createSqliteD1Database({ onQuery: (query) => queries.push(query) });
    const kv = { get: vi.fn(async () => "1"), put: vi.fn() };

    await autoSeedRbacIfNeeded(db, kv as unknown as Pick<KVNamespace, "get" | "put">);
    expect(queries).toEqual([]);
    expect(kv.put).not.toHaveBeenCalled();
  });
});
