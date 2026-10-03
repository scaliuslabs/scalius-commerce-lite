// Customers & marketing admin routes on the real schema: list filters
// (tag, segment, subscribed), segment CRUD with money crossing the edge in
// major units, preview, the CSV export, tags, consent with its audit author
// (staff or plugin), and the RBAC map of every new path.
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { getRoutePermission } from "@scalius/core/auth/rbac/route-permissions";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { errorResponseFromError } from "../../utils/api-response";
import { adminCustomerMarketingRoutes } from "./customer-marketing";
import { adminCustomerRoutes } from "./customers";

// Response bodies are asserted field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Envelope = { success: boolean; data: any; error?: any };

function createApp(options: { plugin?: string } = {}) {
    const { sqlite, db } = createSqliteD1Database();
    sqlite.exec(`
        INSERT INTO customers (id, name, phone, email) VALUES
          ('cust_a', 'Asha', '+8801711111111', 'asha@example.com'),
          ('cust_b', 'Bilal', '+8801722222222', NULL),
          ('cust_c', 'Chandni', '+8801733333333', 'chandni@example.com');
        INSERT INTO customer_addresses (id, customer_id, is_default, country_code, line1, city) VALUES
          ('caddr_a', 'cust_a', 1, 'BD', 'House 1', 'loc_dhaka'),
          ('caddr_b', 'cust_b', 1, 'BD', 'House 2', 'loc_ctg'),
          ('caddr_c', 'cust_c', 1, 'BD', 'House 3', 'loc_dhaka');
        INSERT INTO orders (id, customer_id, customer_name, customer_phone, shipping_address, city, zone, status, paid_amount_minor, currency_code, currency_decimal_places, created_at)
          VALUES ('ord_a', 'cust_a', 'Asha', '+8801711111111', 'House', 'c', 'z', 'delivered', 150000, 'BDT', 2, 1700000000),
                 ('ord_c', 'cust_c', 'Chandni', '+8801733333333', 'House', 'c', 'z', 'pending', 20000, 'BDT', 2, 1700000000);
        INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('usr_1', 'Nasrin', 'n@example.com', 1, 1, 1);
    `);
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
    app.onError((error, c) => {
        const { body, status } = errorResponseFromError(error);
        return c.json(body, status);
    });
    app.use("*", async (c, next) => {
        c.set("db", db);
        c.set("user" as never, { id: "usr_1" } as never);
        if (options.plugin) c.set("pluginPrincipal" as never, { pluginId: options.plugin } as never);
        c.env = { SCALIUS_SECRET: "test-master-secret-that-is-long-enough-123456" } as unknown as Env;
        await next();
    });
    app.route("/customers", adminCustomerMarketingRoutes);
    app.route("/customers", adminCustomerRoutes);
    const json = async (path: string, init?: RequestInit) => {
        const response = await app.request(`/api/v1/admin/customers${path}`, {
            ...init,
            headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
        });
        const text = await response.text();
        return { status: response.status, body: (text ? JSON.parse(text) : null) as Envelope };
    };
    return { app, sqlite, json };
}

describe("customer marketing admin routes", () => {
    it("filters the list by tag, saved segment and subscribed channel", async () => {
        const { json } = createApp();
        expect((await json("/tags/bulk", { method: "POST", body: JSON.stringify({ customerIds: ["cust_a", "cust_b"], add: ["VIP", " Eid "] }) })).body.data)
            .toEqual({ customers: 2, added: ["vip", "eid"], removed: [] });
        expect((await json("/tags")).body.data.tags).toEqual([{ tag: "eid", customers: 2 }, { tag: "vip", customers: 2 }]);
        expect((await json("?tag=VIP")).body.data.customers.map((row: { id: string }) => row.id).sort()).toEqual(["cust_a", "cust_b"]);

        // 1,000 taka is 100000 paisa: money crosses the edge in major units.
        const created = await json("/segments", {
            method: "POST",
            body: JSON.stringify({ name: "Big spenders", definition: { conditions: [{ field: "amount_spent", min: 1000 }] } }),
        });
        expect(created.status).toBe(201);
        expect(created.body.data.definition).toEqual({ version: 1, match: "all", conditions: [{ field: "amount_spent", min: 1000 }] });
        const segmentId = created.body.data.id as string;
        expect((await json(`?segmentId=${segmentId}`)).body.data.customers.map((row: { id: string }) => row.id)).toEqual(["cust_a"]);
        expect((await json(`/segments/${segmentId}/count`)).body.data).toEqual({ count: 1, capped: false });
        expect((await json(`/segments/${segmentId}/members?limit=1`)).body.data).toEqual({ customerIds: ["cust_a"], next: "cust_a" });

        const preview = await json("/segments/preview", {
            method: "POST",
            body: JSON.stringify({ definition: { match: "any", conditions: [{ field: "city", op: "in", ids: ["loc_dhaka"] }, { field: "tags", op: "has_any", tags: ["vip"] }] } }),
        });
        expect(preview.body.data.count).toBe(3);
        expect(preview.body.data.customers).toHaveLength(3);

        const stale = await json(`/segments/${segmentId}`, { method: "PUT", body: JSON.stringify({ expectedRevision: 7, name: "X" }) });
        expect(stale.status).toBe(409);
        const updated = await json(`/segments/${segmentId}`, {
            method: "PUT",
            body: JSON.stringify({ expectedRevision: 1, definition: { conditions: [{ field: "amount_spent", max: 999.5 }] } }),
        });
        expect(updated.body.data).toMatchObject({ revision: 2, definition: { conditions: [{ field: "amount_spent", max: 999.5 }] } });
        expect((await json(`?segmentId=${segmentId}`)).body.data.customers.map((row: { id: string }) => row.id).sort()).toEqual(["cust_b", "cust_c"]);

        expect((await json("?subscribed=sms")).body.data.customers).toEqual([]);
        await json("/cust_b/marketing", { method: "PUT", body: JSON.stringify({ channel: "sms", state: "subscribed", note: "Asked at the shop" }) });
        expect((await json("?subscribed=any")).body.data.customers.map((row: { id: string }) => row.id)).toEqual(["cust_b"]);

        expect((await json(`/segments/${segmentId}`, { method: "DELETE" })).status).toBe(204);
        expect((await json(`/segments/${segmentId}`)).status).toBe(404);
        expect((await json("?segmentId=seg_missing0000")).status).toBe(404);
    });

    it("records consent with its staff author and note, and refuses a staff subscribe without one", async () => {
        const { json } = createApp();
        const refused = await json("/cust_a/marketing", { method: "PUT", body: JSON.stringify({ channel: "email", state: "subscribed" }) });
        expect(refused.status).toBe(400);
        const saved = await json("/cust_a/marketing", { method: "PUT", body: JSON.stringify({ channel: "email", state: "subscribed", note: "Signed the form at the shop" }) });
        expect(saved.status).toBe(200);
        expect(saved.body.data.consents.find((row: { channel: string }) => row.channel === "email")).toMatchObject({ status: "subscribed", source: "admin" });
        expect(saved.body.data.events[0]).toMatchObject({ state: "subscribed", source: "admin", actor: "staff", actorName: "Nasrin", note: "Signed the form at the shop" });
        const detail = await json("/cust_a");
        expect(detail.body.data.marketing).toEqual([
            { channel: "email", status: "subscribed", updatedAt: expect.any(String) },
            { channel: "sms", status: "not_subscribed", updatedAt: null },
            { channel: "whatsapp", status: "not_subscribed", updatedAt: null },
        ]);
        expect(detail.body.data.tags).toEqual([]);
        expect((await json("/cust_b/marketing", { method: "PUT", body: JSON.stringify({ channel: "email", state: "subscribed", note: "x" }) })).status).toBe(400);
        expect((await json("/cust_missing/marketing")).status).toBe(404);
    });

    it("records a plugin as the author of a consent change", async () => {
        const { json } = createApp({ plugin: "acme.loyalty" });
        await json("/cust_c/marketing", { method: "PUT", body: JSON.stringify({ channel: "sms", state: "subscribed" }) });
        const payload = (await json("/cust_c/marketing")).body.data;
        expect(payload.events[0]).toMatchObject({ source: "plugin", actor: "plugin", actorName: "acme.loyalty" });
    });

    it("exports the filtered customers as spreadsheet-safe CSV with row headers", async () => {
        const { app, json } = createApp();
        await json("/cust_c/tags", { method: "PUT", body: JSON.stringify({ tags: ["Wholesale", "=cmd"] }) });
        const response = await app.request("/api/v1/admin/customers/export?tag=wholesale");
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
        expect(response.headers.get("Content-Disposition")).toMatch(/^attachment; filename="customers-\d{4}-\d{2}-\d{2}\.csv"$/);
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
        expect(response.headers.get("X-Export-Row-Count")).toBe("1");
        expect(response.headers.get("X-Export-Limited")).toBe("false");
        const bytes = new Uint8Array(await response.arrayBuffer());
        // A UTF-8 byte order mark first, so spreadsheet apps read Bangla correctly.
        expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
        const body = new TextDecoder().decode(bytes);
        expect(body.startsWith('"Customer ID"')).toBe(true);
        expect(body).toContain('"cust_c"');
        expect(body).toContain('"\'=cmd, wholesale"');
        const many = Array.from({ length: 101 }, (_, index) => `c${index}`).join(",");
        expect((await app.request(`/api/v1/admin/customers/export?ids=${many}`)).status).toBe(400);
    });

    it("maps every new admin path to customer or settings permissions", () => {
        const expectations: Array<[string, "GET" | "POST" | "PUT" | "DELETE", string]> = [
            ["/api/v1/admin/customers/tags", "GET", PERMISSIONS.CUSTOMERS_VIEW],
            ["/api/v1/admin/customers/tags/bulk", "POST", PERMISSIONS.CUSTOMERS_EDIT],
            ["/api/v1/admin/customers/export", "GET", PERMISSIONS.CUSTOMERS_VIEW],
            ["/api/v1/admin/customers/segments", "GET", PERMISSIONS.CUSTOMERS_VIEW],
            ["/api/v1/admin/customers/segments", "POST", PERMISSIONS.CUSTOMERS_EDIT],
            ["/api/v1/admin/customers/segments/preview", "POST", PERMISSIONS.CUSTOMERS_VIEW],
            ["/api/v1/admin/customers/segments/seg_1", "GET", PERMISSIONS.CUSTOMERS_VIEW],
            ["/api/v1/admin/customers/segments/seg_1", "PUT", PERMISSIONS.CUSTOMERS_EDIT],
            ["/api/v1/admin/customers/segments/seg_1", "DELETE", PERMISSIONS.CUSTOMERS_EDIT],
            ["/api/v1/admin/customers/segments/seg_1/count", "GET", PERMISSIONS.CUSTOMERS_VIEW],
            ["/api/v1/admin/customers/segments/seg_1/members", "GET", PERMISSIONS.CUSTOMERS_VIEW],
            ["/api/v1/admin/customers/cust_1/tags", "PUT", PERMISSIONS.CUSTOMERS_EDIT],
            ["/api/v1/admin/customers/cust_1/marketing", "GET", PERMISSIONS.CUSTOMERS_VIEW],
            ["/api/v1/admin/customers/cust_1/marketing", "PUT", PERMISSIONS.CUSTOMERS_EDIT],
            ["/api/v1/admin/settings/marketing-consent", "GET", PERMISSIONS.SETTINGS_GENERAL_VIEW],
            ["/api/v1/admin/settings/marketing-consent", "PUT", PERMISSIONS.SETTINGS_GENERAL_EDIT],
        ];
        for (const [path, method, permission] of expectations) {
            expect(getRoutePermission(path, method), `${method} ${path}`).toEqual({ permission });
        }
        // Writes are never reachable with read-only customer access.
        expect(getRoutePermission("/api/v1/admin/customers/tags/bulk", "GET")).toBeNull();
    });
});
