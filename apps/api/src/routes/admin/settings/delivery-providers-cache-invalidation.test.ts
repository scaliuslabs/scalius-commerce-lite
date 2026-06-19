import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../../utils/api-response";
import { ServiceUnavailableError } from "../../../utils/api-error";

const mocks = vi.hoisted(() => ({
  invalidateApiAndScheduleStorefrontGroups: vi.fn(),
  getEncryptionKey: vi.fn(),
  requireEncryptionKey: vi.fn(),
  decryptCredentialsGraceful: vi.fn(),
  getDeliveryProviders: vi.fn(),
  getDeliveryProvider: vi.fn(),
  saveDeliveryProvider: vi.fn(),
  createProvider: vi.fn(),
  deleteWhere: vi.fn(),
}));

vi.mock("../../../utils/cache-invalidation", () => ({
  invalidateApiAndScheduleStorefrontGroups: mocks.invalidateApiAndScheduleStorefrontGroups,
}));

vi.mock("../../../utils/encryption-key", () => ({
  getEncryptionKey: mocks.getEncryptionKey,
  requireEncryptionKey: mocks.requireEncryptionKey,
}));

vi.mock("@scalius/core/utils/credential-encryption", () => ({
  decryptCredentialsGraceful: mocks.decryptCredentialsGraceful,
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
  mocks.getEncryptionKey.mockReturnValue("read-key");
  mocks.requireEncryptionKey.mockReturnValue("credential-key");
  mocks.decryptCredentialsGraceful.mockImplementation(async (value: string) => value);
  mocks.getDeliveryProviders.mockResolvedValue([providerRecord]);
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
    expect(mocks.requireEncryptionKey).toHaveBeenCalledWith(env);
    expect(mocks.saveDeliveryProvider).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        credentials: JSON.stringify({ clientSecret: "secret", password: "pass" }),
      }),
      "credential-key",
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
    expect(mocks.saveDeliveryProvider).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        credentials: JSON.stringify({ clientSecret: "secret", password: "pass" }),
      }),
      "credential-key",
    );
  });

  it("decrypts encrypted existing credentials before restoring masked update fields", async () => {
    const { app, env } = createTestApp();
    mocks.getDeliveryProvider.mockResolvedValueOnce({
      ...providerRecord,
      credentials: "encrypted-provider-credentials",
    });
    mocks.decryptCredentialsGraceful.mockImplementation(async (value: string) => (
      value === "encrypted-provider-credentials"
        ? JSON.stringify({ clientSecret: "decrypted-secret", password: "decrypted-pass", webhookSecret: "hook-secret" })
        : value
    ));

    const response = await app.request(
      "/api/v1/admin/settings/delivery-providers",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "provider_pathao",
          name: "Pathao",
          type: "pathao",
          credentials: {
            clientSecret: "••••••••••••",
            password: "••••••••••••",
            webhookSecret: "••••••••••••",
          },
          config: { storeId: "store_2" },
          isActive: false,
        }),
      },
      env,
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.saveDeliveryProvider).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        credentials: JSON.stringify({
          clientSecret: "decrypted-secret",
          password: "decrypted-pass",
          webhookSecret: "hook-secret",
        }),
      }),
      "credential-key",
    );
  });

  it("masks decrypted provider credentials in list responses", async () => {
    const { app, env } = createTestApp();
    mocks.getDeliveryProviders.mockResolvedValueOnce([
      {
        ...providerRecord,
        credentials: "encrypted-provider-credentials",
      },
    ]);
    mocks.decryptCredentialsGraceful.mockImplementation(async (value: string) => (
      value === "encrypted-provider-credentials"
        ? JSON.stringify({
          clientSecret: "decrypted-secret",
          password: "decrypted-pass",
          webhookSecret: "hook-secret",
          baseUrl: "https://api-hermes.pathao.com",
        })
        : value
    ));

    const response = await app.request(
      "/api/v1/admin/settings/delivery-providers",
      { method: "GET" },
      env,
    );

    expect(response.status, await response.clone().text()).toBe(200);
    const json = await response.json() as { data: Array<{ credentials: string }> };
    expect(JSON.parse(json.data[0]?.credentials ?? "{}")).toEqual({
      clientSecret: "••••••••••••",
      password: "••••••••••••",
      webhookSecret: "••••••••••••",
      baseUrl: "https://api-hermes.pathao.com",
    });
  });

  it("fails closed before provider creation when CREDENTIAL_ENCRYPTION_KEY is missing", async () => {
    const { app, env } = createTestApp();
    mocks.requireEncryptionKey.mockImplementationOnce(() => {
      throw new ServiceUnavailableError("CREDENTIAL_ENCRYPTION_KEY is required to store provider credentials.");
    });

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

    expect(response.status, await response.clone().text()).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "CREDENTIAL_ENCRYPTION_KEY is required to store provider credentials.",
      },
    });
    expect(mocks.saveDeliveryProvider).not.toHaveBeenCalled();
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).not.toHaveBeenCalled();
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
    expect(mocks.requireEncryptionKey).toHaveBeenCalledWith(env);
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
