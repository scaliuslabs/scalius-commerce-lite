// Metaobject routes on the migrated schema: content types and entries under
// revisions, values validated by the custom-field codec (money in major
// units on the wire, minor units stored), publishing needs required fields,
// an app's types change only through the app, an app's manifest types sync
// on activation, the RBAC map, and the homepage's Metaobjects section reads
// only published entries of a type with storefront access.
import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { getRoutePermission } from "@scalius/core/auth/rbac/route-permissions";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { getHomepageData } from "@scalius/core/modules/storefront";
import { syncAppMetaobjectDefinitions } from "@scalius/core/modules/metaobjects";
import { DEFAULT_STOREFRONT_THEME } from "@scalius/shared/storefront-theme";
import { errorResponseFromError } from "../../utils/api-response";
import { classifyAdminRuntimePath } from "../../runtime/admin-app";
import { adminMetaobjectRoutes } from "./metaobjects";

let sqlite: DatabaseSync;
let db: Database;
let principal: { pluginId: string } | null;

beforeEach(() => {
  ({ sqlite, db } = createSqliteD1Database());
  principal = null;
});
afterEach(() => sqlite.close());

function app() {
  const router = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
  router.use("*", async (c, next) => {
    c.set("db", db as never);
    if (principal) c.set("pluginPrincipal", principal as never);
    await next();
  });
  router.route("/metaobjects", adminMetaobjectRoutes);
  router.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  return router;
}

async function call(method: string, path: string, body?: unknown) {
  const response = await app().request(`/api/v1/admin/metaobjects${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test reads the JSON body freely
  return { status: response.status, body: response.status === 204 ? null : await response.json() as { data: any; error: { code: string; message: string } } };
}

const FAQ = {
  type: "faq",
  name: "FAQ",
  fields: [
    { key: "question", name: "Question", type: "single_line_text", required: true },
    { key: "answer", name: "Answer", type: "multi_line_text", required: true },
    { key: "fee", name: "Fee", type: "money" },
  ],
  storefrontAccess: true,
};

describe("metaobject routes", () => {
  it("creates a content type and entries, validates values and requires fields to publish", async () => {
    const created = await call("POST", "/definitions", FAQ);
    expect(created.status).toBe(201);
    const definition = created.body!.data.definition;
    expect(definition).toMatchObject({ handle: "custom.faq", owner: "merchant", displayField: "question", entryCount: 0, revision: 1 });
    expect((await call("POST", "/definitions", FAQ)).body!.error.code).toBe("METAOBJECT_TYPE_TAKEN");

    const draft = await call("POST", `/definitions/${definition.id}/entries`, { fields: { question: "How long is delivery?", fee: 60 } });
    expect(draft.status).toBe(201);
    expect(draft.body!.data.entry).toMatchObject({ handle: "how-long-is-delivery", status: "draft", displayName: "How long is delivery?", fields: { question: "How long is delivery?", fee: 60 } });
    // Money is stored in minor units.
    expect(sqlite.prepare("SELECT json_extract(fields, '$.fee') AS fee FROM metaobject_entries").get()).toEqual({ fee: "6000" });

    const entry = draft.body!.data.entry;
    const noAnswer = await call("PATCH", `/definitions/${definition.id}/entries/${entry.id}`, { status: "published", expectedRevision: 1 });
    expect(noAnswer.status).toBe(400);
    expect(noAnswer.body!.error.message).toContain("Answer");
    const published = await call("PATCH", `/definitions/${definition.id}/entries/${entry.id}`, { status: "published", fields: { answer: "Two days in Dhaka." }, expectedRevision: 1 });
    expect(published.body!.data.entry).toMatchObject({ status: "published", revision: 2 });
    expect((await call("PATCH", `/definitions/${definition.id}/entries/${entry.id}`, { position: 3, expectedRevision: 1 })).status).toBe(409);
    expect((await call("POST", `/definitions/${definition.id}/entries`, { fields: { unknown: "x" } })).status).toBe(400);
    expect((await call("POST", `/definitions/${definition.id}/entries`, { fields: { fee: "lots" } })).status).toBe(400);

    const list = await call("GET", `/definitions/${definition.id}/entries?status=published`);
    expect(list.body!.data.total).toBe(1);
    // A field type cannot change while entries hold a value of it.
    const retype = await call("PATCH", `/definitions/${definition.id}`, { ...FAQ, type: undefined, expectedRevision: 1, fields: FAQ.fields.map((field) => (field.key === "fee" ? { ...field, type: "integer" } : field)) });
    expect(retype.status).toBe(400);
    expect((await call("DELETE", `/definitions/${definition.id}?expectedRevision=1`)).status).toBe(204);
    expect(sqlite.prepare("SELECT count(*) AS n FROM metaobject_entries").get()).toEqual({ n: 0 });
  });

  it("keeps an app's content types the app's: synced from its manifest, refused to the merchant, written by the app", async () => {
    expect(await syncAppMetaobjectDefinitions(db, "acme.loyalty", [{ ...FAQ, type: "tiers", name: "Tiers" }])).toEqual([]);
    const definition = (await call("GET", "/definitions")).body!.data.items[0];
    expect(definition).toMatchObject({ handle: "acme.loyalty.tiers", owner: "app" });
    const refused = await call("PATCH", `/definitions/${definition.id}`, { name: "Mine", fields: FAQ.fields, storefrontAccess: true, expectedRevision: 1 });
    expect(refused.status).toBe(403);
    expect(refused.body!.error.code).toBe("METAOBJECT_NAMESPACE_FORBIDDEN");
    // Entries are store content: the merchant writes them.
    expect((await call("POST", `/definitions/${definition.id}/entries`, { fields: { question: "Gold?" } })).status).toBe(201);
    // The app, calling as itself, changes its own type and creates in its own namespace.
    principal = { pluginId: "acme.loyalty" };
    expect((await call("PATCH", `/definitions/${definition.id}`, { name: "Member tiers", fields: FAQ.fields, storefrontAccess: false, expectedRevision: 1 })).status).toBe(200);
    expect((await call("POST", "/definitions", { ...FAQ, type: "perks" })).body!.data.definition.handle).toBe("acme.loyalty.perks");
    // A second sync with the same manifest changes nothing; a new name updates it.
    expect(await syncAppMetaobjectDefinitions(db, "acme.loyalty", [{ ...FAQ, type: "tiers", name: "Tiers" }])).toEqual([]);
  });

  it("maps every route to the metaobject permissions and the content runtime", () => {
    expect(getRoutePermission("/api/v1/admin/metaobjects/definitions", "GET")?.permission).toBe(PERMISSIONS.METAOBJECTS_VIEW);
    expect(getRoutePermission("/api/v1/admin/metaobjects/definitions", "POST")?.permission).toBe(PERMISSIONS.METAOBJECTS_EDIT);
    expect(getRoutePermission("/api/v1/admin/metaobjects/definitions/mod_1/entries/moe_1", "PATCH")?.permission).toBe(PERMISSIONS.METAOBJECTS_EDIT);
    expect(getRoutePermission("/api/v1/admin/metaobjects/definitions/mod_1/entries", "GET")?.permission).toBe(PERMISSIONS.METAOBJECTS_VIEW);
    expect(classifyAdminRuntimePath("/api/v1/admin/metaobjects/definitions")).toBe("content");
  });

  it("shows a type's published entries in the homepage's Metaobjects section, only with storefront access", async () => {
    const definition = (await call("POST", "/definitions", FAQ)).body!.data.definition;
    await call("POST", `/definitions/${definition.id}/entries`, { status: "published", fields: { question: "Returns?", answer: "Within 7 days." } });
    await call("POST", `/definitions/${definition.id}/entries`, { fields: { question: "Draft?" } });
    const theme = structuredClone(DEFAULT_STOREFRONT_THEME);
    theme.pages.home = [{ id: "faq", type: "metaobjects", version: 1, settings: { heading: "FAQ", definitionId: definition.id, layout: "accordion", limit: 6 } }];
    sqlite.prepare("INSERT INTO theme_settings (id, colors, revision, created_at, updated_at) VALUES ('default', ?, 1, 1, 1)").run(JSON.stringify(theme));
    const home = await getHomepageData(db);
    expect(home.sections.metaobjects).toEqual([{
      id: definition.id,
      name: "FAQ",
      entries: [{ handle: "returns", title: "Returns?", fields: [{ key: "answer", name: "Answer", type: "multi_line_text", value: "Within 7 days." }] }],
    }]);
    await call("PATCH", `/definitions/${definition.id}`, { name: "FAQ", fields: FAQ.fields, storefrontAccess: false, expectedRevision: 1 });
    expect((await getHomepageData(db)).sections.metaobjects).toEqual([]);
  });
});
