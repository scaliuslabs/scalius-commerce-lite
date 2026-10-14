import { OpenAPIHono } from "@hono/zod-openapi";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, describe, expect, it, vi } from "vitest";

import { checkoutLanguageRoutes, publicCheckoutLanguageRoutes } from "./checkout-languages";

const languageRecord = {
  id: "cl_1",
  name: "English",
  code: "en",
  languageData: "{}",
  fieldVisibility: "{}",
  isActive: true,
  isDefault: true,
  revision: 0,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
};

function createTestApp(options: {
  selectedRows?: Array<typeof languageRecord | null>;
  mutationRows?: Array<typeof languageRecord>;
  batchError?: Error;
} = {}) {
  const env = {
  } as unknown as Env;
  const selectedRows = [...(options.selectedRows ?? [])];
  const insertReturning = vi.fn().mockResolvedValue([languageRecord]);
  const updateReturning = vi.fn().mockResolvedValue(options.mutationRows ?? [languageRecord]);
  const updateSet = vi.fn((_values: Record<string, unknown>) => ({
    where: () => ({
      returning: updateReturning,
    }),
  }));
  const deleteReturning = vi.fn().mockResolvedValue(options.mutationRows ?? [languageRecord]);
  const batch = vi.fn(async (statements: unknown[]) => {
    if (options.batchError) throw options.batchError;
    if (statements.length === 2) return [[], [languageRecord]];
    if (statements.length === 3) return [[], [], [languageRecord]];
    throw new Error(`Unexpected batch length ${statements.length}`);
  });
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => c.json(
    { message: error.message },
    (error as { status?: number }).status === 404
      ? 404
      : (error as { status?: number }).status === 409 ? 409 : 500,
  ));
  app.use("*", async (c, next) => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            get: async () => selectedRows.shift() ?? null,
          }),
        }),
      }),
      update: () => ({
        set: updateSet,
      }),
      insert: () => ({
        values: () => ({
          returning: insertReturning,
        }),
      }),
      delete: () => ({
        where: () => ({
          returning: deleteReturning,
        }),
      }),
      batch,
    } as unknown as Database;
    c.set("db", db);
    await next();
  });
  app.route("/checkout-languages", publicCheckoutLanguageRoutes);
  app.route("/admin/settings/checkout-languages", checkoutLanguageRoutes);

  return { app, env, batch, insertReturning, updateReturning, updateSet, deleteReturning };
}

/** The routes over a migrated database: the reads and the batches as the store runs them. */
function createStoreApp(seed = "") {
  const { sqlite, db } = createSqliteD1Database();
  // No checkout copy yet: each test saves the ones it needs.
  sqlite.exec(`DELETE FROM checkout_languages; ${seed}`);
  const env = {} as unknown as Env;
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => c.json({ message: error.message }, (error as { status?: number }).status === 409 ? 409 : 500));
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/checkout-languages", publicCheckoutLanguageRoutes);
  app.route("/admin/settings/checkout-languages", checkoutLanguageRoutes);
  const one = <T>(query: string) => sqlite.prepare(query).get() as T;
  return { app, env, sqlite, one };
}

describe("checkout language route boundaries", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps public checkout-language mutations unregistered", async () => {
    const { app } = createTestApp();

    const createResponse = await app.request("/api/v1/checkout-languages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const updateResponse = await app.request("/api/v1/checkout-languages/cl_1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "English" }),
    });
    const deleteResponse = await app.request("/api/v1/checkout-languages/cl_1", {
      method: "DELETE",
    });
    const restoreResponse = await app.request(
      "/api/v1/checkout-languages/cl_1/restore",
      { method: "POST" },
    );

    expect(createResponse.status).toBe(404);
    expect(updateResponse.status).toBe(404);
    expect(deleteResponse.status).toBe(404);
    expect(restoreResponse.status).toBe(404);
  });

  it("leaves admin checkout-language mutations registered", async () => {
    const { app } = createTestApp();

    const response = await app.request(
      "/api/v1/admin/settings/checkout-languages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );

    expect(response.status).toBe(400);
  });

  it("keeps the active checkout language public read available", async () => {
    const { app } = createStoreApp();

    const response = await app.request("/api/v1/checkout-languages/active");
    const body = await response.json() as {
      success: boolean;
      data?: { language?: { id?: string } };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data?.language?.id).toBe("fallback");
  });

  it("keeps a stored value as the merchant's own wording and fills unset copy from the Bangla preset", async () => {
    const banglaData = JSON.stringify({
      pageTitle: "Cart & Checkout",
      paymentStepText: "Payment",
      checkoutSectionTitle: "Checkout Information",
      customerNameLabel: "ক্রেতার নাম",
    });
    const { app } = createStoreApp(`
      INSERT INTO checkout_languages (id, name, code, language_data, field_visibility, is_active, is_default)
        VALUES ('cl_bn', 'Bangla', 'bn', '${banglaData}', '{}', 1, 1);
      INSERT INTO store_languages (locale, published) VALUES ('bn', 1);
      UPDATE market_presences SET locale = 'bn' WHERE market_id = 'mkt_backup';
    `);

    const response = await app.request("/api/v1/checkout-languages/active");
    const body = await response.json() as {
      data?: { language?: { languageData?: Record<string, string> } };
    };

    expect(response.status).toBe(200);
    // Stored text is the merchant's override, even when it is English; only unset or blank fields take the preset.
    expect(body.data?.language?.languageData).toMatchObject({
      pageTitle: "Cart & Checkout",
      paymentStepText: "Payment",
      checkoutSectionTitle: "Checkout Information",
      customerNameLabel: "ক্রেতার নাম",
      paymentPageTitle: "পেমেন্ট",
      phoneCountryLabelText: "ফোন নম্বরের দেশ",
      emptyCartDescriptionText: "আপনি এখনো কার্টে কোনো পণ্য যোগ করেননি।",
      viewPaymentStatusText: "পেমেন্টের অবস্থা দেখুন",
    });
  });

  it("publishes distinct surface-qualified identities for public and admin active reads", () => {
    const { app } = createTestApp();
    const spec = app.getOpenAPIDocument({
      openapi: "3.0.0",
      info: { title: "Checkout language identity", version: "test" },
    });
    const publicOperation = spec.paths?.["/api/v1/checkout-languages/active"]?.get;
    const adminOperation = spec.paths?.["/api/v1/admin/settings/checkout-languages/active"]?.get;

    expect(publicOperation?.operationId).toBe("storefront.checkout_language.get_active");
    expect(adminOperation?.operationId).toBe("dashboard.checkout_languages.active_get");
    expect(publicOperation?.operationId).not.toBe(adminOperation?.operationId);
    expect(publicOperation?.operationId).toMatch(/^storefront(\.[a-z][a-z0-9_]*){2,}$/);
    expect(adminOperation?.operationId).toMatch(/^dashboard(\.[a-z][a-z0-9_]*){2,}$/);
  });

  it("publishes bounded stable identities for the complete admin language lifecycle", () => {
    const { app } = createTestApp();
    const spec = app.getOpenAPIDocument({
      openapi: "3.0.0",
      info: { title: "Checkout language lifecycle", version: "test" },
    }) as unknown as {
      paths: Record<string, Record<string, {
        operationId?: string;
        requestBody?: { required?: boolean };
        parameters?: Array<{ name?: string; schema?: { maximum?: number } }>;
        responses?: Record<string, { content?: Record<string, { schema?: {
          properties?: { data?: { properties?: { languages?: { maxItems?: number } } } };
        } }> }>;
      }>>;
    };
    const base = "/api/v1/admin/settings/checkout-languages";
    const operations = [
      ["get", base, "dashboard.checkout_languages.list"],
      ["post", base, "dashboard.checkout_languages.create"],
      ["get", `${base}/{id}`, "dashboard.checkout_languages.get"],
      ["put", `${base}/{id}`, "dashboard.checkout_languages.update"],
      ["patch", `${base}/{id}`, "dashboard.checkout_languages.trash"],
      ["delete", `${base}/{id}`, "dashboard.checkout_languages.delete_permanently"],
      ["post", `${base}/{id}/restore`, "dashboard.checkout_languages.restore"],
    ] as const;

    for (const [method, path, operationId] of operations) {
      expect(spec.paths[path]?.[method]?.operationId, `${method} ${path}`).toBe(operationId);
    }
    expect(spec.paths[base]?.post?.requestBody?.required).toBe(true);
    expect(spec.paths[`${base}/{id}`]?.put?.requestBody?.required).toBe(true);
    expect(spec.paths[base]?.get?.parameters?.find(({ name }) => name === "limit")?.schema?.maximum).toBe(10);
    expect(
      spec.paths[base]?.get?.responses?.["200"]?.content?.["application/json"]
        ?.schema?.properties?.data?.properties?.languages?.maxItems,
    ).toBe(10);
  });

  it("returns success after admin checkout-language saves", async () => {
    const { app, env, one } = createStoreApp();

    const response = await app.request(
      "/api/v1/admin/settings/checkout-languages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "English",
          code: "en",
          languageData: {},
          fieldVisibility: {},
          isActive: true,
          isDefault: true,
        }),
      },
      env,
    );

    expect(response.status).toBe(201);
    expect(one<{ active: number }>("SELECT count(*) AS active FROM checkout_languages WHERE is_active = 1 AND is_default = 1 AND code = 'en'").active).toBe(1);
  });

  it("promotes an updated active/default language in one atomic batch, and its language becomes the default", async () => {
    const { app, env, one } = createStoreApp(`
      INSERT INTO checkout_languages (id, name, code, language_data, field_visibility, is_active, is_default, revision) VALUES
        ('cl_en', 'English', 'en', '{}', '{}', 1, 1, 0),
        ('cl_bn', 'Bangla', 'bn', '{}', '{}', 0, 0, 0);
    `);

    const response = await app.request(
      "/api/v1/admin/settings/checkout-languages/cl_bn",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: true, isDefault: true, expectedRevision: 0 }),
      },
      env,
    );

    expect(response.status).toBe(200);
    expect(one<{ id: string }>("SELECT group_concat(id) AS id FROM checkout_languages WHERE is_active = 1").id).toBe("cl_bn");
    expect(one<{ id: string }>("SELECT group_concat(id) AS id FROM checkout_languages WHERE is_default = 1").id).toBe("cl_bn");
    // The copy in use is the default language's (MARKETS-DESIGN D9).
    expect(one<{ locale: string }>("SELECT locale FROM market_presences WHERE market_id = 'mkt_backup'").locale).toBe("bn");
    expect(one<{ published: number }>("SELECT published FROM store_languages WHERE locale = 'bn'").published).toBe(1);
  });

  it("does not reset another winner when an update only turns flags off", async () => {
    const { app, env, batch, updateReturning } = createTestApp({
      selectedRows: [languageRecord],
    });

    const response = await app.request(
      "/api/v1/admin/settings/checkout-languages/cl_1",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: false, isDefault: false, expectedRevision: 0 }),
      },
      env,
    );

    expect(response.status).toBe(200);
    expect(batch).not.toHaveBeenCalled();
    expect(updateReturning).toHaveBeenCalledTimes(1);
  });

  it("preserves active/default flags when a partial update omits them", async () => {
    const { app, env, batch, updateSet } = createTestApp({
      selectedRows: [languageRecord],
    });

    const response = await app.request(
      "/api/v1/admin/settings/checkout-languages/cl_1",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fieldVisibility: { showOrderNotesField: true },
          expectedRevision: 0,
        }),
      },
      env,
    );

    expect(response.status).toBe(200);
    expect(batch).not.toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith(expect.not.objectContaining({
      isActive: expect.anything(),
      isDefault: expect.anything(),
    }));
  });

  it.each([
    ["PATCH", "/api/v1/admin/settings/checkout-languages/missing"],
    ["DELETE", "/api/v1/admin/settings/checkout-languages/missing"],
    ["POST", "/api/v1/admin/settings/checkout-languages/missing/restore"],
  ])("returns 404 when %s targets a missing language", async (method, path) => {
    const { app, env } = createTestApp({ mutationRows: [] });

    const response = await app.request(path, { method }, env);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "Not found" });

  });

  it("returns a conflict when a concurrent promotion reaches the unique fence", async () => {
    const { app, env, sqlite } = createStoreApp(`
      INSERT INTO checkout_languages (id, name, code, language_data, field_visibility, is_active, is_default)
        VALUES ('cl_en', 'English', 'en', '{}', '{}', 1, 1);
    `);
    // Another save promotes its copy between this save's reset and its insert.
    sqlite.exec(`CREATE TRIGGER concurrent_promotion AFTER INSERT ON checkout_languages WHEN NEW.code = 'bn'
      BEGIN UPDATE checkout_languages SET is_active = 1 WHERE id = 'cl_en'; END`);

    const response = await app.request(
      "/api/v1/admin/settings/checkout-languages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Bangla",
          code: "bn",
          isActive: true,
        }),
      },
      env,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      message: "Another checkout language selection was saved at the same time. Reload and try again.",
    });
  });
});
