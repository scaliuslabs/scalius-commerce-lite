import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../utils/api-response";

const mocks = vi.hoisted(() => ({
  getCheckoutConfig: vi.fn(),
}));

vi.mock("@scalius/core/modules/payments/gateway-settings", () => ({}));

vi.mock("@scalius/core/modules/settings/checkout-config.service", () => ({
  getCheckoutConfig: mocks.getCheckoutConfig,
}));

import { checkoutRoutes } from "./checkout";

function createKvStore(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    list: vi.fn(async ({ prefix }: { prefix?: string } = {}) => ({
      keys: [...store.keys()]
        .filter((name) => !prefix || name.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    })),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  } as unknown as KVNamespace;
}

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
      CACHE: createKvStore(),
      JWT_SECRET: "test-jwt-secret",
    } as unknown as Env;
    mocks.getCheckoutConfig.mockRejectedValue(new Error("D1 unavailable"));

    const first = await app.request("/api/v1/checkout/config", {}, env);
    const second = await app.request("/api/v1/checkout/config", {}, env);

    expect(first.status).toBe(503);
    expect(second.status).toBe(503);
    expect(first.headers.get("Cache-Control")).toContain("no-store");
    expect(second.headers.get("Cache-Control")).toContain("no-store");
    expect(first.headers.get("X-Cache")).toBe("MISS");
    expect(second.headers.get("X-Cache")).toBe("MISS");
    expect(mocks.getCheckoutConfig).toHaveBeenCalledTimes(2);
    await expect(first.json()).resolves.toMatchObject({
      success: false,
      error: { code: "CHECKOUT_CONFIG_UNAVAILABLE" },
    });
  });
});
