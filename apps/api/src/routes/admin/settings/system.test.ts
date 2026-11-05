import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteD1Database, type SqliteTestDatabase } from "@scalius/database/testing/sqlite-d1";
import { systemSettingsRoutes } from "./system";
import { OpenAPIHono } from "@hono/zod-openapi";
import { AppError } from "@scalius/core/errors";
import type { ContentfulStatusCode } from "hono/utils/http-status";

describe("admin settings system", () => {
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
    app.route("/", systemSettingsRoutes);
    return app;
  }

  const env = { CREDENTIAL_ENCRYPTION_KEY: "test-key-0123456789abcdef0123456789abcdef" } as unknown as Env;

  it("GET /checkout-readiness returns readiness diagnostics", async () => {
    const app = appWithDb();
    const response = await app.request("/checkout-readiness", {}, env);
    expect(response.status).toBe(200);
    const json = (await response.json()) as { success: boolean; data: Record<string, unknown> };
    expect(json.success).toBe(true);
    expect(json.data).toHaveProperty("status");
    expect(json.data).toHaveProperty("issues");
  });

  it("GET /checkout-flow returns checkout flow settings", async () => {
    const app = appWithDb();
    const response = await app.request("/checkout-flow", {}, env);
    expect(response.status).toBe(200);
    const json = (await response.json()) as { success: boolean; data: Record<string, unknown> };
    expect(json.success).toBe(true);
    expect(json.data).toHaveProperty("checkoutMode");
    expect(json.data).toHaveProperty("revision");
  });

  it("PUT /checkout-flow rejects mismatched expectedRevision with 409", async () => {
    const app = appWithDb();
    const response = await app.request("/checkout-flow", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        guestCheckoutEnabled: true,
        checkoutMode: "all",
        partialPaymentEnabled: false,
        partialPaymentAmount: 0,
        expectedRevision: 999,
      }),
    }, env);
    expect(response.status).toBe(409);
  });
});
