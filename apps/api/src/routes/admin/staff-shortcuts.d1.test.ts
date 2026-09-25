// Per-staff keyboard shortcuts: each signed-in staff member reads and replaces
// only their own map, with compare-and-swap revisions and readable refusals.
import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

import { errorResponseFromError } from "../../utils/api-response";
import { adminAuthManagementRoutes } from "./auth-management";

let sqlite: DatabaseSync;
let db: Database;

beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
});
afterEach(() => sqlite.close());

function app(userId: string) {
    const router = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
    router.use("*", async (c, next) => {
        c.set("db", db as never);
        c.set("user", { id: userId } as never);
        await next();
    });
    router.route("/auth", adminAuthManagementRoutes);
    router.onError((error, c) => {
        const { body, status } = errorResponseFromError(error);
        return c.json(body, status);
    });
    return router;
}

function put(userId: string, body: unknown) {
    return app(userId).request("/api/v1/admin/auth/shortcuts", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}

type Body = { data: { shortcuts: Record<string, string>; revision: number }; error: { code: string; message: string } };
const json = async (response: Response) => await response.json() as Body;

describe("admin keyboard shortcuts", () => {
    it("starts empty at revision 0 and replaces the whole map on save", async () => {
        const empty = await app("user_1").request("/api/v1/admin/auth/shortcuts");
        expect(empty.status).toBe(200);
        expect(await empty.json()).toEqual({ success: true, data: { shortcuts: {}, revision: 0 } });

        const saved = await put("user_1", { expectedRevision: 0, shortcuts: { "/admin/orders": "g o", "/admin/products": "" } });
        expect(saved.status).toBe(200);
        expect(await saved.json()).toEqual({
            success: true,
            data: { shortcuts: { "/admin/orders": "g o", "/admin/products": "" }, revision: 1 },
        });

        const replaced = await put("user_1", { expectedRevision: 1, shortcuts: { "/admin/customers": "g c" } });
        expect((await json(replaced)).data).toEqual({ shortcuts: { "/admin/customers": "g c" }, revision: 2 });

        const other = await app("user_2").request("/api/v1/admin/auth/shortcuts");
        expect((await json(other)).data).toEqual({ shortcuts: {}, revision: 0 });
    });

    it("answers a stale revision with the settings conflict", async () => {
        await put("user_1", { expectedRevision: 0, shortcuts: { "/admin/orders": "g o" } });
        const stale = await put("user_1", { expectedRevision: 0, shortcuts: { "/admin/orders": "g x" } });
        expect(stale.status).toBe(409);
        expect((await json(stale)).error.code).toBe("SETTINGS_REVISION_CONFLICT");
    });

    it("refuses duplicates and bad paths with a readable message", async () => {
        const duplicate = await put("user_1", {
            expectedRevision: 0,
            shortcuts: { "/admin/orders": "g o", "/admin/customers": "g o" },
        });
        expect(duplicate.status).toBe(400);
        expect((await json(duplicate)).error.message).toBe("G then O is used twice");

        const outside = await put("user_1", { expectedRevision: 0, shortcuts: { "/checkout": "g o" } });
        expect(outside.status).toBe(400);
        expect((await json(outside)).error.message).toBe("\"/checkout\" is not a dashboard page");
    });
});
