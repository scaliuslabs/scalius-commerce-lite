// App SMS, email and fraud providers through the bundled loader (the Workers
// Free path), as core calls them: the port's outcomes on every failure the
// app can raise, selection from the merchant's saved settings, failing closed
// when the app cannot be used, and a customer sign-in code sent from the
// OTP sender's path through an app SMS provider.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { activatePlugin, installPlugin, listPluginLogs, writePluginSettings } from "@scalius/core/modules/plugins";
import { getEmailProviderReadiness, sendEmail } from "@scalius/core/integrations/email";
import { getActiveSmsProvider, getSmsProviderReadiness, saveSmsSettings } from "@scalius/core/integrations/sms";
import { fraudLookupWithActiveProvider, saveFraudProvider, testFraudProvider } from "@scalius/core/modules/fraud-checker";
import { sendOtp } from "@scalius/core/modules/customers";
import { customerAuthDocument, emailDocument } from "@scalius/core/modules/settings";
import { PROVIDER_PORTS } from "@scalius/shared/plugins/providers";
import { pluginTestCtx, pluginTestEnv } from "./testing/fixtures";
import {
  NOTIFY_FIXTURE_CODE,
  NOTIFY_FIXTURE_ID,
  NOTIFY_FIXTURE_MANIFEST,
  NOTIFY_FIXTURE_SECRET,
} from "./testing/messaging-fixture";

const sha256 = createHash("sha256").update(NOTIFY_FIXTURE_CODE).digest("hex");
const fixture = vi.hoisted(() => ({ module: null as unknown, sha256: "" }));

// Every provider runtime (request, queue, plugin bridge) hosts the fixture as a bundled plugin.
vi.mock("./providers/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providers/runtime")>();
  const runtimeFor = (env: Env, db: Database) => ({
    env,
    db,
    canRun: () => true,
    host: async () => {
      const [{ PluginHost }, { BundledLoader }, { pluginTestCtx: testCtx }] = await Promise.all([
        import("./host"),
        import("./loaders/bundled"),
        import("./testing/fixtures"),
      ]);
      const ctx = testCtx();
      const loader = new BundledLoader(
        { env, ctx, db: () => db, composedEnv: async () => env },
        { "acme.notify": { version: "1.0.0", sha256: fixture.sha256, load: async () => fixture.module } },
      );
      return new PluginHost({ env, ctx, db, loaderFor: () => loader });
    },
  });
  return {
    ...actual,
    createAppProviderRuntime: (options: { env: Env; db: Database }) => runtimeFor(options.env, options.db),
    requestProviderRuntime: (c: { env: Env; get(key: "db"): Database }) => runtimeFor(c.env, c.get("db")),
  };
});

import { createAppProviders, detachedAppProviders } from "./providers/app-providers";
import { createAppProviderRuntime } from "./providers/runtime";
import { deliverAuthOtp } from "../background/otp";

// A real AES key: fraud rows and pinned OTP contacts are encrypted with it, app settings sealed under it.
const KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 8).toString("base64");
const TEXTS = `${NOTIFY_FIXTURE_ID}:texts`;
const MAIL = `${NOTIFY_FIXTURE_ID}:mail`;
const RADAR = `${NOTIFY_FIXTURE_ID}:radar`;

let workdir: string;
beforeAll(async () => {
  workdir = mkdtempSync(join(tmpdir(), "scalius-messaging-fixture-"));
  const file = join(workdir, "notify.mjs");
  writeFileSync(file, NOTIFY_FIXTURE_CODE);
  fixture.module = await import(pathToFileURL(file).href);
  fixture.sha256 = sha256;
});
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

describe("app messaging and fraud providers through the bundled loader", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let env: Env;

  beforeEach(async () => {
    let binding: D1Database;
    ({ sqlite, db, binding } = createSqliteD1Database());
    env = pluginTestEnv(binding, { CREDENTIAL_ENCRYPTION_KEY: KEY });
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
    const installed = await installPlugin(db, { manifest: NOTIFY_FIXTURE_MANIFEST, source: "upload", bundleSha256: sha256, actorUserId: "owner" });
    const configured = await writePluginSettings(db, NOTIFY_FIXTURE_ID, { api_key: NOTIFY_FIXTURE_SECRET }, {
      expectedRevision: installed.revision,
      credentialEncryptionKey: KEY,
    });
    await activatePlugin(db, NOTIFY_FIXTURE_ID, { actorUserId: "owner", expectedRevision: configured.revision });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    sqlite.close();
    vi.restoreAllMocks();
  });

  const apps = (key = KEY) => createAppProviders(createAppProviderRuntime({ env, db, ctx: pluginTestCtx() }), key);
  const sentRecords = () => (sqlite.prepare("SELECT count(*) AS count FROM object_records WHERE type_id = ?").get(`oty_${NOTIFY_FIXTURE_ID}.sent`) as { count: number }).count;

  it("keeps the SMS port on every outcome, never sending twice what may have gone", async () => {
    const sms = (await apps().resolve("sms", TEXTS)).provider!;
    const port = PROVIDER_PORTS.sms.send.output;
    const send = (message: string, clientReference?: string) =>
      sms.send({ to: "+8801712345678", message, ...(clientReference ? { clientReference } : {}) }, {});

    const sent = await send("Your order shipped", "outbox1smsrecipient");
    expect(port.parse(sent)).toEqual({ success: true, providerRef: "T-outbox1smsre", rawStatus: "Queued for [phone]" });
    // A retry with the same reference is applied once (the app's own objects).
    expect(await send("Your order shipped", "outbox1smsrecipient")).toEqual(sent);
    expect(sentRecords()).toBe(1);

    expect(port.parse(await send("[declined]", "ref-declined"))).toEqual({ success: false, rawStatus: "The number was refused.", retryable: false });
    expect(port.parse(await send("[busy]"))).toMatchObject({ success: false, retryable: true });
    // Uncertain: retried only when the app can dedupe the retry.
    expect(port.parse(await send("[timeout]", "ref-timeout"))).toMatchObject({ success: false, retryable: true });
    const unkeyed = port.parse(await send("[timeout]"));
    expect(unkeyed).toMatchObject({ success: false, retryable: false });
    expect(unkeyed.rawStatus).not.toContain(NOTIFY_FIXTURE_SECRET);
    expect(port.parse(await send("[crash]"))).toMatchObject({ success: false, retryable: false });
    // Rejected credentials pause the provider like an unconfigured built-in one.
    expect(port.parse(await send("[rejected-key]", "ref-key"))).toEqual({
      success: false,
      rawStatus: "Acme Texts is not configured: The API key was rejected.",
      retryable: false,
    });

    // A message that cannot fit the port never reaches the app.
    const before = (await listPluginLogs(db, NOTIFY_FIXTURE_ID)).length;
    expect(await sms.send({ to: "1", message: "Hi" }, {})).toMatchObject({ success: false, retryable: false });
    expect((await listPluginLogs(db, NOTIFY_FIXTURE_ID)).length).toBe(before);

    await expect(sms.testConnection!({}, {})).resolves.toEqual({ ok: true, message: "API key saved." });
    expect(JSON.stringify(await listPluginLogs(db, NOTIFY_FIXTURE_ID))).not.toContain(NOTIFY_FIXTURE_SECRET);
  });

  it("selects the app providers the saved settings name, for SMS, email and the fraud check", async () => {
    await saveSmsSettings(db, { activeProvider: TEXTS }, KEY);
    await emailDocument.write(db, { provider: MAIL, sender: "orders@shop.test" }, { encryptionKey: KEY });
    const providers = apps();

    await expect(getSmsProviderReadiness(db, KEY, providers)).resolves.toEqual({ status: "ready", issues: [], activeProvider: TEXTS });
    const sms = await getActiveSmsProvider(db, KEY, providers);
    expect(sms).toMatchObject({ id: TEXTS, label: "Acme Texts" });
    await expect(sms!.send({ to: "+8801712345678", message: "Hello", clientReference: "selected1" }, {})).resolves.toMatchObject({ success: true });

    await expect(getEmailProviderReadiness({ db, env: env as never, encryptionKey: KEY, appProviders: providers }))
      .resolves.toMatchObject({ status: "ready", provider: MAIL });
    const email = await sendEmail(
      { to: "buyer@example.test", subject: "Shipped", html: "<p>Shipped</p>", idempotencyKey: "outbox2:email:hash" },
      { db, env: env as never, encryptionKey: KEY, appProviders: providers },
    );
    expect(email).toEqual({ success: true, providerRef: "M-outbox2:emai", rawStatus: "Queued for [email]", provider: MAIL });

    const row = await saveFraudProvider(db, { name: "Acme Radar", providerType: RADAR, isActive: true }, KEY);
    const lookup = await fraudLookupWithActiveProvider(db, "01712-345678", KEY, providers);
    expect(lookup.status).toBe("checked");
    if (lookup.status !== "checked") return;
    expect(PROVIDER_PORTS.fraud.check.output.parse(lookup.check)).toMatchObject({ riskLevel: "medium", phone: "+8801712345678", totalParcels: 5 });
    await expect(fraudLookupWithActiveProvider(db, "+8801999999999", KEY, providers)).rejects.toThrow("Acme Radar has no history for this number.");
    await expect(testFraudProvider(db, row.id, KEY, providers)).resolves.toEqual({ success: true, message: "Radar reachable." });
  });

  it("fails closed when the app's settings cannot be opened, or the app is not installed", async () => {
    await saveSmsSettings(db, { activeProvider: TEXTS }, KEY);
    const otherKey = apps(OTHER_KEY);

    await expect(getSmsProviderReadiness(db, KEY, otherKey)).resolves.toMatchObject({
      status: "incomplete",
      activeProvider: TEXTS,
      issues: [{ message: "Acme Notify credentials could not be opened. Save them again in the app's settings." }],
    });
    await expect(getActiveSmsProvider(db, KEY, otherKey)).resolves.toBeNull();
    await saveFraudProvider(db, { name: "Acme Radar", providerType: RADAR, isActive: true }, KEY);
    await expect(fraudLookupWithActiveProvider(db, "01712345678", KEY, otherKey))
      .resolves.toMatchObject({ status: "unavailable", reason: expect.stringContaining("could not be opened") });
    // Nothing ran: the app was never invoked without readable credentials.
    expect(await listPluginLogs(db, NOTIFY_FIXTURE_ID)).toEqual([]);

    await saveSmsSettings(db, { activeProvider: "acme.gone:texts" }, KEY);
    await expect(getSmsProviderReadiness(db, KEY, apps())).resolves.toMatchObject({
      status: "incomplete",
      issues: [{ message: "The SMS app provider you chose is not installed. Choose another provider." }],
    });
  });

  it("sends a customer sign-in code through an app SMS provider from the OTP sender's path", async () => {
    await customerAuthDocument.write(db, { email: "optional", whatsapp: "off", channels: ["sms"] });
    await saveSmsSettings(db, { activeProvider: TEXTS }, KEY);

    const requested = await sendOtp(db, {
      method: "phone",
      identifier: "01712345678",
      ip: "203.0.113.9",
      encryptionKey: KEY,
      credentialEncryptionKey: KEY,
      appProviders: detachedAppProviders(env, db, KEY),
    });
    // The delivery reference carries opaque references only.
    expect(JSON.stringify(requested.otpDelivery)).not.toContain("1712345678");

    await deliverAuthOtp(requested.otpDelivery, db, env);

    expect(sentRecords()).toBe(1);
    expect(sqlite.prepare("SELECT status, provider, provider_message_id AS ref FROM auth_otp_delivery_receipts WHERE delivery_key = ?").get(requested.otpDelivery.deliveryKey))
      .toEqual({ status: "accepted", provider: TEXTS, ref: expect.stringMatching(/^T-/) });
    // Delivering the same reference again never sends the code again.
    await deliverAuthOtp(requested.otpDelivery, db, env);
    expect(sentRecords()).toBe(1);
  });
});
