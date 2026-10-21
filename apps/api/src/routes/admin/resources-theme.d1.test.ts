// The stable app API's theme draft writes (`theme.get`, `theme.apply_template`,
// `theme.section_settings_set`): an app applies only its own template, its
// catalogue handles resolve against the store (a section naming a missing one
// is left out), the replaced draft is kept as a restore point, and every write
// holds the draft revisions it read.
import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { errorResponseFromError } from "../../utils/api-response";

const TEMPLATE = {
  sections: [
    { id: "tiles", type: "category_tiles", version: 1, settings: { style: "round", title: "Shop", categoryIds: ["@category:laptops", "@category:phones"] } },
    { id: "deals", type: "product_rail", version: 1, settings: { title: "Hot deals", source: { kind: "collection", handle: "hot-deals" }, limit: 8 } },
    { id: "gone", type: "product_rail", version: 1, settings: { title: "Tablets", source: { kind: "category", handle: "tablets" }, limit: 8 } },
  ],
};

const installations = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock("@scalius/core/modules/plugins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/plugins")>()),
  listPluginInstallations: async () => installations.list,
}));

const { adminResourceThemeRoutes } = await import("./resources-theme");

let sqlite: DatabaseSync;
let db: Database;

function installation(pluginId: string, templateId: string) {
  return {
    pluginId,
    status: "active",
    grant: { storefrontSurfaces: true, storefrontCode: true },
    manifest: { name: pluginId, storefront: { templates: [{ id: templateId, name: "Look", themeVersion: 12, theme: { sections: TEMPLATE.sections } }], pagePresets: [] } },
  };
}

beforeEach(() => {
  ({ sqlite, db } = createSqliteD1Database());
  sqlite.exec(`INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1);
    INSERT INTO categories (id, name, slug, status) VALUES ('cat_laptops', 'Laptops', 'laptops', 'published'), ('cat_phones', 'Phones', 'phones', 'published');
    INSERT INTO collections (id, name, slug, presentation, config) VALUES ('col_hot', 'Hot deals', 'hot-deals', 'grid', '{"source":"manual","productIds":[]}');`);
  installations.list = [installation("acme.look", "volt"), installation("other.app", "rival")];
});
afterEach(() => sqlite.close());

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions inspect the wire envelope.
type Wire = { status: number; body: { data: any; error: { code: string; message: string } } };

async function call(method: string, path: string, body?: unknown, plugin: string | null = "acme.look"): Promise<Wire> {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    c.set("user", { id: "owner", name: "Owner", email: "owner@shop.test" } as never);
    if (plugin) c.set("pluginPrincipal" as never, { pluginId: plugin, permissions: new Set(["settings.theme.edit"]) } as never);
    await next();
  });
  app.route("/resources", adminResourceThemeRoutes);
  app.onError((error, c) => { const { body: errorBody, status } = errorResponseFromError(error); return c.json(errorBody, status); });
  const response = await app.request(`/api/v1/admin/resources${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, {} as never);
  return { status: response.status, body: await response.json() as Wire["body"] };
}

const read = async () => (await call("GET", "/theme")).body.data.theme;

describe("theme.apply_template", () => {
  it("applies the app's own template with its handles resolved, leaving out the section naming a missing one", async () => {
    const before = await read();
    expect(before.draft).toMatchObject({ revision: 0, basePublishedRevision: 0 });
    const applied = await call("POST", "/theme/apply-template", { template: "volt", expectedDraftRevision: 0, basePublishedRevision: 0 });
    expect(applied.status).toBe(200);
    expect(applied.body.data.template).toBe("acme.look/volt");
    expect(applied.body.data.unresolved).toEqual([{ kind: "category", handle: "tablets", sectionId: "gone" }]);
    const after = await read();
    expect(after.template).toBe("acme.look/volt");
    expect(after.sections.map((section: { id: string }) => section.id)).toEqual(["tiles", "deals"]);
    expect(after.sections[0].settings.categoryIds).toEqual(["cat_laptops", "cat_phones"]);
    expect(after.sections[1].settings.source).toEqual({ kind: "collection", collectionId: "col_hot" });

    // Applied again over a saved draft: the draft it replaces becomes a restore point.
    const again = await call("POST", "/theme/apply-template", { template: "acme.look/volt", ...{ expectedDraftRevision: after.draft.revision, basePublishedRevision: 0 } });
    expect(again.status).toBe(200);
    expect(sqlite.prepare("SELECT reason, draft_revision AS revision FROM theme_restore_points").all()).toEqual([{ reason: "app", revision: 1 }]);
  });

  it("refuses another app's template, a stale draft revision, and an unknown template", async () => {
    expect((await call("POST", "/theme/apply-template", { template: "other.app/rival", expectedDraftRevision: 0, basePublishedRevision: 0 })).body.error.code).toBe("template_not_owned");
    await call("POST", "/theme/apply-template", { template: "volt", expectedDraftRevision: 0, basePublishedRevision: 0 });
    const stale = await call("POST", "/theme/apply-template", { template: "volt", expectedDraftRevision: 0, basePublishedRevision: 0 });
    expect(stale.status).toBe(409);
    expect((await call("POST", "/theme/apply-template", { template: "nope", expectedDraftRevision: 1, basePublishedRevision: 0 })).status).toBe(404);
    // Staff name any active app's template by its key.
    expect((await call("POST", "/theme/apply-template", { template: "other.app/rival", expectedDraftRevision: 1, basePublishedRevision: 0 }, null)).status).toBe(200);
  });
});

describe("theme.section_settings_set", () => {
  it("merges settings into one section, resolves handles and saves under the revision", async () => {
    await call("POST", "/theme/apply-template", { template: "volt", expectedDraftRevision: 0, basePublishedRevision: 0 });
    const set = await call("POST", "/theme/section-settings", {
      sectionId: "deals",
      settings: { title: "Laptops on sale", source: { kind: "category", handle: "laptops" } },
      expectedDraftRevision: 1,
      basePublishedRevision: 0,
    });
    expect(set.status).toBe(200);
    expect(set.body.data.draft.revision).toBe(2);
    expect(set.body.data.section.settings).toEqual({ title: "Laptops on sale", source: { kind: "category", categoryId: "cat_laptops" }, limit: 8 });
  });

  it("refuses settings the section's schema rejects, an unknown handle, a missing section and a stale revision", async () => {
    await call("POST", "/theme/apply-template", { template: "volt", expectedDraftRevision: 0, basePublishedRevision: 0 });
    const base = { expectedDraftRevision: 1, basePublishedRevision: 0 };
    expect((await call("POST", "/theme/section-settings", { ...base, sectionId: "deals", settings: { limit: 500 } })).status).toBe(400);
    expect((await call("POST", "/theme/section-settings", { ...base, sectionId: "deals", settings: { source: { kind: "collection", handle: "gone" } } })).body.error.code).toBe("handle_unresolved");
    expect((await call("POST", "/theme/section-settings", { ...base, sectionId: "nope", settings: { title: "x" } })).body.error.code).toBe("section_not_found");
    expect((await call("POST", "/theme/section-settings", { ...base, expectedDraftRevision: 0, sectionId: "deals", settings: { title: "x" } })).status).toBe(409);
    expect((await read()).draft.revision).toBe(1);
  });
});
