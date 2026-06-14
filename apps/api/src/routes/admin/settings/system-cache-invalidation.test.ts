import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({
  getKv: vi.fn(),
  invalidateSiteSettingsCache: vi.fn(),
  invalidateApiAndStorefrontGroups: vi.fn(),
  upsertEncryptedSetting: vi.fn(),
}));

vi.mock("../../../utils/kv-cache", () => ({
  getKv: mocks.getKv,
}));

vi.mock("@scalius/core/modules/settings", () => ({
  invalidateSiteSettingsCache: mocks.invalidateSiteSettingsCache,
}));

vi.mock("../../../utils/cache-invalidation", () => ({
  invalidateApiAndStorefrontGroups: mocks.invalidateApiAndStorefrontGroups,
}));

vi.mock("@scalius/core/modules/payments/gateway-settings", () => ({
  upsertEncryptedSetting: mocks.upsertEncryptedSetting,
}));

import { systemSettingsRoutes } from "./system";

function createDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        limit: vi.fn(async () => [{ id: "site_settings_1" }]),
        where: vi.fn(() => ({
          get: vi.fn(async () => null),
          all: vi.fn(async () => []),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => undefined),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn(async () => undefined),
      })),
    })),
  };
}

function createTestApp() {
  const kv = { delete: vi.fn() };
  const env = {
    CACHE: {
      id: "api-cache-kv",
      put: vi.fn(async () => undefined),
    },
    PURGE_URL: "https://storefront.example.com/api/purge-cache",
    PURGE_TOKEN: "secret-token",
  } as unknown as Env;
  const executionCtx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  };
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");

  mocks.getKv.mockReturnValue(kv);
  mocks.invalidateSiteSettingsCache.mockResolvedValue(undefined);
  mocks.invalidateApiAndStorefrontGroups.mockResolvedValue(undefined);

  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", createDb() as never);
    await next();
  });
  app.route("/admin/settings", systemSettingsRoutes);

  return { app, env, executionCtx, kv };
}

function requestJson(
  app: OpenAPIHono<{ Bindings: Env }>,
  env: Env,
  executionCtx: { waitUntil: ReturnType<typeof vi.fn>; passThroughOnException: ReturnType<typeof vi.fn> },
  path: string,
  body: unknown,
) {
  return app.request(
    `/api/v1/admin/settings${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
    executionCtx as never,
  );
}

describe("system settings cache invalidation", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("invalidates checkout caches after auth and checkout settings save", async () => {
    const { app, env, executionCtx, kv } = createTestApp();

    const response = await requestJson(app, env, executionCtx, "/auth", {
      authVerificationMethod: "email",
      guestCheckoutEnabled: true,
      checkoutMode: "all",
      partialPaymentEnabled: true,
      partialPaymentAmount: 500,
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.invalidateSiteSettingsCache).toHaveBeenCalledWith(kv);
    expect(mocks.invalidateApiAndStorefrontGroups).toHaveBeenCalledWith(["checkout"], env);
  });

  it("invalidates layout caches after CSP security settings save", async () => {
    const { app, env, executionCtx } = createTestApp();

    const response = await requestJson(app, env, executionCtx, "/security", {
      cspAllowedDomains: "https://payments.example.com",
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateApiAndStorefrontGroups).toHaveBeenCalledWith(["layout"], env);
  });
});
