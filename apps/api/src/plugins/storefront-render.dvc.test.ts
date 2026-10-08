// App sections and product blocks through the strict dependency-validated
// part reader (public-read.ts), the way a storefront batch serves them: the
// first read runs the app, every validated hit runs NO plugin code, and
// exactly the writes the output depends on (the app's settings, version or
// status, a collection it declares, the theme, the product) refresh it.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
// The reference app is a sample, not in scalius.plugins.json: add it to the bundled registry.
vi.mock("./bundled.gen", async (importOriginal) => (await import("./testing/fixture-apps")).withFixtureApps(await importOriginal()));
import "@hono/zod-openapi";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { rebuildCatalogProjections } from "@scalius/core/modules/products";
import {
  activatePlugin,
  deactivatePlugin,
  installPlugin,
  putPluginRecord,
  requirePluginInstallation,
  writePluginSettings,
} from "@scalius/core/modules/plugins";
import { storefrontTemplateTheme } from "@scalius/shared/storefront-theme";
import { createPublicPartReader, renderPublicRead } from "../public-read";
import { BUNDLED_PLUGINS } from "./bundled.gen";
import { PluginHost } from "./host";
import { installHello, pluginTestEnv, PLUGIN_TEST_CREDENTIAL_KEY } from "./testing/fixtures";
import { manifest as wishlistManifest } from "./testing/apps/wishlist/src/index";
import { manifest as notesManifest } from "./testing/apps/notes/src/index";

class MemoryCache {
  readonly entries = new Map<string, Response>();
  async match(key: RequestInfo | URL) {
    return this.entries.get(String(key))?.clone();
  }
  async put(key: RequestInfo | URL, response: Response) {
    this.entries.set(String(key), response);
  }
  async delete(key: RequestInfo | URL) {
    return this.entries.delete(String(key));
  }
}

const SEED = `
  INSERT INTO categories (id, name, slug, status) VALUES ('cat_panjabi', 'Panjabi', 'panjabi', 'published');
  INSERT INTO products (id, name, price_minor, slug, category_id, is_active) VALUES ('p_linen', 'Linen Panjabi', 250000, 'linen-panjabi', 'cat_panjabi', 1);
  INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory) VALUES
    ('v_linen', 'p_linen', 'LIN-1', 250000, 5, 0, 1, 1);
`;

describe("storefront app output under dependency validation", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let binding: D1Database;
  let env: Env;
  let cache: MemoryCache;
  let invoked: MockInstance<PluginHost["invokeRoute"]>;

  const read = async (path: string) => {
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => void waits.push(promise), passThroughOnException: () => undefined, props: {}, exports: {} } as unknown as ExecutionContext;
    const reader = createPublicPartReader({
      mode: "strict",
      env,
      cache,
      db: () => db,
      render: (part) => renderPublicRead(part, env, ctx),
      waitUntil: (promise) => void waits.push(promise),
      maxConcurrentRenders: 4,
      random: () => 1,
    });
    const [settled] = await reader.readParts([new Request(`https://api.internal${path}`)], null);
    if (!settled || settled.status === "rejected") throw settled?.reason;
    const body = await settled.value.response.clone().json() as { data: Record<string, unknown> };
    await Promise.all(waits);
    return { status: settled.value.cache?.status ?? null, data: body.data };
  };
  const appRuns = () => invoked.mock.calls.filter((call) => call[1] === "public").length;

  beforeEach(async () => {
    ({ sqlite, db, binding } = createSqliteD1Database());
    sqlite.exec(SEED);
    await rebuildCatalogProjections(db);
    env = pluginTestEnv(binding, { CF_VERSION_METADATA: { id: "dvc-apps-version", tag: "", timestamp: "" } });
    cache = new MemoryCache();
    await installHello(db, sqlite);
    const wishlist = await installPlugin(db, { manifest: wishlistManifest, source: "bundled", bundleSha256: BUNDLED_PLUGINS["acme.wishlist"]!.sha256, actorUserId: "owner" });
    await activatePlugin(db, "acme.wishlist", { actorUserId: "owner", expectedRevision: wishlist.revision });
    const theme = storefrontTemplateTheme("department-mall");
    theme.pages.home = [{ id: "hello", type: "app", version: 1, settings: { app: "acme.hello/greeting", values: { heading: "Eid Mubarak" } } }];
    theme.blocks.product.apps = [{ id: "wish", app: "acme.wishlist/button", values: { label: "Save it" } }];
    sqlite.prepare("INSERT INTO theme_settings (id, colors, revision, created_at, updated_at) VALUES ('default', ?, 1, 1, 1)").run(JSON.stringify(theme));
    invoked = vi.spyOn(PluginHost.prototype, "invokeRoute");
  });
  afterEach(() => {
    invoked.mockRestore();
    sqlite.close();
  });

  it("caches a homepage app section: a hit runs no app code, only its own keys refresh it", async () => {
    const first = await read("/api/v1/storefront/homepage");
    expect(first.status).toBe("miss");
    const apps = (first.data.sections as { apps: Array<{ sectionId: string; html: string; head: { meta: unknown[] } }> }).apps;
    expect(apps).toEqual([expect.objectContaining({ sectionId: "hello", html: expect.stringContaining("Eid Mubarak") })]);
    expect(apps[0]!.head.meta).toEqual([{ attribute: "name", key: "hello-greeting", content: "Eid Mubarak" }]);
    expect(appRuns()).toBe(1);

    expect((await read("/api/v1/storefront/homepage")).status).toBe("hit");
    expect(appRuns()).toBe(1);

    // A write the section does not read (it declares no collections) changes nothing.
    const hello = await requirePluginInstallation(db, "acme.hello");
    await putPluginRecord(db, "acme.hello", "greetings", hello.manifest.storage.greetings!, "o1", { orderId: "o1", kind: "paid", createdAt: 1 });
    expect((await read("/api/v1/storefront/homepage")).status).toBe("hit");
    expect(appRuns()).toBe(1);

    // The app's settings are part of what it draws.
    await writePluginSettings(db, "acme.hello", { greeting: "Hi", discount_percent: 5, min_subtotal_minor: 0 }, {
      expectedRevision: hello.revision,
      credentialEncryptionKey: PLUGIN_TEST_CREDENTIAL_KEY,
    });
    expect((await read("/api/v1/storefront/homepage")).status).toBe("refresh");
    expect(appRuns()).toBe(2);
    expect((await read("/api/v1/storefront/homepage")).status).toBe("hit");

    // Deactivated: the section draws nothing, and the app is not asked.
    await deactivatePlugin(db, "acme.hello", { expectedRevision: (await requirePluginInstallation(db, "acme.hello")).revision });
    const off = await read("/api/v1/storefront/homepage");
    expect(off.status).toBe("refresh");
    expect((off.data.sections as { apps: unknown[] }).apps).toEqual([]);
    expect(appRuns()).toBe(2);
  });

  it("caches a product page's app block per product: buyer writes never refresh it, product and theme changes do", async () => {
    const first = await read("/api/v1/storefront/product-apps/linen-panjabi");
    expect(first.status).toBe("miss");
    expect(first.data.blocks).toEqual([expect.objectContaining({
      id: "wish",
      app: "acme.wishlist/button",
      placement: "buy-box",
      html: expect.stringContaining('action="/apps/acme.wishlist/toggle"'),
    })]);
    expect((first.data.blocks as Array<{ html: string }>)[0]!.html).toContain("Save it");
    expect(appRuns()).toBe(1);
    expect((await read("/api/v1/storefront/product-apps/linen-panjabi")).status).toBe("hit");

    // A buyer saving the product writes the app's storage; the block is the same for everyone.
    const wishlist = await requirePluginInstallation(db, "acme.wishlist");
    await putPluginRecord(db, "acme.wishlist", "wishes", wishlist.manifest.storage.wishes!, "c1:p_linen", { customerId: "c1", productId: "p_linen", addedAt: 1 });
    expect((await read("/api/v1/storefront/product-apps/linen-panjabi")).status).toBe("hit");
    expect(appRuns()).toBe(1);

    sqlite.prepare("UPDATE products SET name = 'Linen Panjabi (Eid)' WHERE id = 'p_linen'").run();
    expect((await read("/api/v1/storefront/product-apps/linen-panjabi")).status).toBe("refresh");
    expect(appRuns()).toBe(2);

    const theme = storefrontTemplateTheme("department-mall");
    sqlite.prepare("UPDATE theme_settings SET colors = ?, revision = 2 WHERE id = 'default'").run(JSON.stringify(theme));
    const none = await read("/api/v1/storefront/product-apps/linen-panjabi");
    expect(none.status).toBe("refresh");
    expect(none.data.blocks).toEqual([]);
    expect(appRuns()).toBe(2);
  });

  it("answers 404 (never stored) for a product that is not public", async () => {
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => void waits.push(promise), passThroughOnException: () => undefined, props: {}, exports: {} } as unknown as ExecutionContext;
    const response = await renderPublicRead(new Request("https://api.internal/api/v1/storefront/product-apps/nope"), env, ctx);
    expect(response.status).toBe(404);
    expect(appRuns()).toBe(0);
  });

  it("lists active apps' approved scripts in the layout", async () => {
    const layout = await read("/api/v1/storefront/layout");
    expect(layout.data.appScripts).toEqual([]);
    expect((await read("/api/v1/storefront/layout")).status).toBe("hit");
    // Any installation change may change which scripts load.
    await deactivatePlugin(db, "acme.wishlist", { expectedRevision: (await requirePluginInstallation(db, "acme.wishlist")).revision });
    expect((await read("/api/v1/storefront/layout")).status).toBe("refresh");
  });

  it("draws checkout and account blocks once per page group: the layout says where, a hit runs no app code, only their keys refresh them", async () => {
    // No app draws a block: the layout says so and pages read nothing more.
    expect((await read("/api/v1/storefront/layout")).data.appBlockPages).toEqual([]);
    expect((await read("/api/v1/storefront/app-blocks/checkout")).data.blocks).toEqual([]);

    const notes = await installPlugin(db, { manifest: notesManifest, source: "bundled", bundleSha256: BUNDLED_PLUGINS["acme.notes"]!.sha256, actorUserId: "owner" });
    await activatePlugin(db, "acme.notes", { actorUserId: "owner", expectedRevision: notes.revision });
    expect((await read("/api/v1/storefront/layout")).data.appBlockPages).toEqual(["checkout", "account"]);

    const runs = appRuns();
    const checkout = await read("/api/v1/storefront/app-blocks/checkout");
    expect(checkout.data.blocks).toEqual([{
      id: "acme.notes/delivery",
      app: "acme.notes",
      target: "purchase.checkout.contact.render-after",
      // A checkout block holds no form: the buyer's checkout form stays whole.
      html: expect.not.stringContaining("<form"),
    }]);
    expect((checkout.data.blocks as Array<{ html: string }>)[0]!.html).toContain("Orders before 2 pm ship today.");
    const account = await read("/api/v1/storefront/app-blocks/account");
    expect((account.data.blocks as Array<{ target: string; html: string }>)).toEqual([expect.objectContaining({
      target: "customer-account.order-index.block.render",
      html: expect.stringContaining("action=\"/apps/acme.notes/join\""),
    })]);
    expect(appRuns()).toBe(runs + 2);

    // Hits run no app code; a write to a collection only the account block reads refreshes only it.
    expect((await read("/api/v1/storefront/app-blocks/checkout")).status).toBe("hit");
    expect((await read("/api/v1/storefront/app-blocks/account")).status).toBe("hit");
    expect(appRuns()).toBe(runs + 2);
    const installed = await requirePluginInstallation(db, "acme.notes");
    await putPluginRecord(db, "acme.notes", "notes", installed.manifest.storage.notes!, "account", { text: "Double points this week." });
    expect((await read("/api/v1/storefront/app-blocks/checkout")).status).toBe("hit");
    const refreshed = await read("/api/v1/storefront/app-blocks/account");
    expect(refreshed.status).toBe("refresh");
    expect(JSON.stringify(refreshed.data.blocks)).toContain("Double points this week.");

    // Stopping the app removes its blocks everywhere.
    await deactivatePlugin(db, "acme.notes", { expectedRevision: installed.revision });
    expect((await read("/api/v1/storefront/app-blocks/checkout")).data.blocks).toEqual([]);
    expect((await read("/api/v1/storefront/layout")).data.appBlockPages).toEqual([]);
  });
});
