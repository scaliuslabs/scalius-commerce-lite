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
vi.mock("../../plugins/bundled.gen", async (importOriginal) => (await import("../../plugins/testing/fixture-apps")).withFixtureApps(await importOriginal()));
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { requirePluginInstallation } from "@scalius/core/modules/plugins";
import { putObjectRecord } from "@scalius/core/modules/objects";
import { paymentMethodsDocument, smsDocument } from "@scalius/core/modules/settings";
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

  it("lists an installed app whose saved manifest this release cannot read as failed, never hides it", async () => {
    sqlite.prepare(`INSERT INTO plugin_installations (plugin_id, version, source, bundle_sha256, manifest_json, status)
      VALUES ('acme.legacy', '1.0.0', 'upload', ?, '{"id":"acme.legacy","name":"Legacy sections","retiredField":true}', 'installed')`)
      .run("ab".repeat(32));
    const listed = await call("GET", "/apps");
    expect(listed.status).toBe(200);
    expect(listed.json.data.apps.find((entry: Json) => entry.id === "acme.legacy")).toMatchObject({
      name: "Legacy sections",
      source: "upload",
      status: "failed",
      failureReason: expect.stringMatching(/^Reinstall needed: .*saved version 1\.0\.0/),
    });
  });

  it("describes what an app asks for, and activates only for a Super Admin approving the request shown", async () => {
    const detail = (await call("GET", "/apps/acme.order-tagger")).json.data.app;
    expect(detail.request).toMatchObject({ scopes: ["write_orders"], events: ["order.paid"], customFieldOwners: ["order"], publicRoutes: false });
    expect(detail.granted).toBeNull();
    expect(detail.added).toEqual(detail.request);
    // The risk is what the scope lets this (third-party) app call: stable operations only,
    // so the COD amount edit (beta, financial) does not count, but recording a payment
    // against an invoice (stable, financial) does.
    expect(detail.scopes).toEqual([{ name: "write_orders", risk: "financial", sensitive: false }]);
    expect(detail.settings.fields.map((field: Json) => [field.key, field.type, field.required])).toEqual([["tag", "text", true], ["note", "textarea", false], ["min_total", "number", false]]);
    expect(detail.settings.missing).toEqual([]);
    expect(detail).toMatchObject({ runtime: "bundled", runtimeAvailable: true, cron: [], admin: { pages: [{ id: "overview", route: "summary" }] } });

    actor = { id: "manager", isSuperAdmin: false };
    expect((await call("POST", "/apps/acme.order-tagger/activate", { expectedRevision: detail.revision, grantKey: detail.grantKey })).status).toBe(403);

    actor = { id: "owner", isSuperAdmin: true };
    const stale = await call("POST", "/apps/acme.order-tagger/activate", { expectedRevision: detail.revision, grantKey: "{}" });
    expect(stale.status).toBe(409);
    expect(stale.json.error.details.code).toBe("installation.grant_changed");

    const activated = await call("POST", "/apps/acme.order-tagger/activate", { expectedRevision: detail.revision, grantKey: detail.grantKey });
    expect(activated.status).toBe(200);
    expect(activated.json.data).toMatchObject({ hookError: null, app: { status: "active", activatedBy: { id: "owner", name: "Owner" }, granted: detail.request } });
    const logs = await call("GET", "/apps/acme.order-tagger/logs");
    expect(logs.json.data.lines.map((line: Json) => line.message)).toContain("Order tagger is on");
  });

  it("keeps secret settings write-only: set, kept when omitted, cleared with null, never echoed", async () => {
    await call("GET", "/apps");
    const before = (await call("GET", "/apps/acme.hello")).json.data.app;
    const saved = await call("PUT", "/apps/acme.hello/settings", {
      expectedRevision: before.revision,
      values: { greeting: "Salam", discount_percent: 5, min_subtotal_minor: 0, api_key: "sk_live_super_secret_value" },
    });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.json)).not.toContain("sk_live_super_secret_value");
    expect(saved.json.data.app.settings).toMatchObject({ values: { greeting: "Salam", discount_percent: 5 }, secrets: { api_key: true, webhook_secret: false } });
    const stored = (await requirePluginInstallation(db, "acme.hello")).storedSettings.api_key as string;
    expect(stored.startsWith("ps1:")).toBe(true);
    expect(JSON.stringify((await call("GET", "/apps/acme.hello")).json)).not.toContain("sk_live_super_secret_value");

    const kept = await call("PUT", "/apps/acme.hello/settings", { expectedRevision: saved.json.data.app.revision, values: { greeting: "Hi" } });
    expect(kept.json.data.app.settings.secrets.api_key).toBe(true);
    const cleared = await call("PUT", "/apps/acme.hello/settings", { expectedRevision: kept.json.data.app.revision, values: { greeting: "Hi", api_key: null } });
    expect(cleared.json.data.app.settings.secrets.api_key).toBe(false);

    const invalid = await call("PUT", "/apps/acme.hello/settings", { expectedRevision: cleared.json.data.app.revision, values: { discount_percent: 99 } });
    expect(invalid.status).toBe(400);
    expect(invalid.json.error.details.code).toBe("settings.invalid");
    const stale = await call("PUT", "/apps/acme.hello/settings", { expectedRevision: 1, values: {} });
    expect(stale.status).toBe(409);
  });

  it("deactivates, lists and retries deliveries, and uninstalls keeping or deleting data", async () => {
    await call("GET", "/apps");
    let hello = (await call("GET", "/apps/acme.hello")).json.data.app;
    hello = (await call("POST", "/apps/acme.hello/activate", { expectedRevision: hello.revision, grantKey: hello.grantKey })).json.data.app;
    sqlite.prepare(`INSERT INTO event_outbox (id, topic, resource_type, resource_id, data, status)
      VALUES ('evt_00000000000010000000000009', 'order.created', 'order', 'ord_1', '{}', 'dispatched')`).run();
    sqlite.prepare(`INSERT INTO plugin_event_deliveries (id, plugin_id, event_id, topic, resource_type, resource_id, status, attempts, last_error)
      VALUES ('pld_0000000000009aaaaaaaaaaaa', 'acme.hello', 'evt_00000000000010000000000009', 'order.created', 'order', 'ord_1', 'exhausted', 8, 'boom')`).run();
    const deliveries = await call("GET", "/apps/acme.hello/deliveries");
    expect(deliveries.json.data.deliveries).toEqual([expect.objectContaining({ id: "pld_0000000000009aaaaaaaaaaaa", status: "exhausted", attempts: 8, maxAttempts: 8, error: "boom" })]);
    const retried = await call("POST", "/apps/acme.hello/deliveries/pld_0000000000009aaaaaaaaaaaa/retry");
    expect(retried.json.data.delivery).toMatchObject({ status: "pending", attempts: 0 });

    const stopped = await call("POST", "/apps/acme.hello/deactivate", { expectedRevision: hello.revision });
    expect(stopped.json.data.app.status).toBe("disabled");
    expect((await call("POST", "/apps/acme.hello/deliveries/pld_0000000000009aaaaaaaaaaaa/retry")).status).toBe(409);

    await putObjectRecord(db, "acme.hello", "greetings", (await requirePluginInstallation(db, "acme.hello")).manifest.objects.greetings!, "g1", { order_id: "g1", kind: "paid", created_at: 1 });
    const kept = await call("POST", "/apps/acme.hello/uninstall", { expectedRevision: stopped.json.data.app.revision, keepData: true });
    expect(kept.json.data).toEqual({ id: "acme.hello", uninstalled: true, keepData: true, hookError: null });
    expect(sqlite.prepare("SELECT count(*) AS n FROM object_records WHERE type_id = 'oty_acme.hello.greetings'").get()).toEqual({ n: 1 });
    // A bundled app is part of this deployment: it is listed again, fresh.
    const relisted = (await call("GET", "/apps")).json.data.apps.find((entry: Json) => entry.id === "acme.hello");
    expect(relisted).toMatchObject({ status: "installed", revision: 1, activatedAt: null });
    const removed = await call("POST", "/apps/acme.hello/uninstall", { expectedRevision: 1, keepData: false });
    expect(removed.status).toBe(200);
    expect(sqlite.prepare("SELECT count(*) AS n FROM object_records WHERE type_id = 'oty_acme.hello.greetings'").get()).toEqual({ n: 0 });
  });

  it("holds an updated bundled app whose access grows until a Super Admin approves it", async () => {
    await call("GET", "/apps");
    const tagger = (await call("GET", "/apps/acme.order-tagger")).json.data.app;
    expect((await call("POST", "/apps/acme.order-tagger/activate", { expectedRevision: tagger.revision, grantKey: tagger.grantKey })).status).toBe(200);
    // Pretend the approved grant was narrower and the deployed build is newer.
    sqlite.prepare(`UPDATE plugin_installations SET bundle_sha256 = ?, version = '0.0.9',
      grant_json = json_set(grant_json, '$.scopes', json('["read_orders"]')),
      grant_key = 'old' WHERE plugin_id = 'acme.order-tagger'`).run("1".repeat(64));
    const updated = (await call("GET", "/apps/acme.order-tagger")).json.data.app;
    expect(updated).toMatchObject({ status: "installed", needsApproval: true, version: BUNDLED_PLUGINS["acme.order-tagger"]!.version });
    expect(updated.added.scopes).toEqual(["write_orders"]);
    expect(updated.granted.scopes).toEqual(["read_orders"]);
    const approved = await call("POST", "/apps/acme.order-tagger/activate", { expectedRevision: updated.revision, grantKey: updated.grantKey });
    expect(approved.json.data.app).toMatchObject({ status: "active", needsApproval: false });
  });

  it("carries Nagad choice translations in the response and the API contract", async () => {
    const detail = await call("GET", "/apps/scalius.bangladesh");
    expect(detail.status).toBe(200);
    expect(detail.json.data.app.translations.bn.settings.nagad_environment.options).toEqual({ sandbox: "স্যান্ডবক্স (পরীক্ষা)", live: "লাইভ" });
    const document = app.getOpenAPIDocument({ openapi: "3.0.0", info: { title: "App translations", version: "1.0.0" } });
    expect(document.components?.schemas?.AppTranslations).toMatchObject({ additionalProperties: { properties: { settings: { additionalProperties: { properties: { options: { additionalProperties: { type: "string" } } } } } } } });
  });

  it("lists each app's listing and serves its checked icon, cached by fingerprint", async () => {
    const { apps, available } = (await call("GET", "/apps")).json.data;
    const bkash = apps.find((entry: Json) => entry.id === "scalius.bangladesh");
    const sha = BUNDLED_PLUGINS["scalius.bangladesh"]!.sha256;
    expect(bkash).toMatchObject({
      tagline: "bKash, Nagad, SSLCommerz, couriers, SMS, fraud checks and places",
      categories: ["payments", "shipping", "notifications"],
      countries: ["BD"],
      icon: `/api/v1/admin/apps/scalius.bangladesh/assets/icon?v=${sha.slice(0, 16)}`,
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
    const detail = (await call("GET", "/apps/scalius.bangladesh")).json.data.app;
    expect(detail).toMatchObject({ screenshots: [], support: { url: expect.stringMatching(/^https:/), email: null }, minPlatformVersion: "1.0.0" });
    expect(apps.find((entry: Json) => entry.id === "acme.hello")).toMatchObject({ icon: null, countries: null });

    const image = await app.request(bkash.icon, {}, env, pluginTestCtx());
    expect(image.status).toBe(200);
    expect(image.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(image.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    expect(image.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(image.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await image.text()).toMatch(/^<svg/);
    // Another fingerprint is served but never cached; an app without the image has none.
    expect((await app.request("/api/v1/admin/apps/scalius.bangladesh/assets/icon?v=0000000000000000", {}, env, pluginTestCtx())).headers.get("Cache-Control")).toBe("private, no-cache");
    expect((await app.request("/api/v1/admin/apps/scalius.bangladesh/assets/screenshot-1", {}, env, pluginTestCtx())).status).toBe(404);
    expect((await app.request("/api/v1/admin/apps/acme.hello/assets/icon", {}, env, pluginTestCtx())).status).toBe(404);
    expect((await app.request("/api/v1/admin/apps/scalius.bangladesh/assets/../plugin.js", {}, env, pluginTestCtx())).status).not.toBe(200);
  });

  it("serves a provider's own mark beside the app icon, with the same checks and caching", async () => {
    await call("GET", "/apps");
    const sha = BUNDLED_PLUGINS["scalius.bangladesh"]!.sha256.slice(0, 16);
    for (const courier of ["pathao", "steadfast"]) {
      const image = await app.request(`/api/v1/admin/apps/scalius.bangladesh/assets/provider-${courier}?v=${sha}`, {}, env, pluginTestCtx());
      expect(image.status, courier).toBe(200);
      expect(image.headers.get("Content-Type")).toBe("image/svg+xml");
      expect(image.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
      expect(image.headers.get("Content-Security-Policy")).toContain("sandbox");
      expect(await image.text()).toMatch(/^<svg/);
    }
    // A provider without its own mark, an unknown provider, and a name outside the pattern.
    expect((await app.request("/api/v1/admin/apps/scalius.bangladesh/assets/provider-bdbulksms", {}, env, pluginTestCtx())).status).toBe(404);
    expect((await app.request("/api/v1/admin/apps/scalius.bangladesh/assets/provider-redx", {}, env, pluginTestCtx())).status).toBe(404);
    expect((await app.request("/api/v1/admin/apps/scalius.bangladesh/assets/provider-..%2Fplugin.js", {}, env, pluginTestCtx())).status).not.toBe(200);
  });

  it("activates the Bangladesh pack asking for nothing, then each feature asks for its own access", async () => {
    await call("GET", "/apps");
    const detail = (await call("GET", "/apps/scalius.bangladesh")).json.data.app;
    // Every service is a feature, off by default: the base asks for nothing.
    expect(detail.scopes).toEqual([]);
    expect(detail.request).toMatchObject({ scopes: [], providers: [], allowedHosts: [], features: [] });
    expect(detail.providers).toEqual([]);
    expect(detail.features.every((feature: Json) => feature.enabled === false)).toBe(true);
    const places = detail.features.find((feature: Json) => feature.id === "places");
    expect(places).toMatchObject({ recommended: true, request: { scopes: [{ name: "write_places", risk: "write", sensitive: false }], allowedHosts: [], providers: [] } });
    const bkash = detail.features.find((feature: Json) => feature.id === "bkash");
    // bKash pre-fills the wallet from the buyer's phone: it asks for that one protected field, marked sensitive.
    expect(bkash.request).toMatchObject({
      scopes: [{ name: "read_customer_phones", risk: "read", sensitive: true }], allowedHosts: ["tokenized.pay.bka.sh", "tokenized.sandbox.bka.sh"],
      providers: [{ id: "scalius.bangladesh:bkash", kind: "payment", name: "bKash", icon: expect.stringContaining("/assets/provider-bkash?v=") }],
    });
    expect(detail.translations.bn.features.places.name).toBe("বাংলাদেশের এলাকা");
    // Each feature names its own settings and pages, and the app counts them.
    expect(bkash.settings).toEqual(["bkash_environment", "bkash_app_key", "bkash_app_secret", "bkash_username", "bkash_password"]);
    expect(places).toMatchObject({ settings: [], pages: ["places"] });
    expect(detail.featureCount).toEqual({ on: 0, total: 14 });

    // Turning a feature on before the app runs is refused.
    expect((await call("POST", "/apps/scalius.bangladesh/features/bkash/enable", { expectedRevision: detail.revision, grantKey: bkash.grantKey })).status).toBe(409);
    const active = (await call("POST", "/apps/scalius.bangladesh/activate", { expectedRevision: detail.revision, grantKey: detail.grantKey })).json.data.app;
    expect(active).toMatchObject({ status: "active", granted: { scopes: [], providers: [], features: [] } });

    // Only a Super Admin approves a feature's access.
    const fresh = active.features.find((feature: Json) => feature.id === "bkash");
    actor = { id: "owner", isSuperAdmin: false };
    expect((await call("POST", "/apps/scalius.bangladesh/features/bkash/enable", { expectedRevision: active.revision, grantKey: fresh.grantKey })).status).toBe(403);
    actor = { id: "owner", isSuperAdmin: true };
    const on = await call("POST", "/apps/scalius.bangladesh/features/bkash/enable", { expectedRevision: active.revision, grantKey: fresh.grantKey });
    expect(on.status).toBe(200);
    expect(on.json.data).toMatchObject({ changed: true, hookError: null });
    expect(on.json.data.app.granted).toMatchObject({ features: ["bkash"], providers: ["payment"], allowedHosts: ["tokenized.pay.bka.sh", "tokenized.sandbox.bka.sh"] });
    expect(on.json.data.app.providers.map((provider: Json) => provider.id)).toEqual(["scalius.bangladesh:bkash"]);
    expect(on.json.data.app.featureCount).toEqual({ on: 1, total: 14 });
    expect(on.json.data.app.settings.fields.map((field: Json) => field.key)).toEqual(["bkash_environment", "bkash_app_key", "bkash_app_secret", "bkash_username", "bkash_password"]);

    const listed = (await call("GET", "/apps/scalius.bangladesh/features")).json.data;
    expect(listed.features.filter((feature: Json) => feature.enabled).map((feature: Json) => feature.id)).toEqual(["bkash"]);
    const off = await call("POST", "/apps/scalius.bangladesh/features/bkash/disable", { expectedRevision: listed.revision });
    expect(off.json.data.app).toMatchObject({ granted: { features: [], providers: [], allowedHosts: [] }, providers: [] });
    expect((await call("POST", "/apps/scalius.bangladesh/features/ghost/disable", { expectedRevision: off.json.data.app.revision })).status).toBe(404);
  });

  it("puts a turned-on payment or SMS service to use without a second switch, and says when it is not used", async () => {
    await call("GET", "/apps");
    const detail = (await call("GET", "/apps/scalius.bangladesh")).json.data.app;
    let current = (await call("POST", "/apps/scalius.bangladesh/activate", { expectedRevision: detail.revision, grantKey: detail.grantKey })).json.data.app;
    const turnOn = async (id: string) => {
      const feature = current.features.find((entry: Json) => entry.id === id);
      const response = await call("POST", `/apps/scalius.bangladesh/features/${id}/enable`, { expectedRevision: current.revision, grantKey: feature.grantKey });
      expect(response.status).toBe(200);
      current = response.json.data.app;
    };
    const use = (id: string) => current.providers.find((provider: Json) => provider.id === id)?.use;

    // bKash joins checkout's methods after cash on delivery (never saved: COD was implied); checkout offers it once its keys are saved.
    await turnOn("bkash");
    expect((await paymentMethodsDocument.read(db)).enabledMethods).toEqual(["cod", "scalius.bangladesh:bkash"]);
    expect(use("scalius.bangladesh:bkash")).toBe("offered");

    // Hidden in Settings, Payments: the app page says so, and saving the app's settings never adds it back.
    await paymentMethodsDocument.write(db, { enabledMethods: ["cod"], defaultMethod: "cod" });
    current = (await call("GET", "/apps/scalius.bangladesh")).json.data.app;
    expect(use("scalius.bangladesh:bkash")).toBe("hidden");
    current = (await call("PUT", "/apps/scalius.bangladesh/settings", { expectedRevision: current.revision, values: { bkash_username: "shop-01" } })).json.data.app;
    expect((await paymentMethodsDocument.read(db)).enabledMethods).toEqual(["cod"]);
    expect(use("scalius.bangladesh:bkash")).toBe("hidden");

    // An SMS provider without its key is not chosen; saving the key makes it the SMS service.
    await turnOn("smsnetbd");
    expect((await smsDocument.read(db)).activeProvider).toBe("");
    expect(use("scalius.bangladesh:smsnetbd")).toBe("not_chosen");
    current = (await call("PUT", "/apps/scalius.bangladesh/settings", { expectedRevision: current.revision, values: { smsnetbd_api_key: "k3J9xQ2mP7vL5nR8wT4z" } })).json.data.app;
    expect((await smsDocument.read(db)).activeProvider).toBe("scalius.bangladesh:smsnetbd");
    expect(use("scalius.bangladesh:smsnetbd")).toBe("chosen");

    // A chosen service is never replaced by the next ready one.
    await turnOn("bdbulksms");
    current = (await call("PUT", "/apps/scalius.bangladesh/settings", { expectedRevision: current.revision, values: { bdbulksms_token: "Zq8Lm2Np5Rt7Vx9Bc4Df" } })).json.data.app;
    expect((await smsDocument.read(db)).activeProvider).toBe("scalius.bangladesh:smsnetbd");
    expect(use("scalius.bangladesh:bdbulksms")).toBe("not_chosen");
  });

  it("lists what active apps add to the dashboard: pages by placement, cards, actions, widgets and their admin routes", async () => {
    await call("GET", "/apps");
    expect((await call("GET", "/apps/surfaces")).json.data.apps).toEqual([]);
    for (const id of ["acme.hello", "acme.wishlist"]) {
      const detail = (await call("GET", `/apps/${id}`)).json.data.app;
      if (detail.settings.missing.length === 0) {
        expect((await call("POST", `/apps/${id}/activate`, { expectedRevision: detail.revision, grantKey: detail.grantKey })).status).toBe(200);
      }
    }
    const { apps } = (await call("GET", "/apps/surfaces")).json.data;
    expect(apps.map((entry: Json) => entry.id)).toEqual(["acme.hello", "acme.wishlist"]);
    expect(apps[0]).toMatchObject({
      name: "Hello",
      pages: [{
        id: "overview",
        title: "Hello",
        placement: "apps",
        route: "dashboard",
        tabs: [{ id: "summary", title: "Summary", route: "dashboard" }, { id: "about", title: "How it works", route: "about" }],
      }],
      cards: [{ id: "greeting", target: "order", title: "Hello", route: "order-card" }],
      actions: [{ id: "wave", target: "product", label: "Wave hello", route: "wave", bulk: true, destructive: false }],
      widgets: [{ id: "summary", title: "Hello", route: "widget" }],
    });
    expect(apps[0].routes).toEqual(expect.arrayContaining([{ name: "reset", methods: ["POST"] }, { name: "dashboard", methods: ["GET"] }]));
    expect(apps[0].providers).toEqual([]);
    expect(apps[1]).toMatchObject({
      pages: [{ id: "most-wished", placement: "products", route: "most-wished", tabs: null }],
      cards: [{ id: "wishes", target: "product", route: "product-card" }],
    });
  });

  it("describes where an app's settings and surfaces show: sections, services and every surface", async () => {
    await call("GET", "/apps");
    const installed = (await call("GET", "/apps/scalius.bangladesh")).json.data.app;
    const activated = (await call("POST", "/apps/scalius.bangladesh/activate", { expectedRevision: installed.revision, grantKey: installed.grantKey })).json.data.app;
    let revision = activated.revision as number;
    for (const id of ["sslcommerz", "pathao"]) {
      const feature = (await call("GET", "/apps/scalius.bangladesh/features")).json.data.features.find((entry: Json) => entry.id === id);
      revision = (await call("POST", `/apps/scalius.bangladesh/features/${id}/enable`, { expectedRevision: revision, grantKey: feature.grantKey })).json.data.app.revision;
    }
    const pack = (await call("GET", "/apps/scalius.bangladesh")).json.data.app;
    // Every pack field is a service's: none on the app page itself; only the features that are on show.
    expect(pack.settings.sections).toEqual([]);
    expect(pack.providers.map((provider: Json) => provider.providerId)).toEqual(["sslcommerz", "pathao"]);
    expect(pack.providers.find((provider: Json) => provider.providerId === "sslcommerz")).toMatchObject({
      id: "scalius.bangladesh:sslcommerz",
      kind: "payment",
      name: "SSLCommerz",
      icon: expect.stringContaining("/assets/provider-sslcommerz?v="),
      required: ["sslcommerz_environment", "sslcommerz_store_id", "sslcommerz_store_password"],
    });
    expect(pack.providers.find((provider: Json) => provider.providerId === "pathao")).toMatchObject({
      id: "scalius.bangladesh:pathao",
      kind: "courier",
      name: "Pathao",
      icon: expect.stringContaining("/assets/provider-pathao?v="),
      own: true,
      required: ["pathao_base_url", "pathao_client_id", "pathao_client_secret", "pathao_username", "pathao_password", "pathao_store_id"],
      settings: expect.arrayContaining(["pathao_item_weight", "pathao_webhook_secret"]),
    });
    expect(pack.settings.fields.find((field: Json) => field.key === "pathao_client_id")).toMatchObject({ label: "Client ID", group: "pathao" });
    expect(pack.translations.bn.settings.pathao_client_id).toEqual({ label: "ক্লায়েন্ট আইডি" });

    const hello = (await call("GET", "/apps/acme.hello")).json.data.app;
    expect(hello.settings.sections).toEqual([
      { group: null, keys: ["greeting"] },
      { group: { id: "discount", title: "Welcome discount", description: "The discount Hello offers at checkout." }, keys: ["discount_percent", "min_subtotal_minor"] },
      { group: { id: "connection", title: "Connection", description: "Keys for Hello's outside service and its webhook." }, keys: ["api_key", "webhook_secret"] },
    ]);
    expect(hello.providers).toEqual([]);
    expect(hello.admin).toMatchObject({
      cards: [{ id: "greeting", target: "order", title: "Hello" }],
      actions: [{ id: "wave", target: "product", label: "Wave hello", bulk: true }],
      widgets: [{ id: "summary", title: "Hello" }],
    });
    expect(hello.storefront).toMatchObject({
      proxy: true,
      head: true,
      sections: [],
      productBlocks: [],
    });
  });
});
