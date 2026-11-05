import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteD1Database, type SqliteTestDatabase } from "@scalius/database/testing/sqlite-d1";
import { paymentSettingsRoutes } from "./payments";
import { OpenAPIHono } from "@hono/zod-openapi";
import { AppError } from "@scalius/core/errors";
import type { ContentfulStatusCode } from "hono/utils/http-status";

describe("admin settings payments", () => {
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
    app.route("/", paymentSettingsRoutes);
    return app;
  }

  const env = { CREDENTIAL_ENCRYPTION_KEY: "test-key-0123456789abcdef0123456789abcdef" } as unknown as Env;

  it("GET /payment-methods returns payment methods config", async () => {
    const app = appWithDb();
    const response = await app.request("/payment-methods", {}, env);
    expect(response.status).toBe(200);
    const json = (await response.json()) as { success: boolean; data: Record<string, unknown> };
    expect(json.success).toBe(true);
    expect(json.data).toHaveProperty("enabledMethods");
    expect(json.data).toHaveProperty("defaultMethod");
    expect(json.data).toHaveProperty("gateways");
    expect(json.data).toHaveProperty("revision");
  });

  it("GET /payment-methods includes COD and net_terms gateway status", async () => {
    const app = appWithDb();
    const response = await app.request("/payment-methods", {}, env);
    expect(response.status).toBe(200);
    const json = (await response.json()) as { success: boolean; data: { gatewayStatus: Record<string, unknown> } };
    expect(json.data.gatewayStatus.cod).toBeDefined();
    expect(json.data.gatewayStatus.net_terms).toBeDefined();
  });
});
