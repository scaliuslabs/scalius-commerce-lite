import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { autoSeedRbacIfNeeded } from "@scalius/core/auth/rbac/auto-seed";
import { getFreshUserPermissionsFromD1 } from "@scalius/core/auth/rbac/helpers";
import { createSqliteD1Database, type SqliteTestDatabase } from "@scalius/database/testing/sqlite-d1";

import { errorResponseFromError } from "../../utils/api-response";
import { adminAuthManagementRoutes } from "./auth-management";
import { adminRbacRoutes } from "./rbac";

let database: SqliteTestDatabase;

const roleId = (name: string) =>
    (database.sqlite.prepare("SELECT id FROM roles WHERE name = ?").get(name) as { id: string }).id;

/** Settings → Users as `actorId`, with the permissions the admin middleware would resolve. */
async function asStaff(actorId: string) {
    const actor = database.sqlite.prepare("SELECT id, name, email, is_super_admin FROM user WHERE id = ?")
        .get(actorId) as { id: string; name: string; email: string; is_super_admin: number };
    const permissions = await getFreshUserPermissionsFromD1(database.db, actorId);
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
    app.onError((error, c) => {
        const { body, status } = errorResponseFromError(error);
        return c.json(body, status);
    });
    app.use("*", async (c, next) => {
        c.set("db", database.db);
        c.set("user", { ...actor, role: "admin", isSuperAdmin: actor.is_super_admin === 1 } as never);
        c.set("adminPermissions", permissions);
        await next();
    });
    app.route("/rbac", adminRbacRoutes);
    app.route("/auth", adminAuthManagementRoutes);
    return async (method: string, path: string, body?: unknown) => {
        const response = await app.request(`/api/v1/admin${path}`, {
            method,
            headers: { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        }, {} as Env);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- asserted field by field below
        return { status: response.status, body: await response.json() as { data?: any; error?: any } };
    };
}

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
      INSERT INTO session (id, user_id, token, expires_at) VALUES ('ses_staff', 'staff', 'tok', unixepoch() + 3600);
    `);
});

afterEach(() => database.sqlite.close());

describe("roles", () => {
    it("refuses a role whose permissions miss what they need", async () => {
        const call = await asStaff("owner");
        const inconsistent = await call("POST", "/rbac/roles", {
            name: "packer", displayName: "Packer", permissions: ["products.edit"],
        });
        expect(inconsistent.status).toBe(400);
        expect(inconsistent.body.error.message).toContain("products.view");

        const created = await call("POST", "/rbac/roles", {
            name: "packer", displayName: "Packer", permissions: ["products.view", "products.edit"],
        });
        expect(created.status).toBe(201);

        const edited = await call("PUT", `/rbac/roles/${created.body.data.role.id}`, {
            displayName: "Packer renamed", permissions: ["orders.change_status"],
        });
        expect(edited.status).toBe(400);
        // Nothing half-saved: the rename was refused with the permissions.
        const reread = await call("GET", `/rbac/roles/${created.body.data.role.id}`);
        expect(reread.body.data.role).toMatchObject({ displayName: "Packer", staffCount: 0 });
    });

    it("reports how many staff hold each role", async () => {
        const call = await asStaff("owner");
        const role = await call("GET", `/rbac/roles/${roleId("sales_rep")}`);
        expect(role.body.data.role.staffCount).toBe(1);

        const counts = new Map<string, number>();
        for (let page = 1; page <= 10; page += 1) {
            const list = await call("GET", `/rbac/roles?page=${page}`);
            for (const listed of list.body.data.roles) counts.set(listed.name, listed.staffCount);
            if (!list.body.data.pagination.hasMore) break;
        }
        expect(Object.fromEntries(counts)).toMatchObject({ manager: 1, sales_rep: 1, super_admin: 0 });
    });
});

describe("staff always keep a role", () => {
    it("refuses to add staff without a role", async () => {
        const call = await asStaff("owner");
        const response = await call("POST", "/auth/users", { name: "New", email: "new@shop.test" });
        expect(response.status).toBe(400);
    });

    it("refuses to take away someone's last role but allows swapping it", async () => {
        const call = await asStaff("owner");
        const last = await call("DELETE", "/rbac/user-roles", { userId: "staff", roleId: roleId("sales_rep") });
        expect(last.status).toBe(400);

        expect((await call("POST", "/rbac/user-roles", { userId: "staff", roleId: roleId("content_editor") })).status)
            .toBe(201);
        expect((await call("DELETE", "/rbac/user-roles", { userId: "staff", roleId: roleId("sales_rep") })).status)
            .toBe(200);
    });
});

describe("remove staff", () => {
    it("removes a staff member's access and sign-in", async () => {
        const call = await asStaff("manager");
        const response = await call("POST", "/auth/users/staff/remove");
        expect(response.status).toBe(200);
        expect(await getFreshUserPermissionsFromD1(database.db, "staff")).toEqual(new Set());
        expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM session WHERE user_id = 'staff'").get())
            .toEqual({ n: 0 });

        const list = await call("GET", "/auth/users?limit=2");
        expect(list.body.data.users.map((user: { id: string }) => user.id)).not.toContain("staff");
    });

    it("never removes the store owner or yourself", async () => {
        const call = await asStaff("manager");
        expect((await call("POST", "/auth/users/owner/remove")).status).toBe(400);
        expect((await call("POST", "/auth/users/manager/remove")).status).toBe(400);
        expect((await call("POST", "/auth/users/nobody/remove")).status).toBe(404);
    });
});
