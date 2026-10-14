// The sandbox loader in workerd: the reference plugin (acme.hello), packed
// exactly as `pnpm plugin build` packs it, runs in its own Dynamic Worker
// (Miniflare `workerLoaders`) with no network of its own, reaching the
// platform only through the real PluginBridge entrypoint over RPC. The same
// behaviour as the bundled loader: storage, KV, the /api/v1 call as the plugin
// principal, routes, cron and the checkout function. Plus what only a sandbox
// can prove: direct fetch is impossible and a tampered bundle never loads.
// And acme.bulk-discount priced into a real checkout with Hello's discount
// stacked after it, each app in its own isolate.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
  activatePlugin,
  getPluginKv,
  getPluginRecord,
  installPlugin,
  listPluginLogs,
  pluginEventFanOutTarget,
  requirePluginInstallation,
  writePluginSettings,
} from "@scalius/core/modules/plugins";
import { toOutboxEvent } from "@scalius/core/modules/events";
import { eventOutbox } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import { PLUGIN_API_VERSION } from "@scalius/shared/plugins";
import { packPlugin } from "../../../../scripts/plugin-build.mjs";
import { pluginBundleKey } from "./loaders/sandbox";
import { workerdModules } from "../testing/workerd-modules";
import { PLUGIN_TEST_CREDENTIAL_KEY, testCart } from "./testing/fixtures";
import {
  WALLET_FIXTURE_CODE,
  WALLET_FIXTURE_ID,
  WALLET_FIXTURE_MANIFEST,
  WALLET_FIXTURE_SECRET,
  walletSessionInput,
} from "./testing/provider-fixture";

const apiDir = resolve(import.meta.dirname, "../..");
const HARNESS = resolve(import.meta.dirname, "testing/sandbox-harness.worker.ts");
const COMPATIBILITY_DATE = "2026-07-30";
const COMPATIBILITY_FLAGS = ["nodejs_compat", "disable_nodejs_process_v2"];

/** A plugin written without the SDK, probing what a sandbox must forbid. */
const PROBE_CODE = `export default {
  manifest: { id: "acme.probe", version: "1.0.0" },
  routes: { public: { probe: async (request, ctx) => {
    const outcome = {};
    try { await fetch("https://example.com/"); outcome.fetch = "reached"; } catch (error) { outcome.fetch = String(error && error.message || error).slice(0, 80); }
    try { await ctx.http.fetch("https://evil.example/"); outcome.http = "reached"; } catch (error) { outcome.http = error.code; }
    outcome.globals = typeof process === "undefined" ? "none" : "process";
    return { body: outcome };
  } } },
};
`;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("plugins in the sandbox loader (Miniflare workerLoaders)", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let mf: Miniflare;
  let workdir: string;
  let helloSha: string;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON from the harness, asserted field by field
  async function send(command: Record<string, unknown>): Promise<any> {
    const response = await mf.dispatchFetch("http://harness/", { method: "POST", body: JSON.stringify(command) });
    if (!response.ok) throw new Error(`harness ${response.status}: ${await response.text()}`);
    return response.json();
  }

  beforeAll(async () => {
    const created = createSqliteD1Database();
    ({ sqlite, db } = created);
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
    sqlite.prepare(`INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status)
      VALUES ('ord_box1', 'Rahim', '+8801711111111', 'House 1', 'city_1', 'zone_1', 'confirmed')`).run();
    sqlite.exec(`
      INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active)
      VALUES ('city_1', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1), ('zone_1', 'Gulshan', 'BD', 2, 'city_1', '{}', '{}', 1);
      INSERT INTO delivery_zones (id, name) VALUES ('dz_bd', 'Bangladesh'); INSERT INTO delivery_zone_regions (country_code, zone_id) VALUES ('BD', 'dz_bd'); INSERT INTO shipping_methods (id, name, fee_minor, kind, zone_id) VALUES ('m_std', 'Standard', 6000, 'delivery', 'dz_bd');
      INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('p_tea', 'Assam tea', 'assam-tea', 50000, 1);
      INSERT INTO product_variants
        (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
      VALUES ('v_tea', 'p_tea', 'TEA-250', 50000, 500, 0, 0, 1, 1, 'physical');
    `);

    // The harness Worker: the real host code, bundled the way the API is.
    workdir = mkdtempSync(join(tmpdir(), "scalius-plugin-sandbox-"));
    writeFileSync(join(workdir, "wrangler.json"), JSON.stringify({
      name: "plugin-sandbox-harness",
      main: HARNESS,
      compatibility_date: COMPATIBILITY_DATE,
      compatibility_flags: COMPATIBILITY_FLAGS,
    }));
    execFileSync(join(apiDir, "node_modules/.bin/wrangler"), ["deploy", "--dry-run", "--outdir", join(workdir, "dist"), "--config", join(workdir, "wrangler.json")], {
      cwd: apiDir,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });

    const binding = created.binding as unknown as {
      prepare(sql: string): { bind(...values: unknown[]): { all(): Promise<unknown>; run(): Promise<unknown>; raw(): Promise<unknown> } };
      batch(statements: unknown[]): Promise<unknown>;
    };
    mf = new Miniflare(convertV4MiniflareOptions({
      modules: workerdModules(join(workdir, "dist"), "sandbox-harness.worker.js"),
      // Module names must not climb out of the root (workerd refuses `../` names).
      modulesRoot: join(workdir, "dist"),
      compatibilityDate: COMPATIBILITY_DATE,
      compatibilityFlags: COMPATIBILITY_FLAGS,
      workerLoaders: { LOADER: {} },
      r2Buckets: ["BUCKET"],
      bindings: { CREDENTIAL_ENCRYPTION_KEY: PLUGIN_TEST_CREDENTIAL_KEY },
      serviceBindings: {
        DB_PROXY: async (request: Request) => {
          const body = await request.json() as { op: string; sql: string; params: unknown[]; statements: Array<{ sql: string; params: unknown[] }> };
          try {
            if (body.op === "batch") {
              return Response.json(await binding.batch(body.statements.map((statement) => binding.prepare(statement.sql).bind(...statement.params))));
            }
            const statement = binding.prepare(body.sql).bind(...body.params);
            const result = body.op === "raw" ? await statement.raw() : body.op === "run" ? await statement.run() : await statement.all();
            return Response.json(result);
          } catch (error) {
            return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
          }
        },
      },
    }) as never);

    // Pack the reference plugin exactly as `pnpm plugin build` does and store it in R2.
    const packed = await packPlugin("./apps/api/src/plugins/testing/apps/hello");
    helloSha = packed.sha256;
    const bucket = await mf.getR2Bucket("BUCKET");
    await bucket.put(pluginBundleKey("acme.hello", packed.version, helloSha), packed.code);
    const installed = await installPlugin(db, { manifest: packed.manifest, source: "registry", bundleSha256: helloSha, actorUserId: "owner" });
    const configured = await writePluginSettings(db, "acme.hello", { greeting: "Salam", discount_percent: 20, min_subtotal_minor: 0, api_key: "sandbox-secret" }, {
      expectedRevision: installed.revision,
      credentialEncryptionKey: PLUGIN_TEST_CREDENTIAL_KEY,
    });
    await activatePlugin(db, "acme.hello", { actorUserId: "owner", expectedRevision: configured.revision });

    // The Bulk discount example app, packed and stored the same way.
    const bulk = await packPlugin("./apps/api/src/plugins/testing/apps/bulk-discount");
    await bucket.put(pluginBundleKey("acme.bulk-discount", bulk.version, bulk.sha256), bulk.code);
    const bulkInstalled = await installPlugin(db, { manifest: bulk.manifest, source: "registry", bundleSha256: bulk.sha256, actorUserId: "owner" });
    const bulkConfigured = await writePluginSettings(db, "acme.bulk-discount", {
      title: "Bulk savings", tier1_quantity: 3, tier1_percent: 5, max_quantity_per_line: 10,
    }, { expectedRevision: bulkInstalled.revision, credentialEncryptionKey: PLUGIN_TEST_CREDENTIAL_KEY });
    await activatePlugin(db, "acme.bulk-discount", { actorUserId: "owner", expectedRevision: bulkConfigured.revision });

    const probeSha = sha256(PROBE_CODE);
    await bucket.put(pluginBundleKey("acme.probe", "1.0.0", probeSha), PROBE_CODE);
    await installPlugin(db, {
      manifest: {
        id: "acme.probe", name: "Probe", version: "1.0.0", apiVersion: PLUGIN_API_VERSION, description: "Probes the sandbox.",
        author: { name: "Acme" }, allowedHosts: ["api.acme.example"], routes: { admin: [], public: [{ name: "probe", methods: ["GET"] }], webhooks: [] },
      },
      source: "upload",
      bundleSha256: probeSha,
      actorUserId: "owner",
    });
    await activatePlugin(db, "acme.probe", { actorUserId: "owner", expectedRevision: 1 });

    // The payment provider fixture: the same bytes the bundled provider tests run.
    const walletSha = sha256(WALLET_FIXTURE_CODE);
    await bucket.put(pluginBundleKey(WALLET_FIXTURE_ID, "1.0.0", walletSha), WALLET_FIXTURE_CODE);
    const walletInstalled = await installPlugin(db, { manifest: WALLET_FIXTURE_MANIFEST, source: "upload", bundleSha256: walletSha, actorUserId: "owner" });
    const walletConfigured = await writePluginSettings(db, WALLET_FIXTURE_ID, { secret: WALLET_FIXTURE_SECRET }, {
      expectedRevision: walletInstalled.revision,
      credentialEncryptionKey: PLUGIN_TEST_CREDENTIAL_KEY,
    });
    await activatePlugin(db, WALLET_FIXTURE_ID, { actorUserId: "owner", expectedRevision: walletConfigured.revision });
  }, 180_000);

  afterAll(async () => {
    await mf?.dispose();
    sqlite?.close();
    if (workdir) rmSync(workdir, { recursive: true, force: true });
  });

  it("handles order.paid in its isolate: the bridge stores, counts and calls dashboard.orders.get as the plugin", async () => {
    const outcome = await send({
      action: "event",
      pluginId: "acme.hello",
      event: { id: "evt_box", topic: "order.paid", apiVersion: "2026-10", occurredAt: "2026-10-01T10:00:00.000Z", resource: { type: "order", id: "ord_box1" }, facts: {} },
    });
    expect(outcome).toEqual({ ok: true, value: null, error: null });
    expect(await getPluginRecord(db, "acme.hello", "greetings", "ord_box1")).toMatchObject({ greeting: "Salam", orderStatus: "confirmed" });
    expect(await getPluginKv(db, "acme.hello", "paid_count")).toBe(1);
    expect(sqlite.prepare("SELECT plugin_id, operation_id, outcome FROM agent_audit_events").all())
      .toEqual([{ plugin_id: "acme.hello", operation_id: "dashboard.orders.get", outcome: "success" }]);
    expect((await listPluginLogs(db, "acme.hello")).map((line) => line.message)).toContain("Greeted a paid order");
  });

  it("serves routes, runs cron and the checkout function with the same results as bundled", async () => {
    const request = { method: "GET", subpath: "", query: { name: "Karim" }, headers: {}, body: null, rawBody: null, staffId: null };
    expect(await send({ action: "route", pluginId: "acme.hello", surface: "public", name: "greet", request }))
      .toEqual({ ok: true, value: { status: 200, headers: {}, body: { message: "Salam, Karim!", visits: 1 } }, error: null });
    expect((await send({ action: "route", pluginId: "acme.hello", surface: "admin", name: "dashboard", request: { ...request, query: {} } })).value.body)
      .toMatchObject({
        version: 1,
        root: { children: [{ children: [{ label: "Greeted orders", value: 1 }, { label: "Paid events", value: 1 }, { label: "New orders", value: 0 }] }, expect.anything(), expect.anything()] },
      });
    expect(await send({ action: "cron", pluginId: "acme.hello", name: "tidy", scheduledAt: "2027-01-01T00:00:00.000Z" }))
      .toEqual({ ok: true, value: null, error: null });
    expect(await getPluginRecord(db, "acme.hello", "greetings", "ord_box1")).toBeNull();
    // Every active implementation answers, in priority then id order (one unit: no bulk tier).
    expect(await send({ action: "function", pluginId: "acme.hello", point: "checkout.discounts", input: { cart: testCart(5000) } }))
      .toEqual([
        { pluginId: "acme.bulk-discount", priority: 100, output: { discounts: [] } },
        { pluginId: "acme.hello", priority: 100, output: { discounts: [{ title: "Salam discount", target: { kind: "order" }, value: { type: "percentage", percent: 20 } }] } },
      ]);
  });

  it("prices a real checkout with the bulk discount's functions in their isolate, Hello's discount stacked after it", async () => {
    const order = {
      items: [{ productId: "p_tea", variantId: "v_tea", quantity: 4, price: 500 }],
      inventoryPool: "regular", city: "city_1", zone: "zone_1", area: null, shippingMethodId: "m_std",
      customerPhone: "+8801712345678", discountCodes: [],
    };
    const priced = await send({ action: "price", pluginId: "acme.bulk-discount", input: order });
    expect(priced.points).toEqual(["cart.validate", "checkout.discounts"]);
    // Bulk (priority 100, "acme.bulk-discount" sorts first): 5% of ৳2,000 = ৳100;
    // then Hello's 20% of the ৳1,900 left = ৳380.
    expect(priced.appDiscounts.map((entry: { pluginId: string; amountMinor: number }) => [entry.pluginId, entry.amountMinor])).toEqual([
      ["acme.bulk-discount", 10_000],
      ["acme.hello", 38_000],
    ]);
    expect(priced).toMatchObject({ ruleErrors: [], discountMinor: 48_000, totalMinor: 200_000 + 6_000 - 48_000 });
    const blocked = await send({ action: "price", pluginId: "acme.bulk-discount", input: { ...order, items: [{ ...order.items[0], quantity: 11 }] } });
    expect(blocked.ruleErrors).toEqual([{ code: "max_quantity", message: "You can buy at most 10 of this item in one order.", index: 0, cartKey: null }]);
  });

  it("runs provider operations in the isolate with the same answers and errors as bundled", async () => {
    const provider = (operation: string, input: unknown) => send({ action: "provider", pluginId: WALLET_FIXTURE_ID, kind: "payment", provider: "wallet", operation, input });
    const session = await provider("createSession", walletSessionInput(12_550));
    expect(session).toEqual({
      ok: true,
      value: { providerRef: "W-ORD1_full_12550", redirectUrl: "https://wallet.acme.test/pay?amount=125.50&currency=BDT" },
    });
    expect(await provider("createSession", walletSessionInput(12_550))).toEqual(session);
    expect(await getPluginRecord(db, WALLET_FIXTURE_ID, "sessions", "attempt-12550")).toMatchObject({ orderId: "ORD1" });

    const webhook = { method: "POST", rawBody: JSON.stringify({ id: "evt1", orderId: "ORD1", ref: "W-1", amountMinor: 12_550 }), headers: { "x-wallet-signature": WALLET_FIXTURE_SECRET }, query: {} };
    expect((await provider("verifyWebhook", webhook)).value).toMatchObject({ status: "event", event: { kind: "confirmed", amountMinor: 12_550 } });

    expect(await provider("createSession", walletSessionInput(1300)))
      .toEqual({ ok: false, error: { name: "ProviderError", category: "declined", uncertain: false, code: "wallet.declined", message: "The wallet declined the payment." } });
    const timeout = await provider("createSession", walletSessionInput(1400));
    expect(timeout.error).toMatchObject({ category: "retryable", uncertain: true, code: "wallet.timeout" });
    expect(timeout.error.message).not.toContain(WALLET_FIXTURE_SECRET);
    expect((await provider("createSession", walletSessionInput(1500))).error).toMatchObject({ category: "retryable", uncertain: true, code: "provider.invalid_response" });
    expect((await provider("createSession", walletSessionInput(1600))).error).toMatchObject({ category: "retryable", uncertain: true, code: "provider.error" });
    expect((await provider("listRefunds", { sourceRef: "W-1" })).error)
      .toMatchObject({ category: "misconfigured", code: "provider.unsupported" });
  });

  it("gives the isolate no network: direct fetch fails and the bridge refuses undeclared hosts", async () => {
    const outcome = await send({ action: "route", pluginId: "acme.probe", surface: "public", name: "probe", request: { method: "GET", subpath: "", query: {}, headers: {}, body: null, rawBody: null, staffId: null } });
    expect(outcome.ok).toBe(true);
    expect(outcome.value.body.fetch).toMatch(/not permitted to access the internet/);
    expect(outcome.value.body.http).toBe("http.not_allowed");
    expect(outcome.value.body.globals).toBe("none");
  });

  it("never loads a bundle whose bytes do not match the installed SHA-256", async () => {
    const tampered = "export default { manifest: { id: 'acme.probe', version: '1.0.1' } };";
    const bucket = await mf.getR2Bucket("BUCKET");
    const installation = await requirePluginInstallation(db, "acme.probe");
    sqlite.prepare("UPDATE plugin_installations SET version = '1.0.1', bundle_sha256 = ? WHERE plugin_id = 'acme.probe'").run("9".repeat(64));
    await bucket.put(pluginBundleKey("acme.probe", "1.0.1", "9".repeat(64)), tampered);
    const outcome = await send({ action: "route", pluginId: "acme.probe", surface: "public", name: "probe", request: { method: "GET", subpath: "", query: {}, headers: {}, body: null, rawBody: null, staffId: null } });
    expect(outcome).toMatchObject({ ok: false, error: expect.stringMatching(/does not match its SHA-256/) });
    expect((await requirePluginInstallation(db, "acme.probe")).status).toBe("failed");
    expect(installation.status).toBe("active");
  });

  it("delivers an outbox event end to end: fan-out row, the plugins.deliver consumer, the isolate, exactly once", async () => {
    sqlite.prepare(`INSERT INTO event_outbox (id, topic, resource_type, resource_id, data, occurred_at, status)
      VALUES ('evt_sandbox_delivery1', 'order.created', 'order', 'ord_box1', '{"orderId":"ord_box1","status":"pending","paymentStatus":"unpaid","channel":"online_store"}', unixepoch(), 'processing')`).run();
    const event = toOutboxEvent((await db.select().from(eventOutbox).where(eq(eventOutbox.id, "evt_sandbox_delivery1")).get())!)!;
    const messages = await pluginEventFanOutTarget.fanOut(db, event);
    expect(messages).toEqual([{ type: "plugins.deliver", deliveryId: expect.stringMatching(/^pld_/) }]);
    const deliveryId = (messages[0] as { deliveryId: string }).deliveryId;

    expect(await send({ action: "deliver", pluginId: "acme.hello", deliveryId })).toEqual({ status: "succeeded", deliveryId, retryInSeconds: null });
    expect(sqlite.prepare("SELECT plugin_id, status, attempts, last_error FROM plugin_event_deliveries WHERE id = ?").get(deliveryId))
      .toEqual({ plugin_id: "acme.hello", status: "succeeded", attempts: 1, last_error: null });
    expect(await getPluginKv(db, "acme.hello", "created_count")).toBe(1);

    // A redelivered message and a re-dispatched event add nothing.
    expect(await send({ action: "deliver", pluginId: "acme.hello", deliveryId })).toEqual({ status: "skipped", deliveryId, reason: "not_due" });
    expect(await pluginEventFanOutTarget.fanOut(db, event)).toEqual([]);
    expect(sqlite.prepare("SELECT count(*) AS n FROM plugin_event_deliveries").get()).toEqual({ n: 1 });
    expect(await getPluginKv(db, "acme.hello", "created_count")).toBe(1);
  });
});
