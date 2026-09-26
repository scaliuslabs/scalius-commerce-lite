// The tester's two-tab repro: checkout form-field toggles live on the checkout
// language, so a stale second save must be refused instead of overwriting.
import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

import { errorResponseFromError } from "../utils/api-response";
import { checkoutLanguageRoutes } from "./checkout-languages";

function createApp() {
  const { db } = createSqliteD1Database();
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db);
    await next();
  });
  app.route("/admin/settings/checkout-languages", checkoutLanguageRoutes);
  const env = { CACHE: { id: "kv" } } as unknown as Env;
  return async (method: string, path: string, body?: unknown) => {
    const response = await app.request(`/api/v1/admin/settings/checkout-languages${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    }, env);
    return { status: response.status, body: await response.json() as ResponseBody };
  };
}

interface ResponseBody {
  data: { language: { id: string; revision: number } } & Record<string, unknown>;
  error?: unknown;
}

const ALL_ON = { showOrderNotesField: true, showAreaField: true };

describe("checkout language revision", () => {
  it("refuses the second tab's stale form-field save and keeps the first tab's change", async () => {
    const request = createApp();
    const created = await request("POST", "", {
      name: "English", code: "en", isActive: true, isDefault: true, fieldVisibility: ALL_ON,
    });
    expect(created.status).toBe(201);
    const { id, revision } = created.body.data.language;
    expect(revision).toBe(0);

    // Tab A unticks "Order notes".
    const tabA = await request("PUT", `/${id}`, {
      fieldVisibility: { ...ALL_ON, showOrderNotesField: false },
      expectedRevision: 0,
    });
    expect(tabA.status).toBe(200);
    expect(tabA.body.data.language).toMatchObject({ revision: 1 });

    // Tab B, still showing the old state, unticks "Area".
    const tabB = await request("PUT", `/${id}`, {
      fieldVisibility: { ...ALL_ON, showAreaField: false },
      expectedRevision: 0,
    });
    expect(tabB.status).toBe(409);
    expect(tabB.body.error).toMatchObject({
      code: "SETTINGS_REVISION_CONFLICT",
      details: { document: "checkout_language", expectedRevision: 0, currentRevision: 1 },
    });

    const stored = await request("GET", `/${id}`);
    expect(stored.body.data).toMatchObject({
      revision: 1,
      fieldVisibility: { showOrderNotesField: false, showAreaField: true },
    });

    // Reloaded, tab B's toggle goes on top of tab A's.
    const retried = await request("PUT", `/${id}`, {
      fieldVisibility: { ...ALL_ON, showOrderNotesField: false, showAreaField: false },
      expectedRevision: 1,
    });
    expect(retried.body.data.language).toMatchObject({
      revision: 2,
      fieldVisibility: { showOrderNotesField: false, showAreaField: false },
    });
  });

  it("checks the revision on the active-language switch too, and needs one", async () => {
    const request = createApp();
    const created = await request("POST", "", { name: "বাংলা", code: "bn" });
    const { id } = created.body.data.language;

    expect((await request("PUT", `/${id}`, { isActive: true })).status).toBe(400);
    expect((await request("PUT", `/${id}`, { isActive: true, expectedRevision: 3 })).status).toBe(409);
    const switched = await request("PUT", `/${id}`, { isActive: true, expectedRevision: 0 });
    expect(switched.body.data.language).toMatchObject({ isActive: true, revision: 1 });
    expect((await request("PUT", "/missing", { isActive: true, expectedRevision: 0 })).status).toBe(404);
  });
});
