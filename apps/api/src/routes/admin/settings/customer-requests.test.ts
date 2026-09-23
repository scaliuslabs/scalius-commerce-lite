import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

import { errorResponseFromError } from "../../../utils/api-response";
import { customerRequestPolicyRoutes } from "./customer-requests";

const policy = {
  cancellationEnabled: true,
  returnEnabled: false,
  refundEnabled: true,
  visibility: "show_unavailable" as const,
  introText: "Tell us what happened and we will review it.",
};

function createTestApp() {
  const { db } = createSqliteD1Database();
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/admin/settings", customerRequestPolicyRoutes);
  return app;
}

function put(app: ReturnType<typeof createTestApp>, body: unknown) {
  return app.request("/api/v1/admin/settings/customer-requests", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("customer request policy settings", () => {
  it("round-trips a complete strict policy and the exact buyer preview", async () => {
    const app = createTestApp();

    expect((await put(app, policy)).status).toBe(200);
    const response = await app.request("/api/v1/admin/settings/customer-requests");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        policy,
        resolvedIntro: policy.introText,
        preview: [
          { id: "pre_shipment" },
          { id: "shipped_unpaid" },
          { id: "delivered_paid" },
        ],
      },
    });
  });

  it("rejects unknown policy fields without persisting", async () => {
    const app = createTestApp();

    expect((await put(app, { ...policy, seoReturnWindow: 30 })).status).toBe(400);
    const stored = await (await app.request("/api/v1/admin/settings/customer-requests")).json() as {
      data: { policy: { introText: string } };
    };
    expect(stored.data.policy.introText).not.toBe(policy.introText);
  });
});
