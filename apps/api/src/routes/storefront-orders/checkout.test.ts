import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteD1Database, type SqliteTestDatabase } from "@scalius/database/testing/sqlite-d1";
import { checkoutRoutes } from "./checkout";
import { OpenAPIHono } from "@hono/zod-openapi";
import { AppError } from "@scalius/core/errors";
import type { ContentfulStatusCode } from "hono/utils/http-status";

describe("storefront orders checkout", () => {
  let fixture: SqliteTestDatabase;

  beforeEach(() => {
    fixture = createSqliteD1Database();
  });

  afterEach(() => fixture.sqlite.close());

  function appWithDb() {
    const app = new OpenAPIHono<{ Bindings: Env }>();
    app.use("*", async (c, next) => {
      c.set("db" as never, fixture.db as never);
      await next();
    });
    app.onError((error, c) => {
      if (error instanceof AppError) {
        return c.json({ success: false, error: { code: error.code, message: error.message } }, error.status as ContentfulStatusCode);
      }
      return c.json({ success: false, error: { code: "internal_error", message: "Unexpected error" } }, 500 as ContentfulStatusCode);
    });
    app.route("/", checkoutRoutes);
    return app;
  }

  const env = { CREDENTIAL_ENCRYPTION_KEY: "test-key-0123456789abcdef0123456789abcdef" } as unknown as Env;

  const baseInput = {
    checkoutRequestId: "cr_test_0000000000000001",
    expectedQuoteFingerprint: "taxq_" + "a".repeat(22),
    customerName: "Test Buyer",
    customerPhone: null,
    customerEmail: "buyer@example.com",
    shippingCountryCode: "BD",
    items: [
      {
        productId: "p_test",
        variantId: "v_test",
        quantity: 1,
        price: 100,
      },
    ],
  };

  it("POST / rejects order with missing required fields", async () => {
    const app = appWithDb();
    const response = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }, env);
    expect(response.status).toBe(400);
  });

  it("POST / rejects order with invalid checkout request id", async () => {
    const app = appWithDb();
    const response = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseInput, checkoutRequestId: "bad id!" }),
    }, env);
    expect(response.status).toBe(400);
  });

  it("POST / rejects order with invalid quote fingerprint", async () => {
    const app = appWithDb();
    const response = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...baseInput, expectedQuoteFingerprint: "bad-fingerprint" }),
    }, env);
    expect(response.status).toBe(400);
  });
});
