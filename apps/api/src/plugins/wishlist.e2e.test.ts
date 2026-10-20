// The Wishlist app end to end on the migrated schema, through the real plugin
// routes, admin stack and plugin principal: a signed-in buyer (known only by
// the store's session, through the storefront proxy) saves a product, sees
// its state and their wishlist page; the app reads the product through
// /api/v1 under its grant; staff see it ranked on Most wished; a product
// edit reaches the app's projection; the page answer names the app's page
// component and its props.
import { createHmac } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./bundled.gen", async (importOriginal) => (await import("./testing/fixture-apps")).withFixtureApps(await importOriginal()));
import type { Database } from "@scalius/database/client";
import { getObjectRecord } from "@scalius/core/modules/objects";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { activatePlugin, installPlugin, requirePluginInstallation } from "@scalius/core/modules/plugins";
import { hashCustomerSessionToken } from "@scalius/core/modules/customers";
import { parsePluginUiDocument } from "@scalius/shared/plugins";
import { createRuntimeApiApp } from "../runtime/base-app";
import { BUNDLED_PLUGINS } from "./bundled.gen";
import { PluginHost } from "./host";
import { createPluginRoutes } from "./routes";
import { pluginTestCtx, pluginTestEnv } from "./testing/fixtures";
import { manifest as wishlistManifest } from "./testing/apps/wishlist/src/index";

const SESSION_KEY = "wishlist-e2e-session-hash-key-0123456789";

describe("acme.wishlist end to end", { timeout: 30_000 }, () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let env: Env;
  let app: ReturnType<typeof createRuntimeApiApp>;

  const staffCookie = () => {
    const signature = createHmac("sha256", String(env.BETTER_AUTH_SECRET)).update("tok_owner").digest("base64");
    return `better-auth.session_token=${encodeURIComponent(`tok_owner.${signature}`)}`;
  };
  async function call(path: string, init: RequestInit = {}) {
    const response = await app.fetch(new Request(`https://api.shop.test${path}`, init), env, pluginTestCtx());
    const text = await response.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON from the route, asserted field by field
    return { status: response.status, json: (text ? JSON.parse(text) : null) as any };
  }
  const proxied = (accept: string, cookie: string | null = "cs_tok=buyer-session") => ({
    "x-scalius-app-proxy": "1",
    accept,
    ...(cookie ? { cookie } : {}),
  });

  beforeEach(async () => {
    let binding: D1Database;
    ({ sqlite, db, binding } = createSqliteD1Database());
    env = pluginTestEnv(binding, { CUSTOMER_SESSION_HASH_KEY: SESSION_KEY });
    sqlite.exec(`
      INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1);
      INSERT INTO session (id, user_id, token, expires_at, two_factor_verified) VALUES ('ses_owner', 'owner', 'tok_owner', unixepoch() + 3600, 1);
      INSERT INTO categories (id, name, slug, status) VALUES ('cat_panjabi', 'Panjabi', 'panjabi', 'published');
      INSERT INTO products (id, name, price_minor, slug, category_id, is_active) VALUES ('p_linen', 'Linen Panjabi', 250000, 'linen-panjabi', 'cat_panjabi', 1);
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory) VALUES ('v_linen', 'p_linen', 'LIN-1', 250000, 5, 0, 1, 1);
      INSERT INTO customers (id, name, email, phone) VALUES ('cust_buyer', 'Buyer', 'buyer@example.test', '+8801711000009');
    `);
    sqlite.prepare("INSERT INTO customer_sessions (token_hash, customer_id, expires_at) VALUES (?, 'cust_buyer', unixepoch() + 3600)")
      .run(await hashCustomerSessionToken("buyer-session", SESSION_KEY));
    const installed = await installPlugin(db, { manifest: wishlistManifest, source: "bundled", bundleSha256: BUNDLED_PLUGINS["acme.wishlist"]!.sha256, actorUserId: "owner" });
    await activatePlugin(db, "acme.wishlist", { actorUserId: "owner", expectedRevision: installed.revision });
    app = createRuntimeApiApp();
    app.route("/", createPluginRoutes());
  });
  afterEach(() => sqlite.close());

  it("saves a product for the signed-in buyer, shows it on their page and to staff, and follows product edits", async () => {
    // A guest is asked to sign in; nothing is stored.
    expect(await call("/api/v1/plugins/acme.wishlist/public/toggle", {
      method: "POST",
      headers: { ...proxied("application/json", null), "content-type": "application/x-www-form-urlencoded" },
      body: "productId=p_linen",
    })).toMatchObject({ status: 401, json: { navigate: "/account" } });

    // The buyer saves it (the app's form, enhanced: JSON back).
    const saved = await call("/api/v1/plugins/acme.wishlist/public/toggle", {
      method: "POST",
      headers: { ...proxied("application/json"), "content-type": "application/x-www-form-urlencoded" },
      body: "productId=p_linen&returnTo=%2Fproducts%2Flinen-panjabi",
    });
    expect(saved).toEqual({ status: 200, json: { pressed: true, message: "Saved to your wishlist." } });
    expect(await getObjectRecord(db, "acme.wishlist", "wishes", "cust_buyer:p_linen")).toMatchObject({ customer_id: "cust_buyer", product_id: "p_linen" });
    // The app read the product through /api/v1 under its own grant (products.view).
    expect(await getObjectRecord(db, "acme.wishlist", "products", "p_linen")).toMatchObject({ name: "Linen Panjabi", slug: "linen-panjabi", wishes: 1 });
    expect(sqlite.prepare("SELECT plugin_id, operation_id, outcome FROM agent_audit_events ORDER BY operation_id").all()).toEqual([
      { plugin_id: "acme.wishlist", operation_id: "dashboard.resources.products.get", outcome: "success" },
    ]);

    expect((await call("/api/v1/plugins/acme.wishlist/public/state?productId=p_linen", { headers: proxied("application/json") })).json)
      .toEqual({ pressed: true, signedIn: true });

    // Their page, as the storefront draws it inside the store layout.
    const page = await call("/api/v1/plugins/acme.wishlist/public/wishlist", { headers: proxied("text/html") });
    expect(page.json.page.title).toBe("Your wishlist");
    expect(page.json.page).toMatchObject({ component: "wishlist_page", props: { signedIn: true, items: [expect.objectContaining({ url: "/products/linen-panjabi" })] } });

    // Staff: Most wished, as the dashboard renders it.
    const mostWished = await call("/api/v1/plugins/acme.wishlist/admin/most-wished", { headers: { cookie: staffCookie() } });
    expect(mostWished.status).toBe(200);
    const document = parsePluginUiDocument(mostWished.json);
    expect(document.ok).toBe(true);
    expect(JSON.stringify(mostWished.json)).toContain('"text":"Linen Panjabi"');

    // A product edit reaches the app (its event handler re-reads the product).
    sqlite.prepare("UPDATE products SET name = 'Linen Panjabi (Eid)' WHERE id = 'p_linen'").run();
    const host = new PluginHost({ env, ctx: pluginTestCtx(), db });
    const installation = await requirePluginInstallation(db, "acme.wishlist");
    expect(await host.invokeEvent(installation, {
      id: "evt_1", topic: "product.updated", apiVersion: "2026-10", occurredAt: new Date().toISOString(),
      resource: { type: "product", id: "p_linen" }, facts: { productId: "p_linen", revision: 2 },
    })).toEqual({ ok: true, value: null, error: null });
    expect(await getObjectRecord(db, "acme.wishlist", "products", "p_linen")).toMatchObject({ name: "Linen Panjabi (Eid)", wishes: 1 });

    // Removing it without JavaScript: a navigation, redirected back to the product.
    const removed = await call("/api/v1/plugins/acme.wishlist/public/toggle", {
      method: "POST",
      headers: { ...proxied("text/html"), "content-type": "application/x-www-form-urlencoded" },
      body: "productId=p_linen&returnTo=%2Fproducts%2Flinen-panjabi",
    });
    expect(removed.json).toEqual({ redirect: "/products/linen-panjabi" });
    expect(await getObjectRecord(db, "acme.wishlist", "products", "p_linen")).toBeNull();
  });

  it("never lets a direct API call act as a buyer without the store's session", async () => {
    const forged = await call("/api/v1/plugins/acme.wishlist/public/toggle", {
      method: "POST",
      headers: { "x-scalius-app-proxy": "1", accept: "application/json", "content-type": "application/json", cookie: "cs_tok=forged" },
      body: JSON.stringify({ productId: "p_linen" }),
    });
    expect(forged.status).toBe(401);
    expect(vi.isMockFunction(env.RL_STANDARD.limit) && (env.RL_STANDARD.limit as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });
});
