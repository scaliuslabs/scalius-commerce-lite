// What apps write through the stable app API, end to end: the Store builder
// test app (testing/apps/builder) runs as a third-party app through the
// bundled loader, the real operation dispatch (ctx.api.call by app names,
// RBAC from its scopes, the stable tier) and the bulk-run drain. One click on
// its page starts a background job whose steps batch-create the catalogue,
// create a collection by handle, apply the app's template with its handles
// resolved, set a section by handle, publish a footer menu and give a
// customer the app's role; the page shows the job's live progress and the
// role. The same app can never publish the theme or place a menu.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./bundled.gen", async (importOriginal) => (await import("./testing/fixture-apps")).withFixtureApps(await importOriginal()));
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { activatePlugin, installPlugin, type PluginInstallation } from "@scalius/core/modules/plugins";
import { getThemeWorkspace } from "@scalius/core/modules/settings";
import { drainBulkRuns } from "../bulk-runs/engine";
import { BUNDLED_PLUGINS } from "./bundled.gen";
import { PluginHost } from "./host";
import { callPluginOperation } from "./api-call";
import { pluginTestCtx, pluginTestEnv } from "./testing/fixtures";
import { manifest as builderManifest, SETUP_STEPS } from "./testing/apps/builder/src/index";

let sqlite: DatabaseSync;
let db: Database;
let binding: D1Database;

beforeEach(() => {
  ({ sqlite, db, binding } = createSqliteD1Database());
  sqlite.exec(`INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1);
    INSERT INTO customers (id, name, phone) VALUES ('cust_owner', 'Owner', '+8801711000001');`);
});
afterEach(() => sqlite.close());

async function installBuilder(): Promise<PluginInstallation> {
  const installed = await installPlugin(db, { manifest: builderManifest, source: "bundled", bundleSha256: BUNDLED_PLUGINS["acme.builder"]!.sha256, actorUserId: "owner" });
  return activatePlugin(db, "acme.builder", { actorUserId: "owner", expectedRevision: installed.revision });
}

const request = (method: string, body: unknown = null, query: Record<string, string> = {}) =>
  ({ method, subpath: "", query, headers: {}, body, rawBody: null, staffId: "owner" });
const runtime = () => ({ env: pluginTestEnv(binding), ctx: pluginTestCtx() });
const rows = (sql: string) => sqlite.prepare(sql).all();

describe("an app sets up a store through the stable app API", () => {
  it("runs its setup job: catalogue, collection, theme draft, menu and role, with live progress", async () => {
    const installation = await installBuilder();
    expect(installation.grant?.scopes).toEqual(expect.arrayContaining(["write_themes", "write_navigation"]));
    const host = new PluginHost({ env: pluginTestEnv(binding), ctx: pluginTestCtx(), db });

    const started = await host.invokeRoute(installation, "admin", "setup", request("POST", { customerId: "cust_owner" }));
    expect(started.ok, JSON.stringify(started.error)).toBe(true);
    const page = async () => JSON.stringify((await host.invokeRoute(installation, "admin", "setup", request("GET", null, { customer: "cust_owner" }))).value?.body);
    expect(await page()).toContain('"type":"progress"');

    for (let tick = 0; tick < SETUP_STEPS + 2; tick += 1) {
      sqlite.exec("UPDATE bulk_runs SET lease_until = NULL");
      await drainBulkRuns(db, 1, runtime());
    }
    const job = sqlite.prepare("SELECT status, processed, total, error_code AS errorCode FROM bulk_runs WHERE kind = 'app.job'").get();
    expect(job).toEqual({ status: "done", processed: SETUP_STEPS, total: SETUP_STEPS, errorCode: null });

    // The catalogue: each batch item once, though step 2 repeated step 1's keys.
    expect(rows("SELECT slug FROM categories ORDER BY slug")).toEqual([{ slug: "laptops" }, { slug: "phones" }]);
    expect(rows("SELECT slug FROM brands")).toEqual([{ slug: "volt" }]);
    expect(rows("SELECT name, price_minor AS price FROM products ORDER BY name")).toEqual([
      { name: "Volt Book 14", price: 9_900_000 },
      { name: "Volt Book 16", price: 10_900_000 },
    ]);
    const [collection] = rows("SELECT id, slug FROM collections") as Array<{ id: string; slug: string }>;
    expect(collection!.slug).toBe("hot-deals");
    // Everything it created is the app's (app_content.delete may remove it later).
    expect(rows("SELECT resource_type AS type, count(*) AS n FROM app_resource_owners WHERE plugin_id = 'acme.builder' GROUP BY resource_type ORDER BY resource_type"))
      .toEqual([{ type: "brand", n: 1 }, { type: "category", n: 2 }, { type: "collection", n: 1 }, { type: "product", n: 2 }]);

    // The theme draft: the template applied with its handles resolved, one section re-pointed; nothing published.
    const workspace = await getThemeWorkspace(db);
    expect(workspace.published.revision).toBe(0);
    expect(workspace.draft.theme.apps.template).toBe("acme.builder/launch");
    const [tiles, deals, rail] = workspace.draft.theme.pages.home as Array<{ settings: Record<string, unknown> }>;
    const categoryId = (slug: string) => (rows(`SELECT id FROM categories WHERE slug = '${slug}'`)[0] as { id: string }).id;
    expect(tiles!.settings.categoryIds).toEqual([categoryId("laptops"), categoryId("phones")]);
    expect(deals!.settings.source).toEqual({ kind: "collection", collectionId: collection!.id });
    expect(rail!.settings).toMatchObject({ title: "Phones", source: { kind: "category", categoryId: categoryId("phones") } });

    // The menu, published, its category link resolved from the handle.
    expect(rows("SELECT handle, published_revision IS NOT NULL AS published FROM navigation_menus")).toEqual([{ handle: "footer-shop", published: 1 }]);
    expect(rows("SELECT label, target_type AS type, target_id AS id FROM navigation_menu_items WHERE target_type = 'category'"))
      .toEqual([{ label: "Laptops", type: "category", id: categoryId("laptops") }]);

    // The role, read back on the app's page with the finished progress.
    expect(rows("SELECT customer_id AS customer, role, ref FROM plugin_customer_roles")).toEqual([{ customer: "cust_owner", role: "founder", ref: "builder" }]);
    const finished = await page();
    expect(finished).toContain(`"value":${SETUP_STEPS},"max":${SETUP_STEPS}`);
    expect(finished).toContain("Roles: founder");
  });

  it("never lets the app publish the theme or place a menu, even with write_themes and write_navigation", async () => {
    await installBuilder();
    const call = (operationId: string, body: unknown) => callPluginOperation({
      pluginId: "acme.builder", version: builderManifest.version, operationId, input: { body }, db, env: pluginTestEnv(binding), ctx: pluginTestCtx(),
    });
    const publish = await call("theme.publish", { expectedPublishedRevision: 0, expectedDraftRevision: 1 });
    expect(publish.ok).toBe(false);
    expect(["api_operation_not_stable", "api_operation_forbidden", "api_unknown_operation"]).toContain(publish.error?.code);
    const place = await call("navigation.placements_save", { surface: "footer", slot: "column", position: 0, menuId: "menu_x", expectedRevision: 0 });
    expect(place.ok).toBe(false);
    expect(rows("SELECT count(*) AS n FROM theme_settings")).toEqual([{ n: 0 }]);
  });
});
