import { Buffer } from "node:buffer";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { autoSeedRbacIfNeeded } from "@scalius/core/auth/rbac/auto-seed";
import { getFreshUserPermissionsFromD1 } from "@scalius/core/auth/rbac/helpers";
import { createSqliteD1Database, type SqliteTestDatabase } from "@scalius/database/testing/sqlite-d1";
import { deriveRuntimeSecrets } from "@scalius/shared/runtime-secrets";

import { errorResponseFromError } from "../../utils/api-response";
import { adminAuthManagementRoutes } from "./auth-management";
import { adminRbacRoutes } from "./rbac";

let database: SqliteTestDatabase;

const roleId = (name: string) =>
    (database.sqlite.prepare("SELECT id FROM roles WHERE name = ?").get(name) as { id: string }).id;

/** Worker entry's env: secrets derived from SCALIUS_SECRET and the dashboard origin (invites need both). */
async function workerEnv(): Promise<Env> {
    return {
        ...await deriveRuntimeSecrets("rbac-staff-test-master-secret-0123456789"),
        DB: database.binding,
        BETTER_AUTH_URL: "https://admin.shop.test",
        PUBLIC_API_BASE_URL: "https://api.shop.test",
        CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    } as unknown as Env;
}

/**
 * Settings → Users as `actorId`, with the permissions the admin middleware
 * would resolve. With `agentGrant`, an agent acting for `actorId` holds
 * only those permissions, as admin-auth sets them for an agent principal.
 */
async function asStaff(actorId: string, options: { agentGrant?: string[] } = {}) {
    const actor = database.sqlite.prepare("SELECT id, name, email, is_super_admin FROM user WHERE id = ?")
        .get(actorId) as { id: string; name: string; email: string; is_super_admin: number };
    const permissions = options.agentGrant
        ? new Set(options.agentGrant)
        : await getFreshUserPermissionsFromD1(database.db, actorId);
    const env = await workerEnv();
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
    app.onError((error, c) => {
        const { body, status } = errorResponseFromError(error);
        return c.json(body, status);
    });
    app.use("*", async (c, next) => {
        c.set("db", database.db);
        c.set("user", { ...actor, role: "admin", isSuperAdmin: actor.is_super_admin === 1 } as never);
        c.set("adminPermissions", permissions);
        if (options.agentGrant) c.set("agentPrincipal", { kind: "agent", ownerUserId: actor.id } as never);
        await next();
    });
    app.route("/rbac", adminRbacRoutes);
    app.route("/auth", adminAuthManagementRoutes);
    return async (method: string, path: string, body?: unknown) => {
        const response = await app.request(`/api/v1/admin${path}`, {
            method,
            headers: { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        }, env);
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

describe("roles keep every permission they claim", () => {
    it("reconciles a permission the catalog does not hold yet, and refuses an unknown one", async () => {
        // A store only an agent has used, or a new deploy's permission: the seed has not run.
        database.sqlite.exec(`
          DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE name IN ('orders.view', 'orders.edit'));
          DELETE FROM user_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE name IN ('orders.view', 'orders.edit'));
          DELETE FROM permissions WHERE name IN ('orders.view', 'orders.edit');
        `);
        const call = await asStaff("owner");
        const created = await call("POST", "/rbac/roles", {
            name: "order_manager", displayName: "Order manager", permissions: ["orders.view", "orders.edit"],
        });
        expect(created.status).toBe(201);
        const stored = database.sqlite.prepare(`SELECT p.name FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
          WHERE rp.role_id = ? ORDER BY p.name`).all(created.body.data.role.id) as Array<{ name: string }>;
        expect(stored.map((row) => row.name)).toEqual(["orders.edit", "orders.view"]);

        const unknown = await call("POST", "/rbac/roles", {
            name: "wizard", displayName: "Wizard", permissions: ["orders.view", "orders.teleport"],
        });
        expect(unknown.status).toBe(400);
        expect(unknown.body.error.message).toContain("orders.teleport");
        expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM roles WHERE name = 'wizard'").get()).toEqual({ n: 0 });
    });
});

describe("an agent acting for the owner delegates only its grant", () => {
    const grant = ["team.view", "team.manage", "team.manage_roles", "orders.view", "orders.edit"];

    it("invites a staff member who can only manage orders (eval task 26)", async () => {
        const agent = await asStaff("owner", { agentGrant: grant });
        const role = await agent("POST", "/rbac/roles", {
            name: "order_manager", displayName: "Order manager", permissions: ["orders.view", "orders.edit"],
        });
        expect(role.status).toBe(201);
        const invite = await agent("POST", "/auth/users", { name: "Tanvir Hasan", email: "tanvir@shop.test", roleId: role.body.data.role.id });
        expect(invite.status).toBe(201);
        expect(invite.body.data.onboardingRequired).toBe(true);
        expect([...await getFreshUserPermissionsFromD1(database.db, invite.body.data.user.id)].sort())
            .toEqual(["orders.edit", "orders.view"]);
    });

    it("never grants above the grant, even for a super-admin owner", async () => {
        const agent = await asStaff("owner", { agentGrant: grant });
        const above = await agent("POST", "/rbac/roles", {
            name: "refunder", displayName: "Refunder", permissions: ["orders.view", "orders.refund"],
        });
        expect(above.status).toBe(403);
        expect((await agent("POST", "/rbac/user-roles", { userId: "staff", roleId: roleId("super_admin") })).status).toBe(403);
        expect((await agent("POST", "/rbac/user-roles", { userId: "staff", roleId: roleId("manager") })).status).toBe(403);
        const invite = await agent("POST", "/auth/users", { name: "Eve", email: "eve@shop.test", roleId: roleId("super_admin") });
        expect(invite.status).toBe(403);
        expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM user WHERE email = 'eve@shop.test'").get()).toEqual({ n: 0 });

        // The owner signed in to the dashboard still delegates anything.
        const owner = await asStaff("owner");
        expect((await owner("POST", "/rbac/roles", {
            name: "refunder", displayName: "Refunder", permissions: ["orders.view", "orders.refund"],
        })).status).toBe(201);
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

describe("removing a role takes the same authority as assigning it", () => {
    it("lets a lower-privileged team lead remove only roles within their own permissions", async () => {
        const owner = await asStaff("owner");
        const lead = await owner("POST", "/rbac/roles", {
            name: "team_lead", displayName: "Team lead", permissions: ["team.view", "team.manage_roles", "orders.view", "orders.edit"],
        });
        const orders = await owner("POST", "/rbac/roles", {
            name: "order_desk", displayName: "Order desk", permissions: ["orders.view", "orders.edit"],
        });
        expect([lead.status, orders.status]).toEqual([201, 201]);
        expect((await owner("POST", "/rbac/user-roles", { userId: "staff", roleId: lead.body.data.role.id })).status).toBe(201);
        expect((await owner("POST", "/rbac/user-roles", { userId: "manager", roleId: orders.body.data.role.id })).status).toBe(201);

        // The team lead cannot demote the manager: the Manager role holds permissions they lack.
        const teamLead = await asStaff("staff");
        const demote = await teamLead("DELETE", "/rbac/user-roles", { userId: "manager", roleId: roleId("manager") });
        expect(demote.status).toBe(403);
        expect(demote.body.error.message).toContain("cannot remove a role");
        expect(database.sqlite.prepare("SELECT COUNT(*) AS n FROM user_roles WHERE user_id = 'manager'").get()).toEqual({ n: 2 });
        // An agent acting for the owner is held to its grant the same way.
        const agent = await asStaff("owner", { agentGrant: ["team.view", "team.manage_roles", "orders.view", "orders.edit"] });
        expect((await agent("DELETE", "/rbac/user-roles", { userId: "manager", roleId: roleId("manager") })).status).toBe(403);

        // A role within the lead's own permissions comes off, as it could have been given.
        expect((await teamLead("DELETE", "/rbac/user-roles", { userId: "manager", roleId: orders.body.data.role.id })).status).toBe(200);
        // The owner may remove any role.
        expect((await owner("POST", "/rbac/user-roles", { userId: "manager", roleId: orders.body.data.role.id })).status).toBe(201);
        expect((await owner("DELETE", "/rbac/user-roles", { userId: "manager", roleId: roleId("manager") })).status).toBe(200);
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
