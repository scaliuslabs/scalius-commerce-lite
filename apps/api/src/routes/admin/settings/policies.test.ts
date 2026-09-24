import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { createPage, createPageSchema } from "@scalius/core/modules/pages";
import { resolvePublicStorePolicies } from "@scalius/core/modules/settings/store-policies.service";

import { errorResponseFromError } from "../../../utils/api-response";

const mocks = vi.hoisted(() => ({ bumpCacheGeneration: vi.fn(async () => undefined) }));
vi.mock("../../../utils/cache-generation", () => ({ bumpCacheGeneration: mocks.bumpCacheGeneration }));

import { storePoliciesRoutes } from "./policies";

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
  app.route("/admin/settings", storePoliciesRoutes);
  const request = (body?: unknown) => app.request("/api/v1/admin/settings/policies", body === undefined
    ? {}
    : { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const page = (slug: string, isPublished: boolean) =>
    createPage(database.db, createPageSchema.parse({ title: `Policy ${slug}`, slug, content: "<p>Text</p>", metaTitle: null, metaDescription: null, isPublished }), { canPublish: true });
  return { db: database.db, request, page };
}

describe("store policies", () => {
  beforeEach(() => vi.clearAllMocks());

  it("links policies to the store's own pages under the revision it loaded", async () => {
    const { request, page } = createApp();
    const refund = await page("refund-policy", false);

    await expect((await request()).json()).resolves.toMatchObject({
      data: { refund: null, privacy: null, terms: null, shipping: null, contact: null, revision: 0 },
    });

    const saved = await request({ refund: refund.id, expectedRevision: 0 });
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({ data: { refund: refund.id, revision: 1 } });
    expect(mocks.bumpCacheGeneration).toHaveBeenCalledOnce();

    // A tab still holding revision 0 can't overwrite it.
    const stale = await request({ refund: null, expectedRevision: 0 });
    expect(stale.status).toBe(409);
    await expect((await request()).json()).resolves.toMatchObject({ data: { refund: refund.id, revision: 1 } });
  });

  it("refuses a page that isn't one of the store's pages, against its field", async () => {
    const { request } = createApp();

    const response = await request({ privacy: "page_missing", expectedRevision: 0 });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { details: { issues: [{ path: ["privacy"], message: "Choose one of your store's pages." }] } },
    });
    expect(mocks.bumpCacheGeneration).not.toHaveBeenCalled();
  });

  it("shows buyers only the linked pages that are published, in policy order", async () => {
    const { db, page } = createApp();
    const terms = await page("terms-of-service", true);
    const refund = await page("refund-policy", true);
    const draft = await page("privacy-policy", false);

    await expect(resolvePublicStorePolicies(db, {
      refund: refund.id,
      privacy: draft.id,
      terms: terms.id,
      shipping: null,
      contact: null,
    })).resolves.toEqual([
      { kind: "refund", title: "Policy refund-policy", path: "/refund-policy" },
      { kind: "terms", title: "Policy terms-of-service", path: "/terms-of-service" },
    ]);
  });
});
