import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../utils/api-response";

const mocks = vi.hoisted(() => ({
  getCheckoutConfig: vi.fn(),
}));

vi.mock("@scalius/core/modules/payments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/payments")>()),

}));

vi.mock("@scalius/core/modules/checkout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/checkout")>()),
  getCheckoutConfig: mocks.getCheckoutConfig,
}));

import { checkoutRoutes } from "./checkout";

function createTestApp() {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", { id: "db" } as never);
    await next();
  });
  app.route("/checkout", checkoutRoutes);
  return app;
}

describe("checkout config API caching", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not cache degraded checkout config failures as healthy responses", async () => {
    const app = createTestApp();
    const env = {
      JWT_SECRET: "test-jwt-secret",
    } as unknown as Env;
    mocks.getCheckoutConfig.mockRejectedValue(new Error("D1 unavailable"));

    const first = await app.request("/api/v1/checkout/config", {}, env);
    const second = await app.request("/api/v1/checkout/config", {}, env);

    expect(first.status).toBe(503);
    expect(second.status).toBe(503);
    expect(first.headers.get("Cache-Control")).toContain("no-store");
    expect(second.headers.get("Cache-Control")).toContain("no-store");
    expect(first.headers.get("X-Cache")).toBeNull();
    expect(second.headers.get("X-Cache")).toBeNull();
    expect(mocks.getCheckoutConfig).toHaveBeenCalledTimes(2);
    await expect(first.json()).resolves.toMatchObject({
      success: false,
      error: { code: "checkout_config_unavailable" },
    });
  });
});
