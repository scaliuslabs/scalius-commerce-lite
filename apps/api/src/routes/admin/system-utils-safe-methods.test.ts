import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import { adminSystemUtilsRoutes } from "./system-utils";

const ROUTES_DIR = fileURLToPath(new URL(".", import.meta.url));

describe("admin system utility safe methods", () => {
  it("keeps abandoned checkout listing GET side-effect free", () => {
    const source = readFileSync(`${ROUTES_DIR}/system-utils.ts`, "utf8");
    const listHandler = source.split("app.openapi(listAbandonedCheckoutsRoute")[1] ?? "";
    const getHandler = listHandler.split("// ── Bulk Delete Abandoned Checkouts")[0] ?? "";

    expect(listHandler).not.toBe("");
    expect(getHandler).not.toBe("");
    expect(getHandler).toContain("db.select()");
    expect(getHandler).not.toContain("db.delete(");
    expect(getHandler).not.toContain("db.update(");
    expect(getHandler).not.toContain("db.insert(");
    expect(getHandler).not.toContain("archiveStaleIncompleteOrders");
    expect(getHandler).not.toContain("cleanupStaleAbandonedCheckouts");
    expect(source).not.toContain("List abandoned checkouts with cleanup");
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
