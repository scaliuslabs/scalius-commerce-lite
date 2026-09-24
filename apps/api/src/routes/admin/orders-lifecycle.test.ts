import { OpenAPIHono } from "@hono/zod-openapi";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { errorResponseFromError } from "../../utils/api-response";
import { adminOrdersRoutes } from "./orders";

/**
 * HTTP behaviour of the order screens on real SQLite: accepting a customer
 * cancellation cancels the order, details edits, bulk confirm, the timeline,
 * and order numbers in the list.
 */
describe("admin order lifecycle routes", () => {
    let sqlite: DatabaseSync;
    let app: OpenAPIHono<{ Bindings: Env }>;
    const env = { JOBS_QUEUE: undefined } as unknown as Env;

    beforeEach(() => {
        const created = createSqliteD1Database();
        sqlite = created.sqlite;
        sqlite.exec(`
            INSERT INTO user (id, name, email, is_super_admin) VALUES ('admin_1', 'Nadia', 'nadia@example.test', 1);
            INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata, is_active)
            VALUES ('city_1', 'Dhaka', 'city', NULL, '{}', '{}', 1), ('zone_1', 'North', 'zone', 'city_1', '{}', '{}', 1);
            INSERT INTO orders (id, order_number, customer_name, customer_phone, shipping_address, city, zone,
              total_amount_minor, balance_due_minor, status, payment_method, payment_status, version, created_at)
            VALUES
              ('order_a', 1001, 'Rahim', '+8801712345601', 'House 1, Road 2', 'city_1', 'zone_1', 10000, 10000, 'pending', 'cod', 'unpaid', 1, 1700000000),
              ('order_b', 1002, 'Karim', '+8801712345602', 'House 3, Road 4', 'city_1', 'zone_1', 20000, 20000, 'pending', 'cod', 'unpaid', 1, 1700000100),
              ('order_c', 1003, 'Salma', '+8801712345603', 'House 5, Road 6', 'city_1', 'zone_1', 30000, 30000, 'shipped', 'cod', 'unpaid', 1, 1700000200);
            INSERT INTO cod_tracking (id, order_id, cod_status) VALUES ('cod_a', 'order_a', 'pending');
            INSERT INTO order_support_requests (id, order_id, type, status, reason, active_key)
            VALUES ('osr_1', 'order_a', 'cancel_pre_shipment', 'submitted', 'Ordered by mistake', 'order:order_a');
        `);
        app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
        app.use("*", async (c, next) => {
            c.set("db", created.db);
            c.set("user", { id: "admin_1" } as never);
            await next();
        });
        app.route("/orders", adminOrdersRoutes);
        app.onError((error, c) => {
            const { body, status } = errorResponseFromError(error);
            return c.json(body, status as never);
        });
    });

    afterEach(() => sqlite.close());

    const json = (method: string, body: unknown) => ({
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

    it("flags the open request in the list, and accepting it cancels the order and closes the request", async () => {
        const list = await app.request("/api/v1/admin/orders?openRequest=true", {}, env);
        const listed = await list.json() as { data: { orders: Array<{ id: string; orderNumber: number; openRequestType: string | null }> } };
        expect(listed.data.orders).toEqual([
            expect.objectContaining({ id: "order_a", orderNumber: 1001, openRequestType: "cancel_pre_shipment" }),
        ]);

        const response = await app.request(
            "/api/v1/admin/orders/order_a/support-requests/osr_1/status",
            json("PUT", { status: "approved" }),
            env,
        );
        expect(response.status).toBe(200);
        expect(sqlite.prepare("SELECT status FROM orders WHERE id = 'order_a'").get()).toEqual({ status: "cancelled" });
        expect(sqlite.prepare("SELECT status, active_key FROM order_support_requests WHERE id = 'osr_1'").get())
            .toEqual({ status: "completed", active_key: null });

        const timeline = await app.request("/api/v1/admin/orders/order_a/timeline", {}, env);
        const events = (await timeline.json() as { data: { events: Array<{ kind: string; data: unknown; actorName: string | null }> } }).data.events;
        expect(events.map((event) => event.kind)).toEqual(["request_resolved", "status_changed", "placed"]);
        expect(events[1]).toMatchObject({ data: { from: "pending", to: "cancelled", reason: "customer_request" }, actorName: "Nadia" });

        // One message to the buyer: the cancellation, not also a request update (R2-ORD-08).
        expect(sqlite.prepare("SELECT notification_type FROM order_notification_outbox WHERE order_id = 'order_a'").all())
            .toEqual([{ notification_type: "order_cancelled" }]);
    });

    it("refuses to accept a cancellation for an order that was already sent", async () => {
        sqlite.exec("UPDATE orders SET status = 'shipped' WHERE id = 'order_a'");
        const response = await app.request(
            "/api/v1/admin/orders/order_a/support-requests/osr_1/status",
            json("PUT", { status: "approved" }),
            env,
        );
        expect(response.status).toBe(400);
        expect(sqlite.prepare("SELECT status FROM order_support_requests WHERE id = 'osr_1'").get())
            .toEqual({ status: "submitted" });
    });

    it("confirms eligible orders in bulk and skips the rest in plain words", async () => {
        const response = await app.request(
            "/api/v1/admin/orders/bulk-confirm",
            json("POST", { orderIds: ["order_b", "order_c"] }),
            env,
        );
        const body = await response.json() as { data: { results: unknown[] } };
        expect(body.data.results).toEqual([
            { orderId: "order_b", success: true },
            { orderId: "order_c", success: false, error: "Only new orders can be confirmed." },
        ]);
        expect(sqlite.prepare("SELECT status FROM orders WHERE id = 'order_b'").get()).toEqual({ status: "confirmed" });
    });

    it("edits customer details before shipment and answers 409 on a stale version", async () => {
        const details = {
            customerName: "Karim Mia",
            customerPhone: "+8801912345699",
            customerEmail: null,
            shippingAddress: "House 9, Road 10",
            city: "city_1",
            zone: "zone_1",
            area: null,
        };
        const saved = await app.request("/api/v1/admin/orders/order_b/details", json("PUT", { ...details, expectedVersion: 1 }), env);
        expect(saved.status).toBe(200);
        expect(await saved.json()).toEqual({ success: true, data: { id: "order_b", version: 2 } });
        const stale = await app.request("/api/v1/admin/orders/order_b/details", json("PUT", { ...details, expectedVersion: 1 }), env);
        expect(stale.status).toBe(409);

        const comment = await app.request("/api/v1/admin/orders/order_b/timeline", json("POST", { body: "Confirmed by phone" }), env);
        expect(comment.status).toBe(201);
        const timeline = await app.request("/api/v1/admin/orders/order_b/timeline", {}, env);
        const events = (await timeline.json() as { data: { events: Array<{ kind: string; body: string | null; data: unknown }> } }).data.events;
        expect(events.slice(0, 2)).toEqual([
            expect.objectContaining({ kind: "comment", body: "Confirmed by phone" }),
            expect.objectContaining({ kind: "details_edited", data: { fields: ["customerName", "customerPhone", "shippingAddress"] } }),
        ]);
    });

    it("posts a comment once per request key and lets its author delete it (R2-ORD-04)", async () => {
        const post = () => app.request(
            "/api/v1/admin/orders/order_b/timeline",
            json("POST", { body: "Customer confirmed by phone", requestKey: "comment-draft-0001" }),
            env,
        );
        const first = await (await post()).json() as { data: { id: string; own: boolean } };
        const second = await (await post()).json() as { data: { id: string } };
        expect(second.data.id).toBe(first.data.id);
        expect(first.data.own).toBe(true);
        expect(sqlite.prepare("SELECT count(*) AS n FROM order_events WHERE kind = 'comment'").get()).toEqual({ n: 1 });

        sqlite.exec("INSERT INTO user (id, name, email, is_super_admin) VALUES ('admin_2', 'Rafi', 'rafi@example.test', 1)");
        sqlite.exec(`UPDATE order_events SET actor_id = 'admin_2' WHERE id = '${first.data.id}'`);
        const notMine = await app.request(`/api/v1/admin/orders/order_b/timeline/${first.data.id}`, { method: "DELETE" }, env);
        expect(notMine.status).toBe(403);

        sqlite.exec(`UPDATE order_events SET actor_id = 'admin_1' WHERE id = '${first.data.id}'`);
        for (let click = 0; click < 2; click += 1) {
            const deleted = await app.request(`/api/v1/admin/orders/order_b/timeline/${first.data.id}`, { method: "DELETE" }, env);
            expect(deleted.status).toBe(200);
        }
        expect(sqlite.prepare("SELECT count(*) AS n FROM order_events WHERE kind = 'comment'").get()).toEqual({ n: 0 });
    });

    it("reports a repeated bulk confirm as done (R2-ORD-03)", async () => {
        const run = () => app.request(
            "/api/v1/admin/orders/bulk-confirm",
            json("POST", { orderIds: ["order_b"], requestKey: "bulk-confirm-run-0001" }),
            env,
        );
        for (let click = 0; click < 2; click += 1) {
            const body = await (await run()).json() as { data: { results: unknown[] } };
            expect(body.data.results).toEqual([{ orderId: "order_b", success: true }]);
        }
        expect(sqlite.prepare("SELECT count(*) AS n FROM order_events WHERE kind = 'status_changed'").get()).toEqual({ n: 1 });
        expect(sqlite.prepare("SELECT count(*) AS n FROM order_notification_outbox WHERE order_id = 'order_b'").get()).toEqual({ n: 1 });
    });

    it("finds an order by its number", async () => {
        const response = await app.request(`/api/v1/admin/orders?search=${encodeURIComponent("#1002")}`, {}, env);
        const body = await response.json() as { data: { orders: Array<{ id: string }> } };
        expect(body.data.orders.map((order) => order.id)).toEqual(["order_b"]);
    });
});
