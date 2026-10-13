// The couriers settings routes: every courier is an app's, so a row names
// `<plugin id>:<provider id>` and never takes keys; a row that still names a
// retired built-in reads as blocked with the Bangladesh pack's reason.
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({
  getCredentialEncryptionKey: vi.fn(),
  getDeliveryProviders: vi.fn(),
  getDeliveryProvider: vi.fn(),
  saveDeliveryProvider: vi.fn(),
  testDeliveryProvider: vi.fn(),
  deleteWhere: vi.fn(),
}));

vi.mock("../../../utils/encryption-key", () => ({
  getCredentialEncryptionKey: mocks.getCredentialEncryptionKey,
}));

vi.mock("@scalius/core/modules/delivery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/delivery")>()),
  getDeliveryProviders: mocks.getDeliveryProviders,
  getDeliveryProvider: mocks.getDeliveryProvider,
  saveDeliveryProvider: mocks.saveDeliveryProvider,
  testDeliveryProvider: mocks.testDeliveryProvider,
}));

// No courier app is active in these requests.
vi.mock("../../../plugins/providers/courier", async () => {
  const { createCourierProviders } = await import("@scalius/core/modules/delivery");
  return { requestCourierProviders: () => async () => createCourierProviders() };
});

import { deliveryProvidersRoutes } from "./delivery-providers";

const row = (overrides: Record<string, unknown> = {}) => ({
  id: "provider_parcel",
  name: "Parcel",
  type: "acme.parcel:parcel",
  credentials: "{}",
  config: "{}",
  isActive: false,
  lastTestAttemptAt: null,
  lastTestSuccessAt: null,
  lastTestFailureAt: null,
  lastTestSuccessFingerprint: null,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

function createTestApp() {
  const env = {} as unknown as Env;
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  mocks.getCredentialEncryptionKey.mockReturnValue("credential-key");
  mocks.getDeliveryProviders.mockResolvedValue([row()]);
  mocks.getDeliveryProvider.mockResolvedValue(row());
  mocks.saveDeliveryProvider.mockResolvedValue(row());
  mocks.testDeliveryProvider.mockResolvedValue({ success: true, message: "ok" });
  mocks.deleteWhere.mockResolvedValue(undefined);
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", { delete: () => ({ where: mocks.deleteWhere }) } as never);
    await next();
  });
  app.route("/admin/settings/delivery-providers", deliveryProvidersRoutes);
  return { app, env };
}

const post = (app: OpenAPIHono<{ Bindings: Env }>, env: Env, body: unknown, path = "") =>
  app.request(`/api/v1/admin/settings/delivery-providers${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, env);

describe("couriers settings routes", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("adds an app courier by its id and nothing else", async () => {
    const { app, env } = createTestApp();
    const response = await post(app, env, { name: "Parcel", type: "acme.parcel:parcel" });
    expect(response.status, await response.clone().text()).toBe(201);
    expect(mocks.saveDeliveryProvider).toHaveBeenCalledWith(
      expect.anything(),
      { id: "", name: "Parcel", type: "acme.parcel:parcel", isActive: false },
      "credential-key",
      expect.any(Function),
    );
    expect(await response.json()).toMatchObject({ data: { type: "acme.parcel:parcel", courierName: "acme.parcel:parcel" } });
  });

  it("refuses keys on the row, built-in types and malformed ids before touching storage", async () => {
    const { app, env } = createTestApp();
    for (const body of [
      { name: "Parcel", type: "acme.parcel:parcel", credentials: { apiKey: "x" } },
      { name: "Pathao", type: "pathao", credentials: {}, config: {} },
      { name: "Steadfast", type: "steadfast" },
      { name: "Unknown", type: "unknown" },
    ]) {
      expect((await post(app, env, body)).status).toBe(400);
    }
    expect(mocks.saveDeliveryProvider).not.toHaveBeenCalled();
  });

  it("publishes the app courier id as the only type, with no credential fields", () => {
    const { app } = createTestApp();
    const document = app.getOpenAPIDocument({ openapi: "3.1.0", info: { title: "Delivery provider contract", version: "test" } });
    const serialized = JSON.stringify(document.paths?.["/api/v1/admin/settings/delivery-providers"]?.post?.requestBody);
    expect(serialized).toContain("<plugin id>:<provider id>");
    expect(serialized).not.toMatch(/clientSecret|apiKey|"pathao"|"steadfast"/);
    expect(document.paths?.["/api/v1/admin/settings/delivery-providers/create-test"]).toBeUndefined();
  });

  it("lists a retired courier's row as blocked with the Bangladesh pack's reason, never its keys", async () => {
    const { app, env } = createTestApp();
    mocks.getDeliveryProviders.mockResolvedValue([row({ id: "provider_pathao", name: "Pathao", type: "pathao", isActive: true, credentials: "enc:v1:sealed-old-keys" })]);
    const response = await app.request("/api/v1/admin/settings/delivery-providers", {}, env);
    expect(response.status).toBe(200);
    const json = await response.json() as { data: { providers: Array<Record<string, unknown>> } };
    expect(json.data.providers[0]).toMatchObject({
      type: "pathao",
      courierName: "Pathao",
      countries: ["BD"],
      readiness: {
        active: false,
        canCreateShipment: false,
        issues: [{ code: "unconfigured", message: "Activate Bangladesh pack in Apps to use it." }],
      },
    });
    expect(JSON.stringify(json)).not.toContain("sealed-old-keys");
  });

  it("tests a saved courier and answers only whether it passed", async () => {
    const { app, env } = createTestApp();
    mocks.testDeliveryProvider.mockResolvedValueOnce({ success: false, message: "Upstream said SENSITIVE-DETAIL" });
    const response = await post(app, env, {}, "/provider_parcel");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { success: false, message: "Connection failed" } });
    expect(mocks.testDeliveryProvider).toHaveBeenCalledWith(expect.anything(), "provider_parcel", "credential-key", expect.any(Function));
  });
});
