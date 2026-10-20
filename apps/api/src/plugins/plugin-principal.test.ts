// The plugin principal: ctx.api.call dispatches through the agent dispatcher
// and the real admin auth middleware as the plugin. Granted operations run
// (writes recorded as the approving Super Admin, audited under the plugin),
// ungranted ones are refused, a third-party app reaches only the stable app
// API (a bundled first-party app also beta operations), and operations
// outside the plugin-available set (security risk, reserved RBAC areas) are
// refused even when forged into the principal.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { activatePlugin, deactivatePlugin, installPlugin, requirePluginInstallation } from "@scalius/core/modules/plugins";
import { PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/shared/plugins";
import { AGENT_OPERATIONS } from "../generated/agent-operations.gen";
import { withOperationDispatchPrincipal } from "../agent-access/dispatch-context";
import type { PluginPrincipal } from "../agent-access/types";
import { fetchRuntimeApiApp } from "../runtime/fetch-runtime-app";
import { callPluginOperation } from "./api-call";
import { authorizePluginOperation, derivePluginRiskCeiling, isOperationAvailableToPlugins } from "./authority";
import { pluginTestCtx, pluginTestEnv } from "./testing/fixtures";

const manifest: PluginManifestInput = {
  id: "acme.rbac",
  name: "Acme RBAC",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Exercises the plugin principal.",
  author: { name: "Acme" },
  scopes: ["write_orders", "read_settings"],
};

describe("plugin-available operations (operation metadata)", () => {
  const available = AGENT_OPERATIONS.filter(isOperationAvailableToPlugins);

  it("leaves security, sensitive, reserved-area and non-admin operations out", () => {
    expect(available.length).toBeGreaterThan(200);
    for (const operation of available) {
      expect(operation.risk).not.toBe("security");
      expect(operation.sensitiveOutput || operation.oneTimeSecretOutput).toBe(false);
      expect(operation.pathTemplate.startsWith("/api/v1/admin/")).toBe(true);
      expect(["permission", "anyOf", "allOf"]).toContain(operation.rbac.type);
    }
    // The areas that confer authority over people, credentials, egress and
    // plugins are absent whatever their risk (checked here by id, decided by
    // metadata in authority.ts).
    const reserved = AGENT_OPERATIONS.filter((operation) =>
      /^dashboard\.(agent_access|team|webhooks|account)[._]/.test(operation.operationId));
    expect(reserved.length).toBeGreaterThan(20);
    for (const operation of reserved) expect(isOperationAvailableToPlugins(operation), operation.operationId).toBe(false);
    expect(available.some((operation) => operation.operationId === "dashboard.resources.orders.get")).toBe(true);
    expect(available.some((operation) => operation.operationId === "dashboard.settings.email_get")).toBe(false);
  });

  it("derives the risk ceiling from what the grant unlocks, never security", () => {
    expect(derivePluginRiskCeiling(new Set(), false)).toBe("read");
    expect(derivePluginRiskCeiling(new Set(["orders.view"]), false)).toBe("read");
    expect(derivePluginRiskCeiling(new Set(["products.delete"]), false)).toBe("destructive");
    // Refunds are not in the stable app API: only a first-party app reaches them.
    expect(derivePluginRiskCeiling(new Set(["orders.refund"]), false)).toBe("read");
    expect(derivePluginRiskCeiling(new Set(["orders.refund"]), true)).toBe("financial");
    expect(derivePluginRiskCeiling(new Set(["team.manage_roles", "agent_access.manage"]), true)).toBe("read");
    const get = AGENT_OPERATIONS.find((operation) => operation.operationId === "dashboard.resources.orders.get")!;
    const principal = (permissions: string[], riskCeiling: PluginPrincipal["riskCeiling"]): PluginPrincipal => ({
      kind: "plugin", pluginId: "acme.rbac", version: "1.0.0", pluginName: "x", actorUserId: "owner", firstParty: false, permissions: new Set(permissions), protectedData: new Set(), riskCeiling,
    });
    expect(authorizePluginOperation(principal(["orders.view"], "read"), get)).toBe(true);
    expect(authorizePluginOperation(principal(["customers.view"], "read"), get)).toBe(false);
    const invoice = AGENT_OPERATIONS.find((operation) => operation.operationId === "dashboard.orders.invoice_get")!;
    expect(invoice.stability).toBe("beta");
    expect(authorizePluginOperation(principal(["orders.view"], "read"), invoice)).toBe(false);
    expect(authorizePluginOperation({ ...principal(["orders.view"], "read"), firstParty: true }, invoice)).toBe(true);
  });
});

describe("ctx.api.call as a plugin principal", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let binding: D1Database;
  let env: Env;

  beforeEach(async () => {
    ({ sqlite, db, binding } = createSqliteD1Database());
    env = pluginTestEnv(binding);
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
    sqlite.prepare(`INSERT INTO orders (id, customer_name, customer_phone, customer_email, shipping_address, city, zone, status)
      VALUES ('ord_rbac1', 'Rahim', '+8801711111111', 'rahim@buyer.test', 'House 1', 'city_1', 'zone_1', 'pending')`).run();
    await installPlugin(db, { manifest, source: "upload", bundleSha256: "e".repeat(64), actorUserId: "owner" });
    await activatePlugin(db, "acme.rbac", { actorUserId: "owner", expectedRevision: 1 });
  });
  afterEach(() => sqlite.close());

  const call = (operationId: string, input?: unknown) =>
    callPluginOperation({ pluginId: "acme.rbac", version: "1.0.0", operationId, input, db, env, ctx: pluginTestCtx() });
  const audit = () => sqlite.prepare("SELECT plugin_id, operation_id, outcome, http_status, error_class FROM agent_audit_events ORDER BY created_at, rowid").all();

  it("runs a granted read and a granted write, recording the write as the approving Super Admin", async () => {
    const read = await call("dashboard.resources.orders.get", { path: { id: "ord_rbac1" } });
    expect(read).toMatchObject({ ok: true, status: 200, error: null, data: { id: "ord_rbac1", status: "pending" } });

    const write = await call("dashboard.orders.comment_add", { path: { id: "ord_rbac1" }, body: { body: "Points granted" }, idempotencyKey: "plugin-comment-1" });
    expect(write.ok).toBe(true);
    expect(sqlite.prepare("SELECT kind, body, actor_id FROM order_events WHERE order_id = 'ord_rbac1' AND body = 'Points granted'").all())
      .toEqual([expect.objectContaining({ body: "Points granted", actor_id: "owner" })]);
    expect(audit()).toEqual([
      { plugin_id: "acme.rbac", operation_id: "dashboard.resources.orders.get", outcome: "success", http_status: 200, error_class: null },
      { plugin_id: "acme.rbac", operation_id: "dashboard.orders.comment_add", outcome: "success", http_status: write.status, error_class: null },
    ]);
  });

  it("names a schema refusal VALIDATION_ERROR, as the SDK's contract double does", async () => {
    const refused = await call("dashboard.orders.comment_add", { path: { id: "ord_rbac1" }, body: { body: 42 }, idempotencyKey: "plugin-comment-bad" });
    expect(refused).toMatchObject({ ok: false, status: 400, error: { code: "VALIDATION_ERROR" } });
  });

  it("reads buyer contact fields as null unless a protected customer data scope reveals them", async () => {
    // acme.rbac holds write_orders only: the order reads, its contact does not.
    const hidden = await call("dashboard.resources.orders.get", { path: { id: "ord_rbac1" } });
    expect(hidden).toMatchObject({
      ok: true,
      data: {
        id: "ord_rbac1",
        contact: { name: null, phone: null, email: null },
        shippingAddress: { name: null, phone: null, line1: null, placeIds: { city: "city_1", zone: "zone_1" } },
      },
    });
    // Field by field: names and phones granted, emails and street addresses not.
    await installPlugin(db, {
      manifest: { ...manifest, id: "acme.contacts", scopes: ["read_orders", "read_customer_names", "read_customer_phones"] },
      source: "upload", bundleSha256: "d".repeat(64), actorUserId: "owner",
    });
    await activatePlugin(db, "acme.contacts", { actorUserId: "owner", expectedRevision: 1 });
    const partial = await callPluginOperation({
      pluginId: "acme.contacts", version: "1.0.0", operationId: "dashboard.resources.orders.get", input: { path: { id: "ord_rbac1" } }, db, env, ctx: pluginTestCtx(),
    });
    expect(partial).toMatchObject({
      ok: true,
      data: {
        contact: { name: "Rahim", phone: "+8801711111111", email: null },
        shippingAddress: { name: "Rahim", line1: null, placeIds: { city: "city_1" } },
      },
    });
    const list = await callPluginOperation({
      pluginId: "acme.contacts", version: "1.0.0", operationId: "dashboard.resources.orders.list", input: {}, db, env, ctx: pluginTestCtx(),
    });
    expect((list.data as { orders: Array<Record<string, unknown>> }).orders[0]).toMatchObject({ contact: { name: "Rahim", email: null } });
    // The route itself still answers in full (staff and the merchant's agents): the projection is the app edge's.
    const route = await fetchRuntimeApiApp(new Request("https://api.shop.test/api/v1/admin/resources/orders/ord_rbac1"), withOperationDispatchPrincipal(env, {
      kind: "plugin", pluginId: "acme.rbac", version: "1.0.0", pluginName: "Acme RBAC", actorUserId: "owner", firstParty: false,
      permissions: new Set(["orders.view"]), protectedData: new Set(), riskCeiling: "read",
    }), pluginTestCtx());
    expect(((await route.json()) as { data: Record<string, unknown> }).data).toMatchObject({ contact: { email: "rahim@buyer.test" } });
  });

  it("refuses looking a buyer up by contact data the grant does not reveal", async () => {
    // acme.rbac holds no protected data scope: an email or phone filter is a 403, not an empty page.
    expect(await call("dashboard.resources.orders.list", { query: { email: "rahim@buyer.test" } }))
      .toMatchObject({ ok: false, status: 403, error: { code: "contact_scope_required" } });
    expect(await call("dashboard.resources.orders.list", { query: { phone: "+8801711111111" } }))
      .toMatchObject({ ok: false, status: 403, error: { code: "contact_scope_required" } });
    await installPlugin(db, {
      manifest: { ...manifest, id: "acme.phones", scopes: ["read_orders", "read_customer_phones"] },
      source: "upload", bundleSha256: "b".repeat(64), actorUserId: "owner",
    });
    await activatePlugin(db, "acme.phones", { actorUserId: "owner", expectedRevision: 1 });
    const phones = (query: Record<string, string>) => callPluginOperation({
      pluginId: "acme.phones", version: "1.0.0", operationId: "dashboard.resources.orders.list", input: { query }, db, env, ctx: pluginTestCtx(),
    });
    const byPhone = await phones({ phone: "+8801711111111" });
    expect(byPhone.ok).toBe(true);
    expect((byPhone.data as { orders: Array<{ id: string }> }).orders.map((order) => order.id)).toEqual(["ord_rbac1"]);
    expect(await phones({ email: "rahim@buyer.test" })).toMatchObject({ ok: false, status: 403, error: { code: "contact_scope_required" } });
    // A first-party app's free-text search over the dashboard's (beta) list is gated the same way.
    await installPlugin(db, {
      manifest: { ...manifest, id: "scalius.phones", scopes: ["read_orders", "read_customer_phones"] },
      source: "bundled", bundleSha256: "a".repeat(64), actorUserId: "owner",
    });
    await activatePlugin(db, "scalius.phones", { actorUserId: "owner", expectedRevision: 1 });
    const search = (term: string) => callPluginOperation({
      pluginId: "scalius.phones", version: "1.0.0", operationId: "dashboard.orders.list", input: { query: { search: term } }, db, env, ctx: pluginTestCtx(),
    });
    expect((await search("01711111111")).ok).toBe(true);
    expect(await search("rahim@buyer.test")).toMatchObject({ ok: false, status: 403, error: { code: "contact_scope_required" } });
    expect(await search("Rahim")).toMatchObject({ ok: false, status: 403, error: { code: "contact_scope_required" } });
  });

  it("changes stock only with write_inventory, never write_products", async () => {
    await installPlugin(db, {
      manifest: { ...manifest, id: "acme.catalog", scopes: ["write_products"] },
      source: "upload", bundleSha256: "c".repeat(64), actorUserId: "owner",
    });
    await activatePlugin(db, "acme.catalog", { actorUserId: "owner", expectedRevision: 1 });
    const adjust = await callPluginOperation({
      pluginId: "acme.catalog", version: "1.0.0", operationId: "dashboard.inventory.adjust",
      input: { path: { variantId: "var_x" }, body: { delta: 1 }, idempotencyKey: "plugin-adjust-1" }, db, env, ctx: pluginTestCtx(),
    });
    expect(adjust).toMatchObject({ ok: false, status: 403, error: { code: "api.operation_forbidden" } });
  });

  it("refuses an operation the grant does not cover, and audits the refusal", async () => {
    const denied = await call("dashboard.resources.customers.list");
    expect(denied).toMatchObject({ ok: false, status: 403, error: { code: "api.operation_forbidden" } });
    expect(audit()).toEqual([{ plugin_id: "acme.rbac", operation_id: "dashboard.resources.customers.list", outcome: "denied", http_status: 403, error_class: "operation_forbidden" }]);
  });

  it("keeps a third-party app on the stable app API, whatever its scopes cover", async () => {
    // read_settings covers both; the invoice read is beta and the credential read security risk.
    const invoice = await call("dashboard.orders.invoice_get", { path: { id: "ord_rbac1" } });
    expect(invoice).toMatchObject({ ok: false, status: 403, error: { code: "api.operation_not_stable" } });
    expect(await call("dashboard.settings.email_get")).toMatchObject({ ok: false, status: 403, error: { code: "api.operation_not_stable" } });
    expect(await call("dashboard.team.users.list")).toMatchObject({ ok: false, status: 403, error: { code: "api.operation_not_stable" } });
    expect(audit()).toContainEqual({ plugin_id: "acme.rbac", operation_id: "dashboard.orders.invoice_get", outcome: "denied", http_status: 403, error_class: "operation_forbidden" });
    expect((await call("dashboard.settings.business_get")).ok).toBe(true);
  });

  it("lets a bundled first-party app call beta operations, never internal or security ones", async () => {
    await installPlugin(db, { manifest: { ...manifest, id: "scalius.rbac" }, source: "bundled", bundleSha256: "f".repeat(64), actorUserId: "owner" });
    await activatePlugin(db, "scalius.rbac", { actorUserId: "owner", expectedRevision: 1 });
    const first = (operationId: string, input?: unknown) =>
      callPluginOperation({ pluginId: "scalius.rbac", version: "1.0.0", operationId, input, db, env, ctx: pluginTestCtx() });
    expect((await first("dashboard.orders.invoice_get", { path: { id: "ord_rbac1" } })).error?.code).not.toBe("api.operation_not_stable");
    expect(await first("dashboard.settings.email_get")).toMatchObject({ ok: false, status: 403, error: { code: "api.operation_forbidden" } });
    expect(await first("dashboard.team.users.list")).toMatchObject({ ok: false, status: 403, error: { code: "api.operation_not_stable" } });
  });

  it("grants nothing from a tampered grant that names anything but scopes", async () => {
    sqlite.prepare(`UPDATE plugin_installations SET grant_json = json_set(grant_json, '$.scopes', json('["read_orders","team.view","webhooks.view"]'))`).run();
    expect(await call("dashboard.resources.orders.get", { path: { id: "ord_rbac1" } })).toMatchObject({ ok: false, status: 401, error: { code: "installation.inactive" } });
  });

  it("refuses a forged principal at the admin auth middleware, whatever it claims", async () => {
    const forged: PluginPrincipal = {
      kind: "plugin",
      pluginId: "acme.rbac",
      version: "1.0.0",
      pluginName: "Acme RBAC",
      actorUserId: "owner",
      firstParty: true,
      permissions: new Set(["team.view", "team.manage", "orders.view"]),
      protectedData: new Set(),
      riskCeiling: "financial",
    };
    const ctx = pluginTestCtx();
    const users = await fetchRuntimeApiApp(new Request("https://api.shop.test/api/v1/admin/auth/users"), withOperationDispatchPrincipal(env, forged), ctx);
    expect(users.status).toBe(403);
    // Credentials cannot ride along with an internal dispatch.
    const withCookie = await fetchRuntimeApiApp(
      new Request("https://api.shop.test/api/v1/admin/orders/ord_rbac1", { headers: { Cookie: "better-auth.session_token=x" } }),
      withOperationDispatchPrincipal(env, forged),
      ctx,
    );
    expect(withCookie.status).toBe(403);
    // A principal of another version, or of a plugin that is not active, is refused.
    const stale = await fetchRuntimeApiApp(new Request("https://api.shop.test/api/v1/admin/orders/ord_rbac1"), withOperationDispatchPrincipal(env, { ...forged, version: "0.9.0" }), ctx);
    expect(stale.status).toBe(401);
    const allowed = await fetchRuntimeApiApp(new Request("https://api.shop.test/api/v1/admin/resources/orders/ord_rbac1"), withOperationDispatchPrincipal(env, forged), ctx);
    expect(allowed.status).toBe(200);
  });

  it("requires idempotency keys where the operation does, and validates input", async () => {
    await installPlugin(db, {
      manifest: { ...manifest, id: "acme.stock", scopes: ["write_inventory"] },
      source: "upload", bundleSha256: "9".repeat(64), actorUserId: "owner",
    });
    await activatePlugin(db, "acme.stock", { actorUserId: "owner", expectedRevision: 1 });
    expect(await callPluginOperation({
      pluginId: "acme.stock", version: "1.0.0", operationId: "dashboard.inventory.adjust",
      input: { path: { variantId: "var_x" }, body: { delta: 1 } }, db, env, ctx: pluginTestCtx(),
    })).toMatchObject({ ok: false, status: 400, error: { code: "idempotency_key_required" } });
    // A third-party app never reaches the dashboard's own order form.
    expect(await call("dashboard.orders.create", { body: {} })).toMatchObject({ ok: false, status: 403, error: { code: "api.operation_not_stable" } });
    expect(await call("dashboard.resources.orders.get", { path: { id: "ord_rbac1" }, extra: 1 })).toMatchObject({ ok: false, status: 400, error: { code: "api.invalid_input" } });
    expect(await call("dashboard.orders.teleport")).toMatchObject({ ok: false, status: 404, error: { code: "api.unknown_operation" } });
    expect(await call("storefront.products.list")).toMatchObject({ ok: false, status: 404, error: { code: "api.unknown_operation" } });
  });

  it("stops when the plugin is deactivated, its approver is gone, or the rate limit is reached", async () => {
    const limited = await callPluginOperation({
      pluginId: "acme.rbac", version: "1.0.0", operationId: "dashboard.resources.orders.get", input: { path: { id: "ord_rbac1" } }, db,
      env: pluginTestEnv(binding, { RL_STANDARD: { limit: vi.fn(async () => ({ success: false })) } }),
      ctx: pluginTestCtx(),
    });
    expect(limited).toMatchObject({ ok: false, status: 429, error: { code: "rate_limited" } });

    const installation = await requirePluginInstallation(db, "acme.rbac");
    await deactivatePlugin(db, "acme.rbac", { expectedRevision: installation.revision });
    expect(await call("dashboard.resources.orders.get", { path: { id: "ord_rbac1" } })).toMatchObject({ ok: false, status: 401, error: { code: "installation.inactive" } });

    const again = await requirePluginInstallation(db, "acme.rbac");
    await activatePlugin(db, "acme.rbac", { actorUserId: "owner", expectedRevision: again.revision });
    sqlite.prepare("DELETE FROM user WHERE id = 'owner'").run();
    expect(await call("dashboard.resources.orders.get", { path: { id: "ord_rbac1" } })).toMatchObject({ ok: false, status: 401 });
  });
});
