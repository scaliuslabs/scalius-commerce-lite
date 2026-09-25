// Two staff members editing the same settings: the second, stale save is
// refused with 409 SETTINGS_REVISION_CONFLICT and overwrites nothing.
import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

const mocks = vi.hoisted(() => ({ bumpCacheGeneration: vi.fn() }));
vi.mock("../../../utils/cache-generation", () => ({ bumpCacheGeneration: mocks.bumpCacheGeneration }));

import { errorResponseFromError } from "../../../utils/api-response";
import { adminSettingsRoutes } from "../settings";

const CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

function createApp() {
  const database = createSqliteD1Database();
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", database.db);
    await next();
  });
  app.route("/admin/settings", adminSettingsRoutes);
  const env = { CREDENTIAL_ENCRYPTION_KEY, CACHE: { delete: vi.fn(), put: vi.fn(), get: vi.fn(async () => null) } } as unknown as Env;
  const request = async (method: "GET" | "POST" | "PUT", path: string, body?: unknown) => {
    const response = await app.request(`/api/v1/admin/settings${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    }, env);
    return { status: response.status, body: await response.json() as { data?: Record<string, unknown>; error?: Record<string, unknown> } };
  };
  const revision = (category: string) =>
    (database.sqlite.prepare("SELECT revision FROM settings WHERE key = 'document' AND category = ?").get(category) as
      | { revision: number }
      | undefined)?.revision ?? 0;
  return { request, revision };
}

describe("settings revision contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bumpCacheGeneration.mockResolvedValue(undefined);
  });

  it("business details: the second tab's stale save is refused and the first tab's change stays", async () => {
    const { request } = createApp();
    const opened = await request("GET", "/business");
    expect(opened.body.data).toMatchObject({ revision: 0, companyName: "" });

    const tabA = await request("POST", "/business", { companyName: "Tab A", expectedRevision: 0 });
    expect(tabA.status).toBe(200);
    expect(tabA.body.data).toMatchObject({ companyName: "Tab A", revision: 1 });

    const tabB = await request("POST", "/business", { legalName: "Tab B Ltd", expectedRevision: 0 });
    expect(tabB.status).toBe(409);
    expect(tabB.body.error).toMatchObject({
      code: "SETTINGS_REVISION_CONFLICT",
      details: { document: "business", expectedRevision: 0, currentRevision: 1 },
    });
    expect(mocks.bumpCacheGeneration).toHaveBeenCalledOnce();

    const latest = await request("GET", "/business");
    expect(latest.body.data).toMatchObject({ companyName: "Tab A", legalName: "", revision: 1 });

    // Reloaded at the latest revision, the second tab's edit saves on top.
    const retried = await request("POST", "/business", { legalName: "Tab B Ltd", expectedRevision: 1 });
    expect(retried.body.data).toMatchObject({ companyName: "Tab A", legalName: "Tab B Ltd", revision: 2 });
  });

  it("a save needs the revision it was loaded at", async () => {
    const { request, revision } = createApp();
    expect((await request("POST", "/business", { companyName: "No revision" })).status).toBe(400);
    expect((await request("PUT", "/checkout-flow", {
      guestCheckoutEnabled: true,
      checkoutMode: "all",
      partialPaymentEnabled: false,
      partialPaymentAmount: 0,
    })).status).toBe(400);
    expect(revision("business")).toBe(0);
  });

  it("customer sign-in: credentials and policy commit together, or not at all", async () => {
    const { request, revision } = createApp();
    const opened = await request("GET", "/auth");
    expect(opened.body.data?.revision).toEqual({ customerAuth: 0, whatsapp: 0 });

    // Tab A replaces the WhatsApp credentials.
    const tabA = await request("POST", "/auth", {
      expectedRevision: { whatsapp: 0 },
      whatsappAccessToken: "EAAG_tab_a_token",
      whatsappPhoneNumberId: "phone_id_a",
      whatsappTemplateName: "auth_otp",
    });
    expect(tabA.status).toBe(200);
    expect(tabA.body.data?.revision).toEqual({ customerAuth: 0, whatsapp: 1 });

    // Tab B, still on the old credentials, saves new credentials and a policy
    // that depends on them: refused as a whole.
    const tabB = await request("POST", "/auth", {
      expectedRevision: { customerAuth: 0, whatsapp: 0 },
      customerIdentity: { email: "optional", whatsapp: "same_as_phone", channels: ["whatsapp"] },
      whatsappAccessToken: "EAAG_tab_b_token",
      whatsappPhoneNumberId: "phone_id_b",
      whatsappTemplateName: "auth_otp",
    });
    expect(tabB.status).toBe(409);
    expect(tabB.body.error).toMatchObject({
      code: "SETTINGS_REVISION_CONFLICT",
      details: { document: "whatsapp", expectedRevision: 0, currentRevision: 1 },
    });
    // The policy, whose own revision still matched, was not written either.
    expect(revision("customer_auth")).toBe(0);
    expect((await request("GET", "/auth")).body.data).toMatchObject({
      revision: { customerAuth: 0, whatsapp: 1 },
      whatsappPhoneNumberId: "phone_id_a",
    });

    // A document the save touches must carry its revision.
    expect((await request("POST", "/auth", {
      expectedRevision: { whatsapp: 1 },
      customerIdentity: { email: "optional", whatsapp: "same_as_phone", channels: ["whatsapp"] },
    })).status).toBe(400);
  });
});
