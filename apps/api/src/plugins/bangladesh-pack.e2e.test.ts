// scalius.bangladesh end to end through the platform (bundled loader,
// migrated schema, the Worker's own provider runtime): a store that chose
// BDBulkSMS and FraudBD from the pack. Until the pack is active the choices
// fail closed and say why; activation loads the 11,550 places through the
// place import, so a sign-in code goes out through the pack from the OTP
// sender's path and the order page's lookup reaches FraudBD. Activating
// again loads nothing, and removing the pack keeps every place.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { getPluginKv, installPlugin, requirePluginInstallation, writePluginSettings } from "@scalius/core/modules/plugins";
import { getActiveSmsProvider, getSmsProviderReadiness } from "@scalius/core/integrations/sms";
import { fraudLookupWithActiveProvider, getFraudProviders } from "@scalius/core/modules/fraud-checker";
import { sendOtp } from "@scalius/core/modules/customers";
import { customerAuthDocument } from "@scalius/core/modules/settings";
import { encryptCredentials } from "@scalius/core/utils/credential-encryption";
import { BUNDLED_PLUGINS } from "./bundled.gen";
import { activatePluginWithHooks, deactivatePluginWithHooks, uninstallPluginWithHooks } from "./lifecycle";
import { createAppProviders, detachedAppProviders } from "./providers/app-providers";
import { createAppProviderRuntime } from "./providers/runtime";
import { pluginTestCtx, pluginTestEnv } from "./testing/fixtures";
import { deliverAuthOtp } from "../background/otp";
import { manifest as packManifest } from "../../../../plugins/bangladesh/src/index";
import placesDataset from "../../../../plugins/bangladesh/places/manifest.json";

const PACK = "scalius.bangladesh";
const KEY = Buffer.alloc(32, 7).toString("base64");
const TOKEN = "bdbulksms-live-token-4821";
const FRAUD_KEY = "fraudbd-api-key-9931";

describe("the Bangladesh pack's providers", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let env: Env;
  const requests: Array<{ url: string; init: RequestInit }> = [];

  beforeEach(async () => {
    let binding: D1Database;
    ({ sqlite, db, binding } = createSqliteD1Database());
    env = pluginTestEnv(binding, { CREDENTIAL_ENCRYPTION_KEY: KEY });
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
    // The pack's own settings hold the keys; the store chose its BDBulkSMS gateway and FraudBD checker.
    const installed = await installPlugin(db, { manifest: packManifest, source: "bundled", bundleSha256: BUNDLED_PLUGINS[PACK]!.sha256, actorUserId: "owner" });
    await writePluginSettings(db, PACK, {
      bdbulksms_token: TOKEN,
      fraudbd_api_url: "https://fraudbd.com/api/check-courier-info", fraudbd_api_key: FRAUD_KEY, fraudbd_username: "shop-user", fraudbd_password: "fraudbd-password-1",
    }, { expectedRevision: installed.revision, credentialEncryptionKey: KEY });
    sqlite.prepare("INSERT INTO settings (id, key, value, type, category) VALUES ('sms', 'document', ?, 'json', 'sms')")
      .run(JSON.stringify({ activeProvider: `${PACK}:bdbulksms` }));
    sqlite.prepare("INSERT INTO settings (id, key, value, type, category) VALUES ('fraud_row', 'row_fraudbd', ?, 'json', 'fraud-checker')")
      .run(await encryptCredentials(JSON.stringify({ name: "FraudBD", isActive: true, providerType: `${PACK}:fraudbd` }), KEY));
    requests.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      requests.push({ url, init: init ?? {} });
      if (url.startsWith("https://api.bdbulksms.net/")) {
        return new Response(JSON.stringify([{ to: "+8801712345678", status: "SENT", statusmsg: "Sent" }]), { status: 200 });
      }
      if (url.startsWith("https://fraudbd.com/")) {
        return new Response(JSON.stringify({ data: { totalSummary: { total: 4, success: 4, cancel: 0 } } }), { status: 200 });
      }
      return new Response("unexpected", { status: 599 });
    }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    sqlite.close();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const apps = () => createAppProviders(createAppProviderRuntime({ env, db, ctx: pluginTestCtx() }), KEY);
  const context = () => ({ db, env, ctx: pluginTestCtx() });
  const activate = async () => {
    const current = await requirePluginInstallation(db, PACK);
    const { pluginGrantKey, pluginGrantRequest } = await import("@scalius/shared/plugins/manifest");
    return activatePluginWithHooks(context(), PACK, {
      actorUserId: "owner",
      expectedRevision: current.revision,
      expectedGrantKey: pluginGrantKey(pluginGrantRequest(current.manifest)),
    });
  };
  const placeCount = () => (sqlite.prepare("SELECT count(*) AS count FROM places WHERE country_code = 'BD'").get() as { count: number }).count;

  it("fails closed and says why until the pack is active, then sends, checks and keeps places through it", { timeout: 60_000 }, async () => {
    // Before activation: the choices name the pack's providers and say what to do.
    await expect(getSmsProviderReadiness(db, KEY, apps())).resolves.toMatchObject({
      status: "incomplete",
      activeProvider: `${PACK}:bdbulksms`,
      issues: [{ message: "Activate Bangladesh pack in Apps to use it." }],
    });
    await expect(getActiveSmsProvider(db, KEY, apps())).resolves.toBeNull();
    await expect(fraudLookupWithActiveProvider(db, "+8801712345678", KEY, apps())).resolves.toMatchObject({
      status: "unavailable", reason: "Activate Bangladesh pack in Apps to use it.",
    });
    expect(requests).toEqual([]);

    const { hookError } = await activate();
    expect(hookError).toBeNull();

    // The places: every one of the dataset, through the import port.
    expect(placeCount()).toBe(11_550);
    expect(await getPluginKv(db, PACK, "places")).toMatchObject({ version: placesDataset.sha256, done: true });

    // The pack's keys are sealed in its settings.
    const installation = await requirePluginInstallation(db, PACK);
    expect(String(installation.storedSettings.bdbulksms_token)).toMatch(/^ps1:/);
    const stored = JSON.stringify(sqlite.prepare("SELECT settings_json FROM plugin_installations WHERE plugin_id = ?").get(PACK));
    for (const secret of [TOKEN, FRAUD_KEY, "fraudbd-password-1"]) expect(stored).not.toContain(secret);
    await expect(getFraudProviders(db, KEY)).resolves.toEqual([{ id: "row_fraudbd", name: "FraudBD", isActive: true, providerType: `${PACK}:fraudbd` }]);

    // A sign-in code from the delivery path.
    await customerAuthDocument.write(db, { email: "optional", whatsapp: "off", channels: ["sms"] });
    const requested = await sendOtp(db, {
      method: "phone", identifier: "01712345678", ip: "203.0.113.9", encryptionKey: KEY, credentialEncryptionKey: KEY,
      appProviders: detachedAppProviders(env, db, KEY),
    });
    // The delivery reference carries opaque references only: no phone, no code.
    expect(JSON.stringify(requested.otpDelivery)).not.toContain("1712345678");
    await deliverAuthOtp(requested.otpDelivery, db, env);
    const sms = requests.filter((request) => request.url.startsWith("https://api.bdbulksms.net/"));
    expect(sms).toHaveLength(1);
    expect(sms[0]!.url).toBe("https://api.bdbulksms.net/api.php?json");
    const body = JSON.parse(String(sms[0]!.init.body)) as { token: string; smsdata: Array<{ to: string; message: string }> };
    expect(body.token).toBe(TOKEN);
    expect(body.smsdata[0]!.to).toBe("+8801712345678");
    expect(sqlite.prepare("SELECT status, provider FROM auth_otp_delivery_receipts WHERE delivery_key = ?").get(requested.otpDelivery.deliveryKey))
      .toEqual({ status: "accepted", provider: `${PACK}:bdbulksms` });
    // Nothing the pack logged holds the code, the phone or a key.
    const logs = JSON.stringify(sqlite.prepare("SELECT message, fields_json FROM plugin_log_entries WHERE plugin_id = ?").all(PACK));
    expect(logs).not.toMatch(/1712345678|bdbulksms-live-token|fraudbd-api-key/);

    // The order page's lookup: FraudBD through the pack, with the moved keys.
    await expect(fraudLookupWithActiveProvider(db, "+8801712345678", KEY, apps())).resolves.toMatchObject({ status: "checked", check: { totalParcels: 4, riskLevel: "low" } });
    const fraud = requests.find((request) => request.url.startsWith("https://fraudbd.com/"))!;
    expect(fraud.init.headers).toMatchObject({ api_key: FRAUD_KEY, user_name: "shop-user", password: "fraudbd-password-1" });

    // Activating again loads nothing.
    const before = await requirePluginInstallation(db, PACK);
    await deactivatePluginWithHooks(context(), PACK, { expectedRevision: before.revision });
    const imports = requests.length;
    expect((await activate()).hookError).toBeNull();
    expect(requests.length).toBe(imports);

    // Removing the pack, data and all, keeps every place.
    const active = await requirePluginInstallation(db, PACK);
    await uninstallPluginWithHooks(context(), PACK, { expectedRevision: active.revision, keepData: false });
    expect(placeCount()).toBe(11_550);
  });
});
