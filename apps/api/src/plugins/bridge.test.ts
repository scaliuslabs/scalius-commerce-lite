// The bridge enforces an installation's authority on every capability: only
// declared objects, only allowed https hosts (every redirect hop checked,
// private and mapped addresses refused, credentials dropped across origins),
// only the plugin's own custom fields. Failures cross as `[code] message` in
// the in-process adapter exactly as over RPC.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { activatePlugin, installPlugin } from "@scalius/core/modules/plugins";
import { PLUGIN_API_VERSION, type PluginManifestInput } from "@scalius/shared/plugins";
import { PluginBridgeHost, isPluginHostAllowed, type PluginBridgeEnvironment } from "./bridge";
import { createInProcessBridge } from "./loaders/bundled";
import { pluginBridgeAuthority } from "./host";
import { pluginTestCtx, pluginTestEnv } from "./testing/fixtures";

const messaging = vi.hoisted(() => ({
  sendEmail: vi.fn(async () => ({ success: true, provider: "log" })),
  sendAdminPushNotice: vi.fn(async () => undefined),
}));
vi.mock("@scalius/core/integrations/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/integrations/email")>()),
  sendEmail: messaging.sendEmail,
}));
vi.mock("@scalius/core/modules/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@scalius/core/modules/notifications")>()),
  sendAdminPushNotice: messaging.sendAdminPushNotice,
}));

const manifest: PluginManifestInput = {
  id: "acme.bridge",
  name: "Acme Bridge",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Exercises the bridge.",
  author: { name: "Acme" },
  allowedHosts: ["api.acme.example", "*.cdn.acme.example"],
  objects: { notes: { name: "Notes", fields: [{ key: "owner", name: "Owner", type: "single_line_text" }, { key: "tags", name: "Tags", type: "list.single_line_text" }], indexes: ["owner"], unique: [] } },
  customFields: [{ ownerType: "product", key: "points", name: "Points", type: "integer" }],
};

describe("plugin bridge", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let environment: PluginBridgeEnvironment;
  let host: PluginBridgeHost;
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

  beforeEach(async () => {
    const created = createSqliteD1Database();
    ({ sqlite, db } = created);
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
    await installPlugin(db, { manifest, source: "upload", bundleSha256: "1".repeat(64) });
    const installation = await activatePlugin(db, "acme.bridge", { actorUserId: "owner", expectedRevision: 1 });
    const env = pluginTestEnv(created.binding);
    environment = { env, ctx: pluginTestCtx(), db: () => db, composedEnv: async () => env };
    host = new PluginBridgeHost({ pluginId: "acme.bridge", version: "1.0.0", authority: pluginBridgeAuthority(installation) }, environment);
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    sqlite.close();
  });

  it("matches exact hosts and subdomains of a wildcard, never the wildcard's apex", () => {
    const allowed = ["api.acme.example", "*.cdn.acme.example"];
    expect(isPluginHostAllowed("api.acme.example", allowed)).toBe(true);
    expect(isPluginHostAllowed("API.ACME.EXAMPLE.", allowed)).toBe(true);
    expect(isPluginHostAllowed("img.cdn.acme.example", allowed)).toBe(true);
    expect(isPluginHostAllowed("cdn.acme.example", allowed)).toBe(false);
    expect(isPluginHostAllowed("evilcdn.acme.example", allowed)).toBe(false);
    expect(isPluginHostAllowed("api.acme.example.evil.com", allowed)).toBe(false);
  });

  it("reaches a non-default port only through its exact host:port entry", () => {
    const allowed = ["api.acme.example", "sandbox.acme.example:10061", "*.cdn.acme.example"];
    expect(isPluginHostAllowed("sandbox.acme.example", allowed, "10061")).toBe(true);
    expect(isPluginHostAllowed("sandbox.acme.example", allowed, "10062")).toBe(false);
    expect(isPluginHostAllowed("sandbox.acme.example", allowed)).toBe(false);
    expect(isPluginHostAllowed("api.acme.example", allowed, "8443")).toBe(false);
    expect(isPluginHostAllowed("img.cdn.acme.example", allowed, "8443")).toBe(false);
    expect(isPluginHostAllowed("api.acme.example", allowed, "443")).toBe(true);
  });

  it("fetches an allowed https host and returns status, headers and text", async () => {
    fetchMock.mockResolvedValueOnce(new Response("pong", { status: 200, headers: { "X-Ok": "1", "Set-Cookie": "a=b" } }));
    const result = await host.httpFetch("https://api.acme.example/ping", { method: "POST", headers: { Authorization: "Bearer t" }, body: "{}" });
    expect(result).toEqual({ status: 200, headers: expect.objectContaining({ "x-ok": "1" }), body: "pong" });
    expect(result.headers["set-cookie"]).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("https://api.acme.example/ping", expect.objectContaining({ method: "POST", redirect: "manual", body: "{}" }));
  });

  it.each([
    ["plain http", "http://api.acme.example/"],
    ["an undeclared host", "https://evil.example/"],
    ["loopback", "https://127.0.0.1/"],
    ["metadata", "https://169.254.169.254/latest"],
    ["an IPv4-mapped IPv6 literal", "https://[::ffff:127.0.0.1]/"],
    ["localhost", "https://localhost/"],
    ["embedded credentials", "https://user:pass@api.acme.example/"],
    ["a non-default port without its host:port entry", "https://api.acme.example:8443/"],
    ["a wildcard apex", "https://cdn.acme.example/"],
  ])("refuses %s before any request", async (_label, url) => {
    const bridge = createInProcessBridge(host);
    await expect(bridge.httpFetch(url)).rejects.toThrow(/^\[http\.not_allowed\] /);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-checks every redirect hop and drops credentials across origins", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "https://img.cdn.acme.example/a" } }));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 303, headers: { Location: "/b" } }));
    fetchMock.mockResolvedValueOnce(new Response("done", { status: 200 }));
    const result = await host.httpFetch("https://api.acme.example/start", { method: "POST", headers: { Authorization: "Bearer t", "X-Trace": "1" }, body: "x" });
    expect(result.body).toBe("done");
    const [first, second, third] = fetchMock.mock.calls;
    expect(first![1]!.headers).toEqual({ Authorization: "Bearer t", "X-Trace": "1" });
    expect(second![0]).toBe("https://img.cdn.acme.example/a");
    expect(second![1]!.headers).toEqual({ "X-Trace": "1" });
    expect(third![0]).toBe("https://img.cdn.acme.example/b");
    expect(third![1]).toMatchObject({ method: "GET" });
    expect(third![1]!.body).toBeUndefined();

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 301, headers: { Location: "https://10.0.0.5/internal" } }));
    await expect(createInProcessBridge(host).httpFetch("https://api.acme.example/")).rejects.toThrow(/^\[http\.not_allowed\] /);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses platform-owned headers, oversized responses and plugins without allowedHosts", async () => {
    await expect(createInProcessBridge(host).httpFetch("https://api.acme.example/", { headers: { Host: "evil.example" } }))
      .rejects.toThrow(/^\[http\.invalid_request\] /);
    fetchMock.mockResolvedValueOnce(new Response("x".repeat(1024 * 1024 + 1)));
    await expect(createInProcessBridge(host).httpFetch("https://api.acme.example/big")).rejects.toThrow(/^\[http\.failed\] /);
    const offline = new PluginBridgeHost({
      pluginId: "acme.bridge",
      version: "1.0.0",
      authority: { permissions: [], allowedHosts: [], objects: {}, customFields: [] },
    }, environment);
    await expect(createInProcessBridge(offline).httpFetch("https://api.acme.example/")).rejects.toThrow(/^\[http\.not_allowed\] /);
  });

  it("limits the app's own outbound requests, but not a provider operation's calls to its provider", async () => {
    fetchMock.mockImplementation(async () => new Response("ok", { status: 200 }));
    const limiter = environment.env.RL_STANDARD as unknown as { limit: ReturnType<typeof vi.fn> };
    limiter.limit.mockResolvedValue({ success: false });
    await expect(createInProcessBridge(host).httpFetch("https://api.acme.example/")).rejects.toThrow(/^\[rate_limited\] /);
    const provider = new PluginBridgeHost({ ...host["props"], provider: { kind: "sms" } }, environment);
    await expect(createInProcessBridge(provider).httpFetch("https://api.acme.example/send", { method: "POST", body: "x" })).resolves.toMatchObject({ status: 200 });
    // The store's messaging stays refused inside a provider operation.
    await expect(createInProcessBridge(provider).messagingSms({ to: "+8801711111111", text: "hi" })).rejects.toThrow(/^\[messaging\.not_allowed\] /);
    limiter.limit.mockResolvedValue({ success: true });
  });

  it("only reaches declared objects and returns copies", async () => {
    const bridge = createInProcessBridge(host);
    await expect(bridge.objectsGet("secrets", "x")).rejects.toThrow(/^\[object\.undeclared_type\] /);
    await expect(bridge.objectsWrite([{ object: "secrets", op: "put", id: "x", record: {} }])).rejects.toThrow(/^\[object\.undeclared_type\] /);
    const record = { owner: "c1", tags: ["a"] };
    expect(await bridge.objectsWrite([{ object: "notes", op: "put", id: "n1", record, expectedRevision: null }])).toEqual([1]);
    record.tags.push("mutated");
    expect(await bridge.objectsGet("notes", "n1")).toEqual({ data: { owner: "c1", tags: ["a"] }, revision: 1, handle: null, status: "active" });
    await expect(bridge.objectsWrite([{ object: "notes", op: "put", id: "n1", record, expectedRevision: null }])).rejects.toThrow(/^\[object\.conflict\] /);
    expect(await bridge.kvSet("k", { n: 1 }, { expectedRevision: null })).toEqual({ revision: 1 });
    await expect(bridge.kvSet("k", { n: 2 }, { expectedRevision: null })).rejects.toThrow(/^\[kv\.conflict\] /);
    expect(await bridge.kvGet("k")).toEqual({ value: { n: 1 }, revision: 1 });
    expect(await bridge.objectsQuery("notes", { where: { owner: "c1" } })).toMatchObject({ records: [{ id: "n1" }], nextCursor: null });
    await expect(bridge.objectsQuery("notes", { where: { tags: "a" } })).rejects.toThrow(/^\[object\.unindexed_query\] /);
  });

  it("writes and reads only its own namespace's declared custom fields", async () => {
    sqlite.prepare("INSERT INTO products (id, name, price_minor, slug, is_active) VALUES ('p_cf', 'Panjabi', 100000, 'panjabi-cf', 1)").run();
    const bridge = createInProcessBridge(host);
    await bridge.customFieldsSet("product", "p_cf", { points: 25 });
    expect(await bridge.customFieldsGet("product", "p_cf")).toEqual({ points: 25 });
    expect(sqlite.prepare("SELECT namespace, key, type FROM custom_field_definitions").all())
      .toEqual([{ namespace: "acme.bridge", key: "points", type: "integer" }]);
    await bridge.customFieldsSet("product", "p_cf", { points: 30 });
    expect(await bridge.customFieldsGet("product", "p_cf")).toEqual({ points: 30 });
    await expect(bridge.customFieldsSet("product", "p_cf", { tier: "gold" })).rejects.toThrow(/^\[custom_fields\.undeclared\] /);
    await expect(bridge.customFieldsGet("customer", "c1")).rejects.toThrow(/^\[custom_fields\.undeclared\] /);
  });

  it("keeps internals out of errors", async () => {
    const broken = new PluginBridgeHost({ pluginId: "acme.bridge", version: "1.0.0", authority: pluginBridgeAuthority((await import("@scalius/core/modules/plugins").then((module) => module.requirePluginInstallation(db, "acme.bridge")))) }, {
      ...environment,
      db: () => { throw new Error("SQLITE_BUSY: database is locked at /var/secret/path"); },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(createInProcessBridge(broken).kvGet("k")).rejects.toThrow("[internal] The platform could not complete the request.");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("/var/secret/path");
    warn.mockRestore();
  });
});

describe("plugin messaging", () => {
  let sqlite: DatabaseSync;
  let environment: PluginBridgeEnvironment;
  const bridgeWith = (permissions: string[]) => createInProcessBridge(new PluginBridgeHost({
    pluginId: "acme.bridge",
    version: "1.0.0",
    authority: { permissions, allowedHosts: [], objects: {}, customFields: [] },
  }, environment));

  beforeEach(async () => {
    const created = createSqliteD1Database();
    sqlite = created.sqlite;
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
    await installPlugin(created.db, { manifest: { ...manifest, scopes: ["read_customers", "write_marketing"] }, source: "upload", bundleSha256: "1".repeat(64) });
    await activatePlugin(created.db, "acme.bridge", { actorUserId: "owner", expectedRevision: 1 });
    const env = pluginTestEnv(created.binding);
    environment = { env, ctx: pluginTestCtx(), db: () => created.db, composedEnv: async () => env };
    sqlite.prepare("INSERT INTO customers (id, name, phone, email) VALUES ('cus_1', 'Rahim', '+8801711111111', 'rahim@example.com')").run();
    messaging.sendEmail.mockClear();
    messaging.sendAdminPushNotice.mockClear();
  });
  afterEach(() => sqlite.close());

  it.each([
    ["deactivation", "UPDATE plugin_installations SET status = 'disabled' WHERE plugin_id = 'acme.bridge'"],
    ["code replacement", "UPDATE plugin_installations SET version = '2.0.0' WHERE plugin_id = 'acme.bridge'"],
    ["approver ban", "UPDATE user SET banned = 1 WHERE id = 'owner'"],
  ])("refuses every messaging capability after %s during an invocation", async (_reason, change) => {
    const bridge = bridgeWith(["customers.view", "marketing.send"]);
    sqlite.exec(change);
    await expect(bridge.messagingEmail({ customerId: "cus_1", subject: "Hi", html: "Hi" })).rejects.toThrow(/^\[installation\.inactive\]/);
    await expect(bridge.messagingSms({ customerId: "cus_1", text: "Hi" })).rejects.toThrow(/^\[installation\.inactive\]/);
    await expect(bridge.messagingPush!({ customerId: "cus_1", title: "Hi" })).rejects.toThrow(/^\[installation\.inactive\]/);
    await expect(bridge.messagingNotifyStaff({ title: "Hi" })).rejects.toThrow(/^\[installation\.inactive\]/);
    expect(messaging.sendEmail).not.toHaveBeenCalled();
    expect(messaging.sendAdminPushNotice).not.toHaveBeenCalled();
  });

  it("rechecks revoked customer and marketing scopes without widening invocation permissions", async () => {
    const bridge = bridgeWith(["customers.view", "marketing.send"]);
    sqlite.exec("UPDATE plugin_installations SET grant_json = json_set(grant_json, '$.scopes', json('[\"read_customers\"]')) WHERE plugin_id = 'acme.bridge'");
    await expect(bridge.messagingEmail({ customerId: "cus_1", subject: "Offer", html: "Offer", marketing: true })).rejects.toThrow(/write_marketing/);
    sqlite.exec("UPDATE plugin_installations SET grant_json = json_set(grant_json, '$.scopes', json('[]')) WHERE plugin_id = 'acme.bridge'");
    await expect(bridge.messagingEmail({ customerId: "cus_1", subject: "Hi", html: "Hi" })).rejects.toThrow(/read_customers/);
    await expect(bridge.messagingSms({ customerId: "cus_1", text: "Hi" })).rejects.toThrow(/read_customers/);
    await expect(bridge.messagingPush!({ customerId: "cus_1", title: "Hi" })).rejects.toThrow(/read_customers/);
    expect(messaging.sendEmail).not.toHaveBeenCalled();
  });

  it("sends to customers only with customers.view, resolving the address itself", async () => {
    await expect(bridgeWith([]).messagingEmail({ customerId: "cus_1", subject: "Hi", html: "<p>Hi</p>" }))
      .rejects.toThrow(/^\[messaging\.not_allowed\] /);
    expect(await bridgeWith(["customers.view"]).messagingEmail({ customerId: "cus_1", subject: "Hi", html: "<p>Hi</p>" })).toEqual({ queued: true });
    expect(messaging.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "rahim@example.com", subject: "Hi" }), expect.anything());
    await expect(bridgeWith(["customers.view"]).messagingEmail({ customerId: "cus_1", to: "x@example.com", subject: "Hi", html: "x" }))
      .rejects.toThrow(/^\[messaging\.invalid\] /);
  });

  it("sends an email once per idempotency key, and again after a failed send", async () => {
    const bridge = bridgeWith(["customers.view"]);
    const send = (key: string) => bridge.messagingEmail({ customerId: "cus_1", subject: "Order", html: "<p>New order</p>", idempotencyKey: key });
    vi.mocked(messaging.sendEmail).mockClear();
    vi.mocked(messaging.sendEmail).mockResolvedValueOnce({ success: false } as never);
    expect(await send("split-notice-1")).toEqual({ queued: false });
    expect(await send("split-notice-1")).toEqual({ queued: true });
    expect(await send("split-notice-1")).toEqual({ queued: true, duplicate: true });
    expect(messaging.sendEmail).toHaveBeenCalledTimes(2);
    // Another key is another message.
    expect(await send("split-notice-2")).toEqual({ queued: true });
    expect(messaging.sendEmail).toHaveBeenCalledTimes(3);
    await expect(send("short")).rejects.toThrow(/^\[messaging\.invalid\] idempotencyKey/);
  });

  it("sends `to` only a staff member, an address its declared recipient fields hold, or anyone with send_messages_any", async () => {
    const db = environment.db();
    const letters: PluginManifestInput = {
      ...manifest,
      id: "acme.letters",
      scopes: ["read_customers"],
      objects: { subscribers: { name: "Subscribers", fields: [{ key: "email", name: "Email", type: "single_line_text" }, { key: "phone", name: "Phone", type: "single_line_text" }], unique: ["email"], indexes: ["phone"] } },
      customFields: [],
      messaging: { recipients: [{ object: "subscribers", field: "email" }, { object: "subscribers", field: "phone" }] },
    };
    await installPlugin(db, { manifest: letters, source: "upload", bundleSha256: "2".repeat(64) });
    const installation = await activatePlugin(db, "acme.letters", { actorUserId: "owner", expectedRevision: 1 });
    expect(installation.grant?.messageRecipients).toEqual(["subscribers.email", "subscribers.phone"]);
    const bridge = createInProcessBridge(new PluginBridgeHost({ pluginId: "acme.letters", version: "1.0.0", authority: pluginBridgeAuthority(installation) }, environment));
    const email = (to: string) => bridge.messagingEmail({ to, subject: "News", html: "<p>News</p>" });
    // read_customers reaches customers by id, never an arbitrary address from the store's sender.
    await expect(email("stranger@example.com")).rejects.toThrow(/^\[messaging\.recipient_not_allowed\] /);
    await expect(bridge.messagingSms({ to: "+8801722222222", text: "Hi" })).rejects.toThrow(/^\[messaging\.recipient_not_allowed\] /);
    expect(messaging.sendEmail).not.toHaveBeenCalled();
    // The store's staff.
    expect(await email("OWNER@shop.test")).toEqual({ queued: true });
    // An address its own records hold, found through the field's unique set.
    await bridge.objectsWrite([{ object: "subscribers", op: "put", id: "s1", record: { email: "reader@example.com", phone: "+8801722222222" } }]);
    expect(await email("reader@example.com")).toEqual({ queued: true });
    expect(messaging.sendEmail).toHaveBeenLastCalledWith(expect.objectContaining({ to: "reader@example.com" }), expect.anything());
    // A revoked recipient field applies at once.
    sqlite.exec("UPDATE plugin_installations SET grant_json = json_set(grant_json, '$.messageRecipients', json('[]')) WHERE plugin_id = 'acme.letters'");
    await expect(email("reader@example.com")).rejects.toThrow(/^\[messaging\.recipient_not_allowed\] /);
    // send_messages_any (sensitive) reaches any address.
    sqlite.exec("UPDATE plugin_installations SET grant_json = json_set(grant_json, '$.scopes', json('[\"read_customers\",\"send_messages_any\"]')) WHERE plugin_id = 'acme.letters'");
    expect(await email("stranger@example.com")).toEqual({ queued: true });
    // Size limits: HTML is measured in UTF-8 bytes.
    await expect(bridge.messagingEmail({ to: "stranger@example.com", subject: "Big", html: "অ".repeat(40_000) })).rejects.toThrow(/^\[messaging\.invalid\] html is text of at most 102400 bytes/);
  });

  it("requires marketing.send for marked marketing without weakening transactional access", async () => {
    const bridge = bridgeWith(["customers.view"]);
    await expect(bridge.messagingEmail({ customerId: "cus_1", subject: "Offer", html: "Offer", marketing: true })).rejects.toThrow(/write_marketing/);
    await expect(bridge.messagingSms({ customerId: "cus_1", text: "Offer", marketing: true })).rejects.toThrow(/write_marketing/);
  });

  it("sends marketing only to a current subscription, with the unsubscribe footer and list headers", async () => {
    const bridge = bridgeWith(["customers.view", "marketing.send"]);
    const env = await environment.composedEnv();
    (env as unknown as Record<string, unknown>).SCALIUS_SECRET = "test-master-secret-that-is-long-enough-123456";
    // Not subscribed: nothing is sent.
    expect(await bridge.messagingEmail({ customerId: "cus_1", subject: "Eid sale", html: "<p>20% off</p>", marketing: true })).toEqual({ queued: false });
    expect(messaging.sendEmail).not.toHaveBeenCalled();
    await expect(bridge.messagingEmail({ to: "rahim@example.com", subject: "Eid", html: "x", marketing: true }))
      .rejects.toThrow(/^\[messaging\.invalid\] /);
    sqlite.prepare(`INSERT INTO customer_marketing_consents (customer_id, channel, state, contact, source, actor, subscribed_at)
      VALUES ('cus_1', 'email', 'subscribed', 'rahim@example.com', 'newsletter', 'buyer', 1)`).run();
    expect(await bridge.messagingEmail({ customerId: "cus_1", subject: "Eid sale", html: "<p>20% off</p>", marketing: true })).toEqual({ queued: true });
    const [options] = messaging.sendEmail.mock.calls.at(-1) as unknown as [{ to: string; html: string; text: string; headers: Record<string, string> }];
    expect(options.to).toBe("rahim@example.com");
    expect(options.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(options.headers["List-Unsubscribe"]).toMatch(/^<https:\/\/shop\.test\/newsletter\/unsubscribe\?token=u1\.[^>]+>$/);
    expect(options.html).toContain("https://shop.test/newsletter/unsubscribe?token=");
    expect(options.text).toContain("Unsubscribe: https://shop.test/newsletter/unsubscribe?token=");
    // Consent covers an address: after the e-mail changes, marketing stops.
    sqlite.prepare("UPDATE customers SET email = 'new@example.com' WHERE id = 'cus_1'").run();
    expect(await bridge.messagingEmail({ customerId: "cus_1", subject: "Eid sale", html: "x", marketing: true })).toEqual({ queued: false });
  });

  it("notifies staff with a dashboard link only", async () => {
    await bridgeWith([]).messagingNotifyStaff({ title: "Points expired", body: "12 customers", url: "/admin/apps/acme" });
    expect(messaging.sendAdminPushNotice).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      title: "Points expired",
      body: "12 customers",
      link: "https://admin.shop.test/admin/apps/acme",
      data: { pluginId: "acme.bridge", notificationType: "plugin_notice" },
    });
    await expect(bridgeWith([]).messagingNotifyStaff({ title: "x", url: "https://evil.example/" })).rejects.toThrow(/^\[messaging\.invalid\] /);
  });
});

