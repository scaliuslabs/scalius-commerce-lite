// Webhook and event-log routes (COMMERCE-HOOKS H3) on the real migrated
// schema: the secret is returned once and never listed, edits are
// version-guarded, URL refusals carry the guard's issue code, a test send is
// signed and logged, and the event log shows trigger-written events.
import { OpenAPIHono } from "@hono/zod-openapi";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { verifyWebhookSignature } from "@scalius/shared/events";
import { errorResponseFromError } from "../../utils/api-response";
import { adminEventRoutes } from "./events";
import { adminWebhookRoutes } from "./webhooks";

const ENCRYPTION_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => 32 - index)).toString("base64");

type Json = Record<string, any>;

describe("admin webhook routes", () => {
  let sqlite: DatabaseSync;
  let app: OpenAPIHono<{ Bindings: Env }>;
  const env = {
    CREDENTIAL_ENCRYPTION_KEY: ENCRYPTION_KEY,
  } as unknown as Env;

  beforeAll(() => {
    const created = createSqliteD1Database();
    sqlite = created.sqlite;
    sqlite.prepare("INSERT INTO user (id, name, email) VALUES ('admin_1', 'Owner', 'owner@example.test')").run();
    app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
    app.onError((error, c) => {
      if (process.env.DEBUG_WEBHOOK_ROUTES) console.error(error);
      const { body, status } = errorResponseFromError(error);
      return c.json(body, status);
    });
    app.use("*", async (c, next) => {
      c.set("db", created.db);
      c.set("user", { id: "admin_1" } as never);
      await next();
    });
    app.route("/webhooks", adminWebhookRoutes);
    app.route("/events", adminEventRoutes);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    sqlite?.close();
  });

  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
    const response = await app.request(`/api/v1/admin${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    }, env);
    return { status: response.status, json: await response.json() as Json };
  }

  let webhookId = "";
  let secret = "";

  it("creates an endpoint and returns its secret once", async () => {
    const created = await call("POST", "/webhooks", {
      url: "https://hooks.example.com/scalius",
      topics: ["order.paid", "order.*"],
      description: "ERP",
    });
    expect(created.status).toBe(201);
    secret = created.json.data.secret;
    webhookId = created.json.data.subscription.id;
    expect(secret).toMatch(/^whsec_/);
    expect(created.json.data.subscription).toMatchObject({
      url: "https://hooks.example.com/scalius",
      topics: ["order.*"],
      status: "active",
      secretHint: secret.slice(-4),
      version: 1,
    });
    expect(created.json.data.subscription.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(sqlite.prepare("SELECT created_by FROM webhook_subscriptions").get()).toEqual({ created_by: "admin_1" });

    const listed = await call("GET", "/webhooks");
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.json)).not.toContain(secret);
    expect(listed.json.data).toMatchObject({ maxSubscriptions: 20, apiVersion: "2026-10" });
    expect(listed.json.data.topicFilters).toContain("variant.inventory_changed");
    expect(listed.json.data.subscriptions).toHaveLength(1);
  });

  it("refuses unsafe URLs with the guard's issue code, and unknown topics", async () => {
    const insecure = await call("POST", "/webhooks", { url: "https://127.0.0.1/hook", topics: ["*"] });
    expect(insecure.status).toBe(400);
    expect(insecure.json.error.details).toMatchObject({ field: "url", issue: "private_address" });
    const unknownTopic = await call("POST", "/webhooks", { url: "https://hooks.example.com/b", topics: ["order.shipped"] });
    expect(unknownTopic.status).toBe(400);
    const unknownData = await call("POST", "/webhooks", { url: "https://hooks.example.com/c", topics: ["*"], customerData: ["passwords"] });
    expect(unknownData.status).toBe(400);
  });

  it("guards edits by version with a specific conflict code", async () => {
    const stale = await call("PATCH", `/webhooks/${webhookId}`, { expectedVersion: 7, description: "x" });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("WEBHOOK_VERSION_CONFLICT");
    const saved = await call("PATCH", `/webhooks/${webhookId}`, { expectedVersion: 1, topics: ["*"], status: "disabled" });
    expect(saved.status).toBe(200);
    expect(saved.json.data.subscription).toMatchObject({ topics: ["*"], status: "disabled", disabledReason: "manual", version: 2 });
  });

  it("sends no buyer contact data until the endpoint opts in, category by category", async () => {
    expect((await call("GET", `/webhooks/${webhookId}`)).json.data.subscription.customerData).toEqual([]);
    const current = (await call("GET", `/webhooks/${webhookId}`)).json.data.subscription;
    const saved = await call("PATCH", `/webhooks/${webhookId}`, { expectedVersion: current.version, customerData: ["phone", "name", "phone"] });
    expect(saved.status).toBe(200);
    // Catalog order, each once.
    expect(saved.json.data.subscription.customerData).toEqual(["name", "phone"]);
    expect(sqlite.prepare("SELECT customer_data FROM webhook_subscriptions WHERE id = ?").get(webhookId)).toEqual({ customer_data: '["name","phone"]' });
    const cleared = await call("PATCH", `/webhooks/${webhookId}`, { expectedVersion: saved.json.data.subscription.version, customerData: [] });
    expect(cleared.json.data.subscription.customerData).toEqual([]);
  });

  it("sends a signed test (also to a disabled endpoint) and logs it", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      const valid = await verifyWebhookSignature({ secret, header: headers["Scalius-Signature"], body: init.body as string });
      return new Response(valid ? "ok" : "bad signature", { status: valid ? 200 : 401 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const tested = await call("POST", `/webhooks/${webhookId}/test`, {});
    expect(tested.status).toBe(200);
    expect(tested.json.data.delivery).toMatchObject({ kind: "test", topic: "webhook.test", status: "succeeded", responseStatus: 200, attempts: 1 });
    expect(fetchMock).toHaveBeenCalledOnce();

    const deliveries = await call("GET", `/webhooks/${webhookId}/deliveries?limit=10`);
    expect(deliveries.status).toBe(200);
    expect(deliveries.json.data.deliveries).toHaveLength(1);
    expect(deliveries.json.data.nextCursor).toBeNull();
    expect((await call("GET", `/webhooks/${webhookId}/deliveries?status=bogus`)).status).toBe(400);
  });

  it("rotates the secret, then deletes the endpoint and its log", async () => {
    const rotated = await call("POST", `/webhooks/${webhookId}/rotate-secret`);
    expect(rotated.status).toBe(200);
    expect(rotated.json.data.secret).not.toBe(secret);
    expect(rotated.json.data.subscription.secretHint).toBe(rotated.json.data.secret.slice(-4));
    const deleted = await call("DELETE", `/webhooks/${webhookId}`);
    expect(deleted.json.data).toEqual({ id: webhookId, deleted: true });
    expect((await call("GET", `/webhooks/${webhookId}`)).status).toBe(404);
    expect(sqlite.prepare("SELECT count(*) AS n FROM webhook_event_deliveries").get()).toEqual({ n: 0 });
  });

  it("lists recent events with their facts", async () => {
    const subscribed = await call("POST", "/webhooks", {
      url: "https://hooks.example.com/events",
      topics: ["order.created"],
    });
    expect(subscribed.status).toBe(201);
    sqlite.exec(`INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status, channel)
      VALUES ('ord_ev', 'Rahim', '+8801711111111', 'House 1', 'city_1', 'zone_1', 'pending', 'admin')`);
    const listed = await call("GET", "/events?topic=order.created");
    expect(listed.status).toBe(200);
    expect(listed.json.data.events[0]).toMatchObject({
      topic: "order.created",
      resourceType: "order",
      resourceId: "ord_ev",
      facts: { orderId: "ord_ev", channel: "admin" },
      status: "pending",
      dispatchedAt: null,
    });
    expect((await call("GET", "/events?topic=order.shipped")).status).toBe(400);
  });
});
