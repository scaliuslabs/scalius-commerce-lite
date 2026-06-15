import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({
  invalidateApiAndScheduleStorefrontGroups: vi.fn(),
  getDeliveryProviders: vi.fn(),
  getDeliveryProvider: vi.fn(),
  saveDeliveryProvider: vi.fn(),
  createProvider: vi.fn(),
  deleteWhere: vi.fn(),
}));

vi.mock("../../../utils/cache-invalidation", () => ({
  invalidateApiAndScheduleStorefrontGroups: mocks.invalidateApiAndScheduleStorefrontGroups,
}));

vi.mock("@scalius/core/modules/delivery/delivery.service", () => ({
  getDeliveryProviders: mocks.getDeliveryProviders,
  getDeliveryProvider: mocks.getDeliveryProvider,
  saveDeliveryProvider: mocks.saveDeliveryProvider,
}));

vi.mock("@scalius/core/modules/delivery/factory", () => ({
  createProvider: mocks.createProvider,
}));

import { deliveryProvidersRoutes } from "./delivery-providers";

const providerRecord = {
  id: "provider_pathao",
  name: "Pathao",
  type: "pathao",
  credentials: JSON.stringify({ clientSecret: "secret", password: "pass" }),
  config: JSON.stringify({ storeId: "store_1" }),
  isActive: true,
  createdAt: 1,
  updatedAt: 1,
};

function createDb() {
  return {
    delete: () => ({
      where: mocks.deleteWhere,
    }),
  };
}

function createTestApp() {
  const env = {
    CACHE: { id: "api-cache-kv" },
    CREDENTIAL_ENCRYPTION_KEY: "credential-secret",
    PURGE_URL: "https://storefront.example.com/api/purge-cache",
    PURGE_TOKEN: "secret-token",
  } as unknown as Env;
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");

  mocks.invalidateApiAndScheduleStorefrontGroups.mockResolvedValue(undefined);
  mocks.getDeliveryProvider.mockResolvedValue(providerRecord);
  mocks.saveDeliveryProvider.mockResolvedValue(providerRecord);
  mocks.deleteWhere.mockResolvedValue(undefined);

  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", createDb() as never);
    await next();
  });
  app.route("/admin/settings/delivery-providers", deliveryProvidersRoutes);
  return { app, env };
}

describe("delivery provider cache invalidation", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("invalidates checkout caches after provider creation", async () => {
    const { app, env } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/settings/delivery-providers",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Pathao",
          type: "pathao",
          credentials: { clientSecret: "secret", password: "pass" },
          config: { storeId: "store_1" },
          isActive: true,
        }),
      },
      env,
    );

    expect(response.status).toBe(201);
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
      ["checkout"],
      expect.objectContaining({ env }),
    );
  });

  it("invalidates checkout caches after provider updates", async () => {
    const { app, env } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/settings/delivery-providers",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "provider_pathao",
          name: "Pathao",
          type: "pathao",
          credentials: { clientSecret: "••••••••••••", password: "••••••••••••" },
          config: { storeId: "store_2" },
          isActive: false,
        }),
      },
      env,
    );

    expect(response.status).toBe(200);
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
      ["checkout"],
      expect.objectContaining({ env }),
    );
  });

  it("invalidates checkout caches after update creates a missing provider", async () => {
    const { app, env } = createTestApp();
    mocks.getDeliveryProvider.mockResolvedValueOnce(null);

    const response = await app.request(
      "/api/v1/admin/settings/delivery-providers",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "provider_pathao",
          name: "Pathao",
          type: "pathao",
          credentials: { clientSecret: "secret", password: "pass" },
          config: { storeId: "store_1" },
          isActive: true,
        }),
      },
      env,
    );

    expect(response.status).toBe(201);
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
      ["checkout"],
      expect.objectContaining({ env }),
    );
  });

  it("invalidates checkout caches after provider deletion", async () => {
    const { app, env } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/settings/delivery-providers/provider_pathao",
      { method: "DELETE" },
      env,
    );

    expect(response.status).toBe(200);
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
      ["checkout"],
      expect.objectContaining({ env }),
    );
  });
});
