import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteD1Database, type SqliteTestDatabase } from "@scalius/database/testing/sqlite-d1";
import { checkoutRoutes } from "./checkout";
import { OpenAPIHono } from "@hono/zod-openapi";
import { AppError } from "@scalius/core/errors";
import type { ContentfulStatusCode } from "hono/utils/http-status";

describe("storefront checkout config", () => {
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
    app.route("/api/v1/checkout", checkoutRoutes);
    return app;
  }

  const env = { CREDENTIAL_ENCRYPTION_KEY: "test-key-0123456789abcdef0123456789abcdef" } as unknown as Env;

  it("GET /api/v1/checkout/config returns checkout configuration", async () => {
    const app = appWithDb();
    const response = await app.request("/api/v1/checkout/config", {}, env);
    expect(response.status).toBe(200);
    const json = (await response.json()) as { success: boolean; data: Record<string, unknown> };
    expect(json.success).toBe(true);
    expect(json.data).toHaveProperty("gateways");
    expect(json.data).toHaveProperty("checkoutMode");
    expect(json.data).toHaveProperty("currency");
    expect(json.data).toHaveProperty("market");
  });
});
