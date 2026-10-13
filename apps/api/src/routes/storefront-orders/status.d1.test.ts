import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { buildCheckoutStatusTokenFromRequestKey } from "@scalius/core/modules/checkout";
import { errorResponseFromError } from "../../utils/api-response";
import { checkoutStatusRoutes } from "./status";

const requestKey = `checkout_submit:v1:${"b".repeat(64)}`;
const statusToken = buildCheckoutStatusTokenFromRequestKey(requestKey);
const receiptToken = "chk_private_receipt";
const failure = "Order creation failed. Please review your checkout and try again.";
let sqlite: DatabaseSync;
let app: OpenAPIHono<{ Bindings: Env }>;
const queries = vi.fn();

beforeEach(() => {
  vi.stubGlobal("__SCALIUS_PLAN__", "paid");
  queries.mockClear();
  const store = createSqliteD1Database({ onQuery: queries });
  sqlite = store.sqlite;
  app = new OpenAPIHono<{ Bindings: Env }>();
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", store.db);
    await next();
  });
  app.route("/orders", checkoutStatusRoutes);
});

afterEach(() => {
  sqlite.close();
  vi.unstubAllGlobals();
});

function seedAttempt(status: string) {
  sqlite.prepare(`INSERT INTO checkout_attempts
    (id, request_key, request_hash, checkout_token, order_id, status, claim_expires_at, last_error)
    VALUES ('attempt_1', ?, 'hash', ?, 'order_1', ?, 1, 'Internal failure for private@example.test chk_secret')`)
    .run(requestKey, receiptToken, status);
}

function seedOrder(options: { status?: string; paymentStatus?: string; paid?: number; deleted?: boolean; archived?: boolean } = {}) {
  sqlite.prepare(`INSERT INTO orders
    (id, customer_name, customer_phone, customer_email, requires_shipping, status, payment_status, paid_amount_minor, deleted_at, archived_at)
    VALUES ('order_1', 'Private Buyer', '+8801711000001', 'private@example.test', 0, ?, ?, ?, ?, ?)`)
    .run(options.status ?? "incomplete", options.paymentStatus ?? "unpaid", options.paid ?? 0,
      options.deleted ? 1 : null, options.archived ? 1 : null);
}

async function poll(token = statusToken) {
  const pending: Promise<unknown>[] = [];
  const response = await app.request(`/orders/status/${token}`, {}, {} as unknown as Env, {
    waitUntil: (task: Promise<unknown>) => pending.push(task),
    passThroughOnException() {},
  } as never);
  await Promise.all(pending);
  const body = await response.json();
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  for (const secret of [receiptToken, "chk_secret", "private@example.test", "Private Buyer", "+8801711000001"]) {
    expect(JSON.stringify(body)).not.toContain(secret);
  }
  return { response, body };
}

describe("durable checkout status authority", () => {
  it("reports a processing attempt with its committed order as completed", async () => {
    seedAttempt("processing");
    seedOrder();
    const { response, body } = await poll();
    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true, data: { status: "completed", orderId: "order_1" } });
    expect(queries).toHaveBeenCalledOnce();
  });

  it.each(["unpaid", "failed", "refunded"])("expires a cleaned-up cancelled %s order", async (paymentStatus) => {
    seedAttempt("committed");
    seedOrder({ status: "cancelled", paymentStatus, deleted: true });
    const { response, body } = await poll();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ success: true, data: { status: "expired", orderId: "order_1" } });
  });

  it.each([
    { paymentStatus: "paid", paid: 100 },
    { paymentStatus: "partial", paid: 1 },
    { paymentStatus: "refunded", paid: 1 },
    { paymentStatus: "unpaid", paid: 0, status: "incomplete" },
  ])("does not call an uncertain deleted order safe to restart: %j", async (order) => {
    seedAttempt("committed");
    seedOrder({ status: "cancelled", ...order, deleted: true });
    const { response, body } = await poll();
    expect(response.status).toBe(202);
    expect(body).toMatchObject({ data: { status: "processing" } });
  });

  it("keeps a merchant-archived order recoverable and lets the real order override a failed attempt", async () => {
    seedAttempt("failed");
    seedOrder({ archived: true });
    const { response, body } = await poll();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ data: { status: "completed", orderId: "order_1" } });
  });

  it("returns a generic failure only for a failed attempt with no order", async () => {
    seedAttempt("failed");
    const { response, body } = await poll();
    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true, data: { status: "failed", orderId: "order_1", error: failure } });
  });

  it.each(["committed", "processing", null])("does not interpret a missing order or attempt as failure (%s)", async (status) => {
    if (status) seedAttempt(status);
    const { response, body } = await poll();
    expect(response.status).toBe(202);
    expect(body).toMatchObject({ data: { status: "processing" } });
    expect(queries).toHaveBeenCalledOnce();
  });

  it("rejects receipt proof before any database access", async () => {
    const { response } = await poll(receiptToken);
    expect(response.status).toBe(400);
    expect(queries).not.toHaveBeenCalled();
  });
});
