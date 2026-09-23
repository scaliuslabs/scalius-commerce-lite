import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

import { adminSystemUtilsRoutes } from "./system-utils";

describe("admin system utility safe methods", () => {
  it("keeps abandoned checkout listing GET side-effect free", async () => {
    const statements: string[] = [];
    const { sqlite, db } = createSqliteD1Database({ onQuery: (query) => statements.push(query) });
    sqlite.prepare(`INSERT INTO abandoned_checkouts (id, checkout_id, checkout_data, created_at, updated_at)
      VALUES ('ac_stale', 'chk_stale', '{}', 1, 1)`).run();
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
    app.use("*", async (c, next) => {
      c.set("db", db);
      await next();
    });
    app.route("/", adminSystemUtilsRoutes);

    const response = await app.request("/api/v1/admin/abandoned-checkouts");

    expect(response.status).toBe(200);
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.filter((query) => !/^\s*select\b/i.test(query))).toEqual([]);
    expect(sqlite.prepare("SELECT COUNT(*) AS total FROM abandoned_checkouts").get()).toEqual({ total: 1 });
  });

  it("publishes a bounded PII-minimized agent summary route", () => {
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
    app.route("/", adminSystemUtilsRoutes);
    const spec = app.getOpenAPIDocument({
      openapi: "3.0.0",
      info: { title: "System utility operation identities", version: "test" },
    }) as unknown as { paths: Record<string, Record<string, {
      operationId?: string;
      responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
    }>> };
    const summary = spec.paths["/api/v1/admin/abandoned-checkouts/summaries"]?.get;
    const serializedSchema = JSON.stringify(summary?.responses?.["200"]?.content?.["application/json"]?.schema);

    expect(summary?.operationId).toBe("dashboard.abandoned_checkouts.summaries_list");
    expect(serializedSchema).toContain("itemCount");
    expect(serializedSchema).toContain("hasCustomerContact");
    expect(serializedSchema).not.toContain("checkoutData");
    expect(serializedSchema).not.toContain("customerPhone");
    expect(serializedSchema).not.toContain("shippingAddress");
  });

  it("publishes bounded explicit identities for browser FCM device maintenance", () => {
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
    app.route("/", adminSystemUtilsRoutes);
    const spec = app.getOpenAPIDocument({
      openapi: "3.0.0",
      info: { title: "System utility operation identities", version: "test" },
    }) as unknown as {
      paths: Record<string, Record<string, {
        operationId?: string;
        requestBody?: { required?: boolean; content?: Record<string, { schema?: {
          properties?: { invalidTokens?: { maxItems?: number; items?: { maxLength?: number } } };
        } }> };
      }>>;
    };
    const register = spec.paths["/api/v1/admin/fcm-token"]?.post;
    const cleanup = spec.paths["/api/v1/admin/fcm-token-cleanup"]?.post;

    expect(register?.operationId).toBe("dashboard.notifications.fcm_device_register");
    expect(register?.requestBody?.required).toBe(true);
    expect(cleanup?.operationId).toBe("dashboard.notifications.fcm_token_cleanup");
    expect(cleanup?.requestBody?.required).toBe(true);
    const invalidTokens = cleanup?.requestBody?.content?.["application/json"]
      ?.schema?.properties?.invalidTokens;
    expect(invalidTokens?.maxItems).toBe(10);
    expect(invalidTokens?.items?.maxLength).toBe(4_096);
  });
});
