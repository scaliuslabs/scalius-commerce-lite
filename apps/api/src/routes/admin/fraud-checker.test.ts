import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
  getFraudProviders: vi.fn(),
  getFraudProvider: vi.fn(),
  saveFraudProvider: vi.fn(),
  deleteFraudProvider: vi.fn(),
  testFraudProvider: vi.fn(),
  fraudLookupWithActiveProvider: vi.fn(),
  assertAppProviderInstalled: vi.fn(),
}));

vi.mock("../../plugins/providers/app-providers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/providers/app-providers")>()),
  assertAppProviderInstalled: mocks.assertAppProviderInstalled,
}));

vi.mock("@scalius/core/modules/fraud-checker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/fraud-checker")>()),
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

  mocks.getFraudProviders.mockResolvedValue([providerRecord]);
  mocks.getFraudProvider.mockResolvedValue(providerRecord);
  mocks.saveFraudProvider.mockResolvedValue(providerRecord);
  mocks.deleteFraudProvider.mockResolvedValue(true);
  mocks.testFraudProvider.mockResolvedValue({ success: true, message: "Connection successful" });
  mocks.fraudLookupWithActiveProvider.mockResolvedValue({
    riskLevel: "low",
    phone: "+8801700000000",
    totalParcels: 1,
    delivered: 1,
    cancelled: 0,
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

  it("passes the credential encryption key and masks provider secrets in list responses", async () => {
    const { app, env } = createTestApp();

    const response = await app.request("/api/v1/admin/fraud-checker", { method: "GET" }, env);

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.getFraudProviders).toHaveBeenCalledWith(
      { id: "db" },
      "credential-key",
      { limit: 21, offset: 0 },
    );
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        providers: [
          {
            apiKey: "••••••••••••",
            apiSecret: "••••••••••••",
            userId: "••••••••••••",
          },
        ],
        pagination: { page: 1, limit: 20, hasMore: false },
      },
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
    expect(mocks.saveFraudProvider).toHaveBeenCalledWith(
      { id: "db" },
      expect.objectContaining({ apiKey: "new-key", apiSecret: "new-secret" }),
      "credential-key",
    );
  });

  it("fails closed before create writes when CREDENTIAL_ENCRYPTION_KEY is missing", async () => {
    const { app, env } = createTestApp();
    delete (env as Record<string, unknown>).CREDENTIAL_ENCRYPTION_KEY;

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

  it("restores masked update secrets through the credential encryption key", async () => {
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
        userId: "••••••••••••",
        isActive: true,
        providerType: "fraudbd",
      }),
    }, env);

    expect(response.status, await response.clone().text()).toBe(200);
    expect(mocks.getFraudProvider).toHaveBeenCalledWith({ id: "db" }, "provider_fraudbd", "credential-key");
    expect(mocks.saveFraudProvider).toHaveBeenCalledWith(
      { id: "db" },
      expect.objectContaining({
        apiKey: "fraudbd-key",
        apiSecret: "fraudbd-password",
        userId: "merchant-user",
      }),
      "credential-key",
    );
  });

  it("fails closed instead of saving masked placeholders when stored credentials are unreadable", async () => {
    const { app, env } = createTestApp();
    mocks.getFraudProvider.mockResolvedValueOnce(null);

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

    expect(response.status, await response.clone().text()).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "Masked fraud checker credentials could not be restored. Re-enter credentials before saving.",
      },
    });
    expect(mocks.saveFraudProvider).not.toHaveBeenCalled();
  });

  it("answers a lookup with no connected service as a state, not a 404", async () => {
    const { app, env } = createTestApp();
    const { NotFoundError } = await import("@scalius/core/errors");
    mocks.fraudLookupWithActiveProvider.mockRejectedValueOnce(
      new NotFoundError("No active fraud checker provider configured"),
    );

    const response = await app.request("/api/v1/admin/fraud-checker/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "+8801700000000" }),
    }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { configured: false } });
  });

  it("projects lookup facts without echoing phone or arbitrary provider fields", async () => {
    const { app, env } = createTestApp();
    mocks.fraudLookupWithActiveProvider.mockResolvedValueOnce({
      status: "checked",
      check: {
        riskLevel: "medium",
        phone: "+8801700000000",
        totalParcels: 12,
        delivered: 9,
        cancelled: 3,
        message: "owner@example.com token=secret",
        providerStatus: "verified",
        arbitrarySecret: "must-not-leave",
      },
    });

    const response = await app.request("/api/v1/admin/fraud-checker/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "+8801700000000" }),
    }, env);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      data: {
        total_parcels: 12,
        provider_status: "verified",
        riskLevel: "medium",
      },
    });
    expect(JSON.stringify(body)).not.toContain("+8801700000000");
    expect(JSON.stringify(body)).not.toContain("owner@example.com");
    expect(JSON.stringify(body)).not.toContain("must-not-leave");
  });

  it("says when the connected checker does not know buyers in the order's country, without asking it", async () => {
    const { app, env } = createTestApp();
    mocks.fraudLookupWithActiveProvider.mockResolvedValueOnce({ status: "country_unsupported", provider: "Acme Radar", countryCode: "US" });

    const response = await app.request("/api/v1/admin/fraud-checker/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "+14155552671", countryCode: "US" }),
    }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { configured: true, unsupportedCountry: { provider: "Acme Radar", countryCode: "US" } },
    });
    expect(mocks.fraudLookupWithActiveProvider).toHaveBeenCalledWith(
      { id: "db" }, "+14155552671", expect.any(String), expect.anything(), { countryCode: "US" },
    );
  });

  it("returns generic connection status instead of upstream provider messages", async () => {
    const { app, env } = createTestApp();
    mocks.testFraudProvider.mockResolvedValueOnce({
      success: false,
      message: "Authorization failed for secret-token",
    });

    const response = await app.request(
      "/api/v1/admin/fraud-checker/provider_fraudbd/test",
      { method: "POST" },
      env,
    );
    const body = await response.json();

    expect(body).toMatchObject({
      data: { success: false, message: "Connection failed" },
    });
    expect(JSON.stringify(body)).not.toContain("secret-token");
  });

  it("rejects provider URLs that can carry credentials or query secrets", async () => {
    const { app, env } = createTestApp();

    const response = await app.request("/api/v1/admin/fraud-checker", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Unsafe",
        apiUrl: "https://user:password@example.com/check?token=secret",
        apiKey: "new-key",
        isActive: false,
      }),
    }, env);

    expect(response.status).toBe(400);
    expect(mocks.saveFraudProvider).not.toHaveBeenCalled();
  });

  it.each([
    "https://127.0.0.1/check",
    "https://localhost/check",
    "https://fraud.internal/check",
    "https://fraud.example.test:8443/check",
  ])("rejects non-public provider URL %s", async (apiUrl) => {
    const { app, env } = createTestApp();

    const response = await app.request("/api/v1/admin/fraud-checker", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Unsafe",
        apiUrl,
        apiKey: "merchant-key",
        isActive: false,
      }),
    }, env);

    expect(response.status).toBe(400);
    expect(mocks.saveFraudProvider).not.toHaveBeenCalled();
  });

  it("does not use JWT_SECRET as the provider read key", async () => {
    const { app, env } = createTestApp();
    delete (env as Record<string, unknown>).CREDENTIAL_ENCRYPTION_KEY;
    (env as Record<string, unknown>).JWT_SECRET = "legacy-jwt-key";

    await app.request("/api/v1/admin/fraud-checker/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "+8801700000000" }),
    }, env);

    expect(mocks.fraudLookupWithActiveProvider).toHaveBeenCalledWith(
      { id: "db" },
      "+8801700000000",
      undefined,
      expect.objectContaining({ resolve: expect.any(Function) }),
      { countryCode: undefined },
    );
  });

  it("saves an installed app's fraud provider as a row without credentials", async () => {
    const { app, env } = createTestApp();
    const appRow = { name: "Acme Radar", providerType: "acme.radar:radar", isActive: true };
    mocks.saveFraudProvider.mockResolvedValueOnce({ id: "row_app", ...appRow, apiUrl: "", apiKey: "" });

    const response = await app.request("/api/v1/admin/fraud-checker", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(appRow),
    }, env);

    expect(response.status, await response.clone().text()).toBe(201);
    expect(mocks.assertAppProviderInstalled).toHaveBeenCalledWith({ id: "db" }, "fraud", "acme.radar:radar");
    expect(mocks.saveFraudProvider).toHaveBeenCalledWith({ id: "db" }, { ...appRow, apiUrl: "", apiKey: "" }, "credential-key");
    await expect(response.json()).resolves.toMatchObject({
      data: { id: "row_app", providerType: "acme.radar:radar", apiUrl: "", apiKey: "", isActive: true },
    });

    const withCredentials = await app.request("/api/v1/admin/fraud-checker", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...appRow, apiKey: "should-live-in-the-app" }),
    }, env);
    expect(withCredentials.status).toBe(400);
  });
});
