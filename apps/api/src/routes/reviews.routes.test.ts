// Review routes (Wave B §7): the signed-in and guest buyer routes on the real
// public buyer app (conversation harness: migrated SQLite, sessions, receipt
// proof, switchable limiters), the dashboard moderation routes on the real
// router with a staff user, and the public review list.
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@scalius/database/client";
import { getRoutePermission } from "@scalius/core/auth/rbac/route-permissions";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { createConversationHarness, OTHER_SESSION, OWNER_SESSION, type Harness } from "./__tests__/conversation-harness";
import { errorResponseFromError } from "../utils/api-response";

const mocks = vi.hoisted(() => ({ bumpCacheGeneration: vi.fn(async () => undefined) }));
vi.mock("../utils/cache-generation", async () => {
  const actual = await vi.importActual<typeof import("../utils/cache-generation")>("../utils/cache-generation");
  return { ...actual, bumpCacheGeneration: mocks.bumpCacheGeneration };
});

import { adminReviewRoutes } from "./admin/reviews";
import { productReviewRoutes } from "./product-reviews";

let harness: Harness;

function seedDeliveredLines(h: Harness) {
  h.sqlite.exec(`
    INSERT INTO products (id, name, price_minor, slug, is_active) VALUES
      ('prod_shirt', 'Linen Shirt', 150000, 'linen-shirt', 1),
      ('prod_mug', 'Clay Mug', 50000, 'clay-mug', 1);
    INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory) VALUES
      ('var_shirt', 'prod_shirt', 'SHIRT-1', 150000, 10, 0, 1, 1),
      ('var_mug', 'prod_mug', 'MUG-1', 50000, 10, 0, 1, 1);
    INSERT INTO order_items (id, order_id, product_id, variant_id, product_name, quantity, unit_price_minor, fulfillment_type) VALUES
      ('item_owned', 'ORDEROWNED000001', 'prod_shirt', 'var_shirt', 'Linen Shirt', 1, 150000, 'ship'),
      ('item_guest', 'ORDERGUEST000001', 'prod_mug', 'var_mug', 'Clay Mug', 1, 50000, 'ship');
    INSERT INTO order_fulfillments (id, order_id, kind, request_key, actor_type) VALUES
      ('ful_owned', 'ORDEROWNED000001', 'ship', 'key_owned', 'admin'),
      ('ful_guest', 'ORDERGUEST000001', 'ship', 'key_guest', 'admin');
    INSERT INTO order_fulfillment_lines (id, fulfillment_id, order_id, order_item_id, quantity) VALUES
      ('fln_owned', 'ful_owned', 'ORDEROWNED000001', 'item_owned', 1),
      ('fln_guest', 'ful_guest', 'ORDERGUEST000001', 'item_guest', 1);
    UPDATE orders SET status = 'delivered';
  `);
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

beforeEach(async () => {
  harness = await createConversationHarness();
  seedDeliveredLines(harness);
});
afterEach(() => {
  harness.sqlite.close();
  vi.clearAllMocks();
});

type WriteBody = { data: { review: { id: string; version: number; status: string; rating: number }; created: boolean; published: boolean } };

describe("signed-in buyer review routes", () => {
  it("lists the lines to review, submits once, retries idempotently and edits with the version", async () => {
    const listed = await harness.request("/customer-auth/reviews", { session: OWNER_SESSION });
    expect(listed.status).toBe(200);
    expect(listed.headers.get("Cache-Control")).toContain("no-store");
    const before = await json<{ data: { toReview: Array<{ orderItemId: string; orderNumber: string }>; reviews: unknown[] } }>(listed);
    expect(before.data.toReview).toMatchObject([{ orderItemId: "item_owned", orderNumber: "#1057" }]);

    const body = JSON.stringify({ orderItemId: "item_owned", rating: 5, title: "Great shirt", clientKey: "attempt-0001" });
    const submitted = await harness.request("/customer-auth/reviews", { method: "POST", session: OWNER_SESSION, body });
    expect(submitted.status).toBe(201);
    const first = await json<WriteBody>(submitted);
    expect(first.data).toMatchObject({ created: true, published: true, review: { status: "published", rating: 5 } });

    const retry = await harness.request("/customer-auth/reviews", { method: "POST", session: OWNER_SESSION, body });
    expect(retry.status).toBe(200);
    expect((await json<WriteBody>(retry)).data).toMatchObject({ created: false, review: { id: first.data.review.id } });

    const patch = (session: string, payload: unknown) => harness.request(`/customer-auth/reviews/${first.data.review.id}`, {
      method: "PATCH", session, body: JSON.stringify(payload),
    });
    expect((await patch(OTHER_SESSION, { version: first.data.review.version, rating: 1 })).status).toBe(404);
    const edited = await patch(OWNER_SESSION, { version: first.data.review.version, rating: 4 });
    expect(edited.status).toBe(200);
    expect((await json<WriteBody>(edited)).data.review.rating).toBe(4);
    expect((await patch(OWNER_SESSION, { version: first.data.review.version, rating: 3 })).status).toBe(409);
    const withdrawn = await patch(OWNER_SESSION, { version: first.data.review.version + 1, withdraw: true });
    expect((await json<WriteBody>(withdrawn)).data.review.status).toBe("withdrawn");
  });

  it("refuses another account's line with a 404 and requires a session", async () => {
    const body = JSON.stringify({ orderItemId: "item_owned", rating: 5 });
    expect((await harness.request("/customer-auth/reviews", { method: "POST", session: OTHER_SESSION, body })).status).toBe(404);
    expect((await harness.request("/customer-auth/reviews", { method: "POST", body })).status).toBe(401);
    expect((await harness.request("/customer-auth/reviews")).status).toBe(401);
  });

  it("R10: fails closed without a limiter and answers 429 when a limiter refuses", async () => {
    const body = JSON.stringify({ orderItemId: "item_owned", rating: 5 });
    harness.limiter.missing = true;
    expect((await harness.request("/customer-auth/reviews", { method: "POST", session: OWNER_SESSION, body })).status).toBe(503);
    harness.limiter.missing = false;
    harness.limiter.allow = false;
    expect((await harness.request("/customer-auth/reviews", { method: "POST", session: OWNER_SESSION, body })).status).toBe(429);
    expect(harness.sqlite.prepare("SELECT count(*) AS n FROM product_reviews").get()).toEqual({ n: 0 });
  });
});

describe("guest review routes (receipt proof in a header)", () => {
  it("reviews the receipt's own order only with the proof", async () => {
    const body = JSON.stringify({ orderItemId: "item_guest", rating: 4, body: "Nice glaze" });
    const withoutProof = await harness.request("/orders/receipt/ORDERGUEST000001/reviews", { method: "POST", body });
    expect(withoutProof.status).toBeGreaterThanOrEqual(400);
    expect(withoutProof.status).toBeLessThan(500);
    const created = await harness.request("/orders/receipt/ORDERGUEST000001/reviews", { method: "POST", body, receipt: true });
    expect(created.status).toBe(201);
    expect((await json<WriteBody>(created)).data.review).toMatchObject({ rating: 4, status: "published" });
    // The proof of one order never reaches another order's lines.
    const other = await harness.request("/orders/receipt/ORDERGUEST000001/reviews", {
      method: "POST", receipt: true, body: JSON.stringify({ orderItemId: "item_owned", rating: 1 }),
    });
    expect(other.status).toBe(404);
    const listed = await harness.request("/orders/receipt/ORDERGUEST000001/reviews", { receipt: true });
    const data = await json<{ data: { toReview: unknown[]; reviews: Array<{ body: string }> } }>(listed);
    expect(data.data).toMatchObject({ toReview: [], reviews: [{ body: "Nice glaze" }] });
  });
});

function staffApp() {
  const db = getDb(harness.env);
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("user", { id: "staff_1" } as never);
    await next();
  });
  app.route("/admin/reviews", adminReviewRoutes);
  app.route("/products", productReviewRoutes);
  const send = (path: string, method = "GET", body?: unknown) => app.request(`/api/v1${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, harness.env);
  return { db, send };
}

describe("dashboard moderation routes", () => {
  it("maps every route to the review permissions", () => {
    expect(getRoutePermission("/api/v1/admin/reviews", "GET")).toEqual({ permission: PERMISSIONS.REVIEWS_VIEW });
    expect(getRoutePermission("/api/v1/admin/reviews/rev_abc123456789", "GET")).toEqual({ permission: PERMISSIONS.REVIEWS_VIEW });
    expect(getRoutePermission("/api/v1/admin/reviews/settings", "PUT")).toEqual({ permission: PERMISSIONS.REVIEWS_MODERATE });
    expect(getRoutePermission("/api/v1/admin/reviews/moderate", "POST")).toEqual({ permission: PERMISSIONS.REVIEWS_MODERATE });
    expect(getRoutePermission("/api/v1/admin/reviews/rev_abc123456789/reply", "PUT")).toEqual({ permission: PERMISSIONS.REVIEWS_MODERATE });
    expect(getRoutePermission("/api/v1/admin/reviews/rev_abc123456789/conversation", "POST"))
      .toEqual({ allOf: [PERMISSIONS.REVIEWS_MODERATE, PERMISSIONS.CONVERSATIONS_REPLY] });
  });

  it("holds, publishes, replies and bumps the cache generation only for buyer-visible changes", async () => {
    const { send } = staffApp();
    await send("/admin/reviews/settings", "PUT", { moderation: "hold", expectedRevision: 0 });
    expect(mocks.bumpCacheGeneration).toHaveBeenCalledTimes(1);
    const submitted = await harness.request("/customer-auth/reviews", {
      method: "POST", session: OWNER_SESSION, body: JSON.stringify({ orderItemId: "item_owned", rating: 2, body: "Too small" }),
    });
    const { data } = await json<WriteBody>(submitted);
    expect(data.review.status).toBe("pending");
    mocks.bumpCacheGeneration.mockClear();

    const queue = await json<{ data: { items: Array<{ id: string; product: { name: string }; order: { orderNumber: string } }> } }>(
      await send("/admin/reviews?status=pending"),
    );
    expect(queue.data.items).toMatchObject([{ id: data.review.id, product: { name: "Linen Shirt" }, order: { orderNumber: "#1057" } }]);
    expect((await json<{ data: { pending: number } }>(await send("/admin/reviews/summary"))).data.pending).toBe(1);

    // A pending reply is private: no bump.
    const replied = await send(`/admin/reviews/${data.review.id}/reply`, "PUT", { body: "Sorry! We'll swap it.", version: 1 });
    expect(replied.status).toBe(200);
    expect(mocks.bumpCacheGeneration).not.toHaveBeenCalled();

    const rejectWithoutReason = await send("/admin/reviews/moderate", "POST", { ids: [data.review.id], action: "reject", requestKey: "moderate-0001" });
    expect(rejectWithoutReason.status).toBe(400);
    const published = await send("/admin/reviews/moderate", "POST", { ids: [data.review.id], action: "publish", requestKey: "moderate-0002" });
    expect((await json<{ data: unknown }>(published)).data).toEqual({ updated: [{ id: data.review.id, previousStatus: "pending" }], skipped: [] });
    expect(mocks.bumpCacheGeneration).toHaveBeenCalledTimes(1);
    const again = await send("/admin/reviews/moderate", "POST", { ids: [data.review.id], action: "publish", requestKey: "moderate-0003" });
    expect((await json<{ data: { skipped: string[] } }>(again)).data.skipped).toEqual([data.review.id]);
    expect(mocks.bumpCacheGeneration).toHaveBeenCalledTimes(1);

    const thread = await send(`/admin/reviews/${data.review.id}/conversation`, "POST");
    expect(thread.status).toBe(201);
    const detail = await json<{ data: { conversationId: string; reply: { body: string } } }>(await send(`/admin/reviews/${data.review.id}`));
    expect(detail.data).toMatchObject({ reply: { body: "Sorry! We'll swap it." } });
    expect(detail.data.conversationId).toMatch(/^cnv_/);

    // The published review reaches the public list with its reply.
    const publicList = await json<{ data: { summary: { count: number; average: number }; items: Array<{ reply: unknown; authorName: string }> } }>(
      await send("/products/prod_shirt/reviews"),
    );
    expect(publicList.data.summary).toMatchObject({ count: 1, average: 2 });
    expect(publicList.data.items).toMatchObject([{ authorName: "Owner", reply: { body: "Sorry! We'll swap it." } }]);
    expect((await send("/products/prod_missing/reviews")).status).toBe(404);
  });
});
