// The Apps management API on the migrated schema with the real bundled
// plugins: listing installs bundled apps (idempotently), the detail carries
// the consent request in structured form, only a Super Admin activates and
// only the request that was shown, secrets are write-only, the update path
// waits for approval when access grows, and uninstall keeps or deletes data
// (a bundled app reappears as installed).
import { OpenAPIHono } from "@hono/zod-openapi";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The reference app is a sample, not in scalius.plugins.json: add it to the bundled registry.
vi.mock("../../plugins/bundled.gen", async (importOriginal) => (await import("../../plugins/testing/hello-bundled")).withHelloBundled(await importOriginal()));
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { putPluginRecord, requirePluginInstallation } from "@scalius/core/modules/plugins";
import { errorResponseFromError } from "../../utils/api-response";
import { BUNDLED_PLUGINS } from "../../plugins/bundled.gen";
import { pluginTestCtx, pluginTestEnv } from "../../plugins/testing/fixtures";
import { adminAppRoutes } from "./apps";

// A first-party plugin this deployment does not bundle (the real catalog is empty here).
const GIFT_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>';
vi.mock("../../plugins/catalog.gen", () => ({
  PLUGIN_CATALOG: [{
    id: "scalius.gift-wrap",
    source: "plugins/gift-wrap",
    sha256: "c".repeat(64),
    listing: {
      name: "Gift wrap",
      version: "1.0.0",
      description: "Buyers ask for gift wrap at checkout.",
      author: { name: "Scalius" },
      icon: "assets/icon.svg",
      tagline: "Wrap orders as gifts",
      categories: ["orders"],
      screenshots: [],
      translations: { bn: { name: "গিফট র‍্যাপ" } },
    },
  }],
}));
vi.mock("../../plugins/assets.gen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/assets.gen")>();
  return {
    PLUGIN_ASSETS: {
      ...actual.PLUGIN_ASSETS,
      "scalius.gift-wrap": { "assets/icon.svg": { type: "image/svg+xml", sha256: "d".repeat(64), data: btoa(GIFT_ICON) } },
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON from the routes, asserted field by field
type Json = Record<string, any>;

describe("admin app routes", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let env: Env;
  let actor: { id: string; isSuperAdmin: boolean };
  let app: OpenAPIHono<{ Bindings: Env }>;

  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
    const response = await app.request(`/api/v1/admin${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    }, env, pluginTestCtx());
    return { status: response.status, json: await response.json() as Json };
  }

  beforeEach(() => {
    let binding: D1Database;
    ({ sqlite, db, binding } = createSqliteD1Database());
    env = pluginTestEnv(binding);
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('manager', 'Manager', 'manager@shop.test', 1, 'staff', 0)").run();
    actor = { id: "owner", isSuperAdmin: true };
    app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
    app.onError((error, c) => {
      const { body, status } = errorResponseFromError(error);
      return c.json(body, status);
    });
    app.use("*", async (c, next) => {
      c.set("db", db);
      c.set("user", { id: actor.id, name: actor.id, email: "", isSuperAdmin: actor.isSuperAdmin } as never);
      await next();
    });
    app.route("/apps", adminAppRoutes);
  });
  afterEach(() => sqlite.close());

  it("lists every bundled app as installed, once", async () => {
    const first = await call("GET", "/apps");
    expect(first.status).toBe(200);
    const ids = Object.keys(BUNDLED_PLUGINS).sort();
    expect(first.json.data.apps.map((entry: Json) => entry.id)).toEqual(ids);
    expect(first.json.data.apps[0]).toMatchObject({ status: "installed", source: "bundled", needsApproval: false, revision: 1 });
    expect(first.json.data.sandboxAvailable).toBe(false);
    await call("GET", "/apps");
    expect(sqlite.prepare("SELECT count(*) AS n FROM plugin_installations").get()).toEqual({ n: ids.length });
  });

  it("describes what an app asks for, and activates only for a Super Admin approving the request shown", async () => {
    const detail = (await call("GET", "/apps/scalius.order-tagger")).json.data.app;
    expect(detail.request).toMatchObject({ permissions: ["orders.edit", "orders.view"], events: ["order.paid"], customFieldOwners: ["order"], publicRoutes: false });
    expect(detail.granted).toBeNull();
    expect(detail.added).toEqual(detail.request);
    expect(detail.permissions).toEqual([
      // orders.edit unlocks a money-moving operation (the COD amount), so it reads as financial.
      { name: "orders.edit", risk: "financial", sensitive: false },
      { name: "orders.view", risk: "read", sensitive: false },
    ]);
    expect(detail.settings.fields.map((field: Json) => [field.key, field.type, field.required])).toEqual([["tag", "text", true], ["note", "textarea", false], ["min_total", "number", false]]);
    expect(detail.settings.missing).toEqual([]);
    expect(detail).toMatchObject({ runtime: "bundled", runtimeAvailable: true, cron: [], admin: { pages: [{ id: "overview", route: "summary" }] } });

    actor = { id: "manager", isSuperAdmin: false };
    expect((await call("POST", "/apps/scalius.order-tagger/activate", { expectedRevision: detail.revision, grantKey: detail.grantKey })).status).toBe(403);

    actor = { id: "owner", isSuperAdmin: true };
    const stale = await call("POST", "/apps/scalius.order-tagger/activate", { expectedRevision: detail.revision, grantKey: "{}" });
    expect(stale.status).toBe(409);
    expect(stale.json.error.details.code).toBe("installation.grant_changed");

    const activated = await call("POST", "/apps/scalius.order-tagger/activate", { expectedRevision: detail.revision, grantKey: detail.grantKey });
    expect(activated.status).toBe(200);
    expect(activated.json.data).toMatchObject({ hookError: null, app: { status: "active", activatedBy: { id: "owner", name: "Owner" }, granted: detail.request } });
    const logs = await call("GET", "/apps/scalius.order-tagger/logs");
    expect(logs.json.data.lines.map((line: Json) => line.message)).toContain("Order tagger is on");
  });

  it("keeps secret settings write-only: set, kept when omitted, cleared with null, never echoed", async () => {
    await call("GET", "/apps");
    const before = (await call("GET", "/apps/scalius.hello")).json.data.app;
    const saved = await call("PUT", "/apps/scalius.hello/settings", {
      expectedRevision: before.revision,
      values: { greeting: "Salam", discount_percent: 5, min_subtotal_minor: 0, api_key: "sk_live_super_secret_value" },
    });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.json)).not.toContain("sk_live_super_secret_value");
    expect(saved.json.data.app.settings).toMatchObject({ values: { greeting: "Salam", discount_percent: 5 }, secrets: { api_key: true, webhook_secret: false } });
    const stored = (await requirePluginInstallation(db, "scalius.hello")).storedSettings.api_key as string;
    expect(stored.startsWith("ps1:")).toBe(true);
    expect(JSON.stringify((await call("GET", "/apps/scalius.hello")).json)).not.toContain("sk_live_super_secret_value");

    const kept = await call("PUT", "/apps/scalius.hello/settings", { expectedRevision: saved.json.data.app.revision, values: { greeting: "Hi" } });
    expect(kept.json.data.app.settings.secrets.api_key).toBe(true);
    const cleared = await call("PUT", "/apps/scalius.hello/settings", { expectedRevision: kept.json.data.app.revision, values: { greeting: "Hi", api_key: null } });
    expect(cleared.json.data.app.settings.secrets.api_key).toBe(false);

    const invalid = await call("PUT", "/apps/scalius.hello/settings", { expectedRevision: cleared.json.data.app.revision, values: { discount_percent: 99 } });
    expect(invalid.status).toBe(400);
    expect(invalid.json.error.details.code).toBe("settings.invalid");
    const stale = await call("PUT", "/apps/scalius.hello/settings", { expectedRevision: 1, values: {} });
    expect(stale.status).toBe(409);
  });

  it("deactivates, lists and retries deliveries, and uninstalls keeping or deleting data", async () => {
    await call("GET", "/apps");
    let hello = (await call("GET", "/apps/scalius.hello")).json.data.app;
    hello = (await call("POST", "/apps/scalius.hello/activate", { expectedRevision: hello.revision, grantKey: hello.grantKey })).json.data.app;
    sqlite.prepare(`INSERT INTO event_outbox (id, topic, resource_type, resource_id, data, status)
      VALUES ('evt_00000000000010000000000009', 'order.created', 'order', 'ord_1', '{}', 'dispatched')`).run();
    sqlite.prepare(`INSERT INTO plugin_event_deliveries (id, plugin_id, event_id, topic, resource_type, resource_id, status, attempts, last_error)
      VALUES ('pld_0000000000009aaaaaaaaaaaa', 'scalius.hello', 'evt_00000000000010000000000009', 'order.created', 'order', 'ord_1', 'exhausted', 8, 'boom')`).run();
    const deliveries = await call("GET", "/apps/scalius.hello/deliveries");
    expect(deliveries.json.data.deliveries).toEqual([expect.objectContaining({ id: "pld_0000000000009aaaaaaaaaaaa", status: "exhausted", attempts: 8, maxAttempts: 8, error: "boom" })]);
    const retried = await call("POST", "/apps/scalius.hello/deliveries/pld_0000000000009aaaaaaaaaaaa/retry");
    expect(retried.json.data.delivery).toMatchObject({ status: "pending", attempts: 0 });

    const stopped = await call("POST", "/apps/scalius.hello/deactivate", { expectedRevision: hello.revision });
    expect(stopped.json.data.app.status).toBe("disabled");
    expect((await call("POST", "/apps/scalius.hello/deliveries/pld_0000000000009aaaaaaaaaaaa/retry")).status).toBe(409);

    await putPluginRecord(db, "scalius.hello", "greetings", { indexes: ["orderId", ["kind", "createdAt"]], unique: ["orderId"] }, "g1", { orderId: "g1", kind: "paid", createdAt: 1 });
    const kept = await call("POST", "/apps/scalius.hello/uninstall", { expectedRevision: stopped.json.data.app.revision, keepData: true });
    expect(kept.json.data).toEqual({ id: "scalius.hello", uninstalled: true, keepData: true, hookError: null });
    expect(sqlite.prepare("SELECT count(*) AS n FROM plugin_records WHERE plugin_id = 'scalius.hello'").get()).toEqual({ n: 1 });
    // A bundled app is part of this deployment: it is listed again, fresh.
    const relisted = (await call("GET", "/apps")).json.data.apps.find((entry: Json) => entry.id === "scalius.hello");
    expect(relisted).toMatchObject({ status: "installed", revision: 1, activatedAt: null });
    const removed = await call("POST", "/apps/scalius.hello/uninstall", { expectedRevision: 1, keepData: false });
    expect(removed.status).toBe(200);
    expect(sqlite.prepare("SELECT count(*) AS n FROM plugin_records WHERE plugin_id = 'scalius.hello'").get()).toEqual({ n: 0 });
  });

  it("holds an updated bundled app whose access grows until a Super Admin approves it", async () => {
    await call("GET", "/apps");
    const tagger = (await call("GET", "/apps/scalius.order-tagger")).json.data.app;
    expect((await call("POST", "/apps/scalius.order-tagger/activate", { expectedRevision: tagger.revision, grantKey: tagger.grantKey })).status).toBe(200);
    // Pretend the approved grant was narrower and the deployed build is newer.
    sqlite.prepare(`UPDATE plugin_installations SET bundle_sha256 = ?, version = '0.0.9',
      grant_json = json_set(grant_json, '$.permissions', json('["orders.view"]')),
      grant_key = 'old' WHERE plugin_id = 'scalius.order-tagger'`).run("1".repeat(64));
    const updated = (await call("GET", "/apps/scalius.order-tagger")).json.data.app;
    expect(updated).toMatchObject({ status: "installed", needsApproval: true, version: BUNDLED_PLUGINS["scalius.order-tagger"]!.version });
    expect(updated.added.permissions).toEqual(["orders.edit"]);
    expect(updated.granted.permissions).toEqual(["orders.view"]);
    const approved = await call("POST", "/apps/scalius.order-tagger/activate", { expectedRevision: updated.revision, grantKey: updated.grantKey });
    expect(approved.json.data.app).toMatchObject({ status: "active", needsApproval: false });
  });

  it("lists each app's listing and serves its checked icon, cached by fingerprint", async () => {
    const { apps, available } = (await call("GET", "/apps")).json.data;
    const bkash = apps.find((entry: Json) => entry.id === "scalius.bkash");
    const sha = BUNDLED_PLUGINS["scalius.bkash"]!.sha256;
    expect(bkash).toMatchObject({
      tagline: "Take bKash payments at checkout",
      categories: ["payments"],
      countries: ["BD"],
      icon: `/api/v1/admin/apps/scalius.bkash/assets/icon?v=${sha.slice(0, 16)}`,
      translations: { bn: { tagline: expect.any(String) } },
    });
    // A first-party app not bundled here waits to be added with its command.
    expect(available).toEqual([expect.objectContaining({
      id: "scalius.gift-wrap",
      tagline: "Wrap orders as gifts",
      icon: "/api/v1/admin/apps/scalius.gift-wrap/assets/icon?v=cccccccccccccccc",
      installCommand: "pnpm plugin add plugins/gift-wrap",
      translations: { bn: { name: "গিফট র‍্যাপ" } },
    })]);
    const giftIcon = await app.request(available[0].icon, {}, env, pluginTestCtx());
    expect([giftIcon.status, await giftIcon.text()]).toEqual([200, GIFT_ICON]);
    const detail = (await call("GET", "/apps/scalius.bkash")).json.data.app;
    expect(detail).toMatchObject({ screenshots: [], support: { url: expect.stringMatching(/^https:/), email: null }, minPlatformVersion: "1.0.0" });
    expect(apps.find((entry: Json) => entry.id === "scalius.hello")).toMatchObject({ icon: null, countries: null });

    const image = await app.request(bkash.icon, {}, env, pluginTestCtx());
    expect(image.status).toBe(200);
    expect(image.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(image.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    expect(image.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(image.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await image.text()).toMatch(/^<svg/);
    // Another fingerprint is served but never cached; an app without the image has none.
    expect((await app.request("/api/v1/admin/apps/scalius.bkash/assets/icon?v=0000000000000000", {}, env, pluginTestCtx())).headers.get("Cache-Control")).toBe("private, no-cache");
    expect((await app.request("/api/v1/admin/apps/scalius.bkash/assets/screenshot-1", {}, env, pluginTestCtx())).status).toBe(404);
    expect((await app.request("/api/v1/admin/apps/scalius.hello/assets/icon", {}, env, pluginTestCtx())).status).toBe(404);
    expect((await app.request("/api/v1/admin/apps/scalius.bkash/assets/../plugin.js", {}, env, pluginTestCtx())).status).not.toBe(200);
  });

  it("lists what active apps add to the dashboard: pages by placement, cards, actions, widgets and their admin routes", async () => {
    await call("GET", "/apps");
    expect((await call("GET", "/apps/surfaces")).json.data.apps).toEqual([]);
    for (const id of ["scalius.hello", "scalius.wishlist"]) {
      const detail = (await call("GET", `/apps/${id}`)).json.data.app;
      if (detail.settings.missing.length === 0) {
        expect((await call("POST", `/apps/${id}/activate`, { expectedRevision: detail.revision, grantKey: detail.grantKey })).status).toBe(200);
      }
    }
    const { apps } = (await call("GET", "/apps/surfaces")).json.data;
    expect(apps.map((entry: Json) => entry.id)).toEqual(["scalius.hello", "scalius.wishlist"]);
    expect(apps[0]).toMatchObject({
      name: "Hello",
      pages: [{ id: "overview", title: "Hello", placement: "apps", route: "dashboard" }],
      cards: [{ id: "greeting", target: "order", title: "Hello", route: "order-card" }],
      actions: [{ id: "wave", target: "product", label: "Wave hello", route: "wave", bulk: true, destructive: false }],
      widgets: [{ id: "summary", title: "Hello", route: "widget" }],
    });
    expect(apps[0].routes).toEqual(expect.arrayContaining([{ name: "reset", methods: ["POST"] }, { name: "dashboard", methods: ["GET"] }]));
    expect(apps[1]).toMatchObject({
      pages: [{ id: "most-wished", placement: "products", route: "most-wished" }],
      cards: [{ id: "wishes", target: "product", route: "product-card" }],
    });
  });
});
