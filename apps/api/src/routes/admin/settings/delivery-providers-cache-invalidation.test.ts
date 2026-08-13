import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../../utils/api-response";
import { ServiceUnavailableError } from "../../../utils/api-error";

const mocks = vi.hoisted(() => ({
  invalidateApiAndScheduleStorefrontGroups: vi.fn(),
  getCredentialEncryptionKey: vi.fn(),
  requireEncryptionKey: vi.fn(),
  readStoredCredentialStrict: vi.fn(),
  getDeliveryProviders: vi.fn(),
  getDeliveryProvider: vi.fn(),
  saveDeliveryProvider: vi.fn(),
  testDeliveryProvider: vi.fn(),
  createProvider: vi.fn(),
  deleteWhere: vi.fn(),
}));

vi.mock("../../../utils/cache-invalidation", () => ({
  invalidateApiAndScheduleStorefrontGroups: mocks.invalidateApiAndScheduleStorefrontGroups,
}));

vi.mock("../../../utils/encryption-key", () => ({
  getCredentialEncryptionKey: mocks.getCredentialEncryptionKey,
  requireEncryptionKey: mocks.requireEncryptionKey,
}));

vi.mock("@scalius/core/utils/credential-encryption", () => ({
  readStoredCredentialStrict: mocks.readStoredCredentialStrict,
}));

vi.mock("@scalius/core/modules/delivery/delivery.service", () => ({
  getDeliveryProviders: mocks.getDeliveryProviders,
  getDeliveryProvider: mocks.getDeliveryProvider,
  saveDeliveryProvider: mocks.saveDeliveryProvider,
  testDeliveryProvider: mocks.testDeliveryProvider,
}));

vi.mock("@scalius/core/modules/delivery/factory", () => ({
  createProvider: mocks.createProvider,
}));

import { deliveryProvidersRoutes } from "./delivery-providers";

const providerRecord = {
  id: "provider_pathao",
  name: "Pathao",
  type: "pathao",
  credentials: JSON.stringify({
    baseUrl: "https://api-hermes.pathao.com",
    clientId: "pathao-client-4821",
    clientSecret: "pathao-secret-4821",
    username: "merchant-ops-4821",
    password: "PathaoPass-4821",
  }),
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
  mocks.getCredentialEncryptionKey.mockReturnValue("credential-key");
  mocks.requireEncryptionKey.mockReturnValue("credential-key");
  mocks.readStoredCredentialStrict.mockImplementation(async (value: string) => ({
    value,
    encrypted: false,
    error: null,
  }));
  mocks.getDeliveryProviders.mockResolvedValue([providerRecord]);
  mocks.getDeliveryProvider.mockResolvedValue(providerRecord);
  mocks.saveDeliveryProvider.mockResolvedValue(providerRecord);
  mocks.testDeliveryProvider.mockResolvedValue({ success: true, message: "ok" });
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
          credentials: {
            baseUrl: "https://api-hermes.pathao.com",
            clientId: "pathao-client-4821",
            clientSecret: "pathao-secret-4821",
            username: "merchant-ops-4821",
            password: "PathaoPass-4821",
          },
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
        credentials: JSON.stringify({
          baseUrl: "https://api-hermes.pathao.com",
          clientId: "pathao-client-4821",
          clientSecret: "pathao-secret-4821",
          username: "merchant-ops-4821",
          password: "PathaoPass-4821",
        }),
      }),
      "credential-key",
    );
  });

  it("creates omitted-active providers as inactive so setup drafts can be saved", async () => {
    const { app, env } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/settings/delivery-providers",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Pathao",
          type: "pathao",
          credentials: { clientSecret: "secret" },
          config: {},
        }),
      },
      env,
    );

    expect(response.status, await response.clone().text()).toBe(201);
    expect(mocks.saveDeliveryProvider).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ isActive: false }),
      "credential-key",
    );
  });

  it("rejects active providers with incomplete required setup before saving", async () => {
    const { app, env } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/settings/delivery-providers",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Pathao",
          type: "pathao",
          credentials: {
            baseUrl: "https://api-hermes.pathao.com",
            clientSecret: "pathao-secret-4821",
            password: "PathaoPass-4821",
          },
          config: { storeId: "store_1" },
          isActive: true,
        }),
      },
      env,
    );

    expect(response.status, await response.clone().text()).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Delivery provider cannot be activated until required setup is complete.",
        details: {
          blockers: [
            { key: "clientId" },
            { key: "username" },
          ],
        },
      },
    });
    expect(mocks.saveDeliveryProvider).not.toHaveBeenCalled();
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).not.toHaveBeenCalled();
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
          credentials: {
            baseUrl: "https://api-hermes.pathao.com",
            clientId: "pathao-client-4821",
            clientSecret: "••••••••••••",
            username: "merchant-ops-4821",
            password: "••••••••••••",
          },
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
        credentials: JSON.stringify({
          baseUrl: "https://api-hermes.pathao.com",
          clientId: "pathao-client-4821",
          clientSecret: "pathao-secret-4821",
          username: "merchant-ops-4821",
          password: "PathaoPass-4821",
        }),
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
    mocks.readStoredCredentialStrict.mockImplementation(async (value: string) => ({
      value: value === "encrypted-provider-credentials"
        ? JSON.stringify({
          clientSecret: "decrypted-secret",
          clientId: "client-identifier",
          username: "merchant-identity",
          password: "decrypted-pass",
          webhookSecret: "hook-secret",
        })
        : value,
      encrypted: value === "encrypted-provider-credentials",
      error: null,
    }));

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
            clientId: "••••••••••••",
            username: "••••••••••••",
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
          clientId: "client-identifier",
          username: "merchant-identity",
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
    mocks.readStoredCredentialStrict.mockImplementation(async (value: string) => ({
      value: value === "encrypted-provider-credentials"
        ? JSON.stringify({
          clientSecret: "decrypted-secret",
          clientId: "client-identifier",
          username: "merchant-identity",
          password: "decrypted-pass",
          webhookSecret: "hook-secret",
          baseUrl: "https://api-hermes.pathao.com",
          unexpectedAccessToken: "must-not-leave-the-api",
        })
        : value,
      encrypted: value === "encrypted-provider-credentials",
      error: null,
    }));

    const response = await app.request(
      "/api/v1/admin/settings/delivery-providers",
      { method: "GET" },
      env,
    );

    expect(response.status, await response.clone().text()).toBe(200);
    const json = await response.json() as { data: { providers: Array<{ credentials: string; readiness: { status: string } }> } };
    expect(JSON.parse(json.data.providers[0]?.credentials ?? "{}")).toEqual({
      clientSecret: "••••••••••••",
      clientId: "••••••••••••",
      username: "••••••••••••",
      password: "••••••••••••",
      webhookSecret: "••••••••••••",
      baseUrl: "https://api-hermes.pathao.com",
    });
    expect(json.data.providers[0]?.readiness.status).toBe("blocked");
    expect(JSON.stringify(json)).not.toContain("must-not-leave-the-api");
  });

  it("rejects provider objects that exceed the bounded settings shape", async () => {
    const { app, env } = createTestApp();
    const credentials = Object.fromEntries(
      Array.from({ length: 51 }, (_, index) => [`field_${index}`, "value"]),
    );

    const response = await app.request(
      "/api/v1/admin/settings/delivery-providers",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Pathao",
          type: "pathao",
          credentials,
          config: {},
          isActive: false,
        }),
      },
      env,
    );

    expect(response.status).toBe(400);
    expect(mocks.saveDeliveryProvider).not.toHaveBeenCalled();
  });

  it("records existing-provider test attempts and invalidates checkout caches", async () => {
    const { app, env } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/settings/delivery-providers/provider_pathao",
      { method: "POST" },
      env,
    );

    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.clone().json()).resolves.toMatchObject({
      data: { success: true, message: "Connection successful" },
    });
    expect(mocks.testDeliveryProvider).toHaveBeenCalledWith(
      expect.anything(),
      "provider_pathao",
      "credential-key",
    );
    expect(mocks.invalidateApiAndScheduleStorefrontGroups).toHaveBeenCalledWith(
      ["checkout"],
      expect.objectContaining({ env }),
    );
  });

  it("does not return upstream failure details from credential tests", async () => {
    const { app, env } = createTestApp();
    mocks.createProvider.mockResolvedValueOnce({
      testConnection: vi.fn().mockResolvedValue({
        success: false,
        message: "Rejected token secret-provider-token",
      }),
    });

    const response = await app.request(
      "/api/v1/admin/settings/delivery-providers/create-test",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Pathao",
          type: "pathao",
          credentials: { clientSecret: "secret-provider-token" },
          config: {},
        }),
      },
      env,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      data: { success: false, message: "Connection failed" },
    });
    expect(JSON.stringify(body)).not.toContain("secret-provider-token");
  });

  it("does not fall back to JWT_SECRET when encrypted credentials cannot be strict-read", async () => {
    const { app, env } = createTestApp();
    delete (env as Record<string, unknown>).CREDENTIAL_ENCRYPTION_KEY;
    (env as Record<string, unknown>).JWT_SECRET = "legacy-jwt-key";
    mocks.getCredentialEncryptionKey.mockReturnValue(undefined);
    mocks.getDeliveryProviders.mockResolvedValueOnce([
      {
        ...providerRecord,
        credentials: "encrypted-provider-credentials",
      },
    ]);
    mocks.readStoredCredentialStrict.mockResolvedValue({
      value: "",
      encrypted: true,
      error: "Delivery provider credentials is encrypted but CREDENTIAL_ENCRYPTION_KEY is not configured.",
    });

    const response = await app.request(
      "/api/v1/admin/settings/delivery-providers",
      { method: "GET" },
      env,
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.readStoredCredentialStrict).toHaveBeenCalledWith(
      "encrypted-provider-credentials",
      undefined,
      "Delivery provider credentials",
    );
    const json = await response.json() as { data: { providers: Array<{ credentials: string; readiness: { active: boolean } }> } };
    expect(json.data.providers[0]?.credentials).toBe("{}");
    expect(json.data.providers[0]?.readiness.active).toBe(false);
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
          credentials: {
            baseUrl: "https://api-hermes.pathao.com",
            clientId: "pathao-client-4821",
            clientSecret: "pathao-secret-4821",
            username: "merchant-ops-4821",
            password: "PathaoPass-4821",
          },
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
          credentials: {
            baseUrl: "https://api-hermes.pathao.com",
            clientId: "pathao-client-4821",
            clientSecret: "pathao-secret-4821",
            username: "merchant-ops-4821",
            password: "PathaoPass-4821",
          },
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

  it("creates missing providers from update as inactive when isActive is omitted", async () => {
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
          credentials: { clientSecret: "secret" },
          config: {},
        }),
      },
      env,
    );

    expect(response.status, await response.clone().text()).toBe(201);
    expect(mocks.saveDeliveryProvider).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ isActive: false }),
      "credential-key",
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
