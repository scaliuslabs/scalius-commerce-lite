import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({
  getCustomerRequestPolicy: vi.fn(),
  saveCustomerRequestPolicy: vi.fn(),
}));

vi.mock("@scalius/core/modules/settings/customer-request-policy", async () => {
  const actual = await vi.importActual<
    typeof import("@scalius/core/modules/settings/customer-request-policy")
  >("@scalius/core/modules/settings/customer-request-policy");
  return {
    ...actual,
    getCustomerRequestPolicy: mocks.getCustomerRequestPolicy,
    saveCustomerRequestPolicy: mocks.saveCustomerRequestPolicy,
  };
});

import { customerRequestPolicyRoutes } from "./customer-requests";

const policy = {
  cancellationEnabled: true,
  returnEnabled: false,
  refundEnabled: true,
  visibility: "show_unavailable" as const,
  introText: "Tell us what happened and we will review it.",
};

function createTestApp() {
  const db = { id: "db" };
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  app.route("/admin/settings", customerRequestPolicyRoutes);
  return { app, db };
}

describe("customer request policy settings", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns normalized policy and the exact buyer preview", async () => {
    mocks.getCustomerRequestPolicy.mockResolvedValue(policy);
    const { app, db } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/settings/customer-requests",
    );
    expect(response.status).toBe(200);
    expect(mocks.getCustomerRequestPolicy).toHaveBeenCalledWith(db);
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

  it("saves a complete strict policy through PUT", async () => {
    mocks.saveCustomerRequestPolicy.mockResolvedValue(policy);
    const { app, db } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/settings/customer-requests",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(policy),
      },
    );
    expect(response.status).toBe(200);
    expect(mocks.saveCustomerRequestPolicy).toHaveBeenCalledWith(db, policy);
  });

  it("rejects unknown policy fields", async () => {
    const { app } = createTestApp();
    const response = await app.request(
      "/api/v1/admin/settings/customer-requests",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...policy, seoReturnWindow: 30 }),
      },
    );
    expect(response.status).toBe(400);
    expect(mocks.saveCustomerRequestPolicy).not.toHaveBeenCalled();
  });
});
