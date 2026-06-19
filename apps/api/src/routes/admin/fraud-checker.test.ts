import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ServiceUnavailableError } from "../../utils/api-error";
import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
  getEncryptionKey: vi.fn(),
  requireEncryptionKey: vi.fn(),
  getFraudProviders: vi.fn(),
  getFraudProvider: vi.fn(),
  saveFraudProvider: vi.fn(),
  deleteFraudProvider: vi.fn(),
  testFraudProvider: vi.fn(),
  fraudLookupWithActiveProvider: vi.fn(),
}));

vi.mock("../../utils/encryption-key", () => ({
  getEncryptionKey: mocks.getEncryptionKey,
  requireEncryptionKey: mocks.requireEncryptionKey,
}));

vi.mock("@scalius/core/modules/fraud-checker/fraud-checker.service", () => ({
  getFraudProviders: mocks.getFraudProviders,
  getFraudProvider: mocks.getFraudProvider,
  saveFraudProvider: mocks.saveFraudProvider,
  deleteFraudProvider: mocks.deleteFraudProvider,
  testFraudProvider: mocks.testFraudProvider,
  fraudLookupWithActiveProvider: mocks.fraudLookupWithActiveProvider,
}));

import { adminFraudCheckerRoutes } from "./fraud-checker";

const providerRecord = {
  id: "provider_fraudbd",
  name: "FraudBD",
  apiUrl: "https://fraudbd.example/api",
  apiKey: "fraudbd-key",
  apiSecret: "fraudbd-password",
  userId: "merchant-user",
  isActive: true,
  providerType: "fraudbd",
};

function createTestApp() {
  const env = {
    CREDENTIAL_ENCRYPTION_KEY: "credential-key",
    JWT_SECRET: "legacy-key",
  } as unknown as Env;
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");

  mocks.getEncryptionKey.mockReturnValue("read-key");
  mocks.requireEncryptionKey.mockReturnValue("credential-key");
  mocks.getFraudProviders.mockResolvedValue([providerRecord]);
  mocks.getFraudProvider.mockResolvedValue(providerRecord);
  mocks.saveFraudProvider.mockResolvedValue(providerRecord);
  mocks.deleteFraudProvider.mockResolvedValue(true);
  mocks.testFraudProvider.mockResolvedValue({ success: true, message: "Connection successful" });
  mocks.fraudLookupWithActiveProvider.mockResolvedValue({
    success: true,
    riskLevel: "low",
    data: { mobile_number: "+8801700000000", total_parcels: 1, total_delivered: 1, total_cancel: 0 },
  });

  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", { id: "db" } as never);
    await next();
  });
  app.route("/fraud-checker", adminFraudCheckerRoutes);
  return { app, env };
}

describe("admin fraud checker credential handling", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes the read encryption key and masks provider secrets in list responses", async () => {
    const { app, env } = createTestApp();

    const response = await app.request("/api/v1/admin/fraud-checker", { method: "GET" }, env);

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.getFraudProviders).toHaveBeenCalledWith({ id: "db" }, "read-key");
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: [
        {
          apiKey: "••••••••••••",
          apiSecret: "••••••••••••",
          userId: "merchant-user",
        },
      ],
    });
  });

  it("requires the credential encryption key before creating providers", async () => {
    const { app, env } = createTestApp();

    const response = await app.request("/api/v1/admin/fraud-checker", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "FraudBD",
        apiUrl: "https://fraudbd.example/api",
        apiKey: "new-key",
        apiSecret: "new-secret",
        userId: "merchant-user",
        isActive: true,
        providerType: "fraudbd",
      }),
    }, env);

    expect(response.status, await response.clone().text()).toBe(201);
    expect(mocks.requireEncryptionKey).toHaveBeenCalledWith(env);
    expect(mocks.saveFraudProvider).toHaveBeenCalledWith(
      { id: "db" },
      expect.objectContaining({ apiKey: "new-key", apiSecret: "new-secret" }),
      "credential-key",
    );
  });

  it("fails closed before create writes when CREDENTIAL_ENCRYPTION_KEY is missing", async () => {
    const { app, env } = createTestApp();
    mocks.requireEncryptionKey.mockImplementationOnce(() => {
      throw new ServiceUnavailableError("CREDENTIAL_ENCRYPTION_KEY is required to store provider credentials.");
    });

    const response = await app.request("/api/v1/admin/fraud-checker", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "FraudBD",
        apiUrl: "https://fraudbd.example/api",
        apiKey: "new-key",
        apiSecret: "new-secret",
        userId: "merchant-user",
        isActive: true,
        providerType: "fraudbd",
      }),
    }, env);

    expect(response.status, await response.clone().text()).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "CREDENTIAL_ENCRYPTION_KEY is required to store provider credentials.",
      },
    });
    expect(mocks.saveFraudProvider).not.toHaveBeenCalled();
  });

  it("restores masked update secrets through the read encryption key", async () => {
    const { app, env } = createTestApp();

    const response = await app.request("/api/v1/admin/fraud-checker", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "provider_fraudbd",
        name: "FraudBD",
        apiUrl: "https://fraudbd.example/api",
        apiKey: "••••••••••••",
        apiSecret: "••••••••••••",
        userId: "merchant-user",
        isActive: true,
        providerType: "fraudbd",
      }),
    }, env);

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.getFraudProvider).toHaveBeenCalledWith({ id: "db" }, "provider_fraudbd", "read-key");
    expect(mocks.saveFraudProvider).toHaveBeenCalledWith(
      { id: "db" },
      expect.objectContaining({ apiKey: "fraudbd-key", apiSecret: "fraudbd-password" }),
      "credential-key",
    );
  });

  it("uses the read encryption key for provider tests and manual lookups", async () => {
    const { app, env } = createTestApp();

    await app.request("/api/v1/admin/fraud-checker/provider_fraudbd/test", { method: "POST" }, env);
    await app.request("/api/v1/admin/fraud-checker/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "+8801700000000" }),
    }, env);

    expect(mocks.testFraudProvider).toHaveBeenCalledWith({ id: "db" }, "provider_fraudbd", "read-key");
    expect(mocks.fraudLookupWithActiveProvider).toHaveBeenCalledWith({ id: "db" }, "+8801700000000", "read-key");
  });
});
