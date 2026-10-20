// A payment or SMS feature put to use by the lifecycle itself, with no dashboard
// route in the path: this is what every lane (the dashboard, an agent
// operation, any later caller) passes when it activates an app or turns a
// feature on, so none of them needs a second step (provider-adoption.ts).
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { requirePluginInstallation, writePluginSettings } from "@scalius/core/modules/plugins";
import { paymentMethodsDocument, smsDocument } from "@scalius/core/modules/settings";
import { pluginGrantKey, pluginGrantRequest } from "@scalius/shared/plugins/manifest";
import { syncBundledPlugin } from "./bundled-sync";
import { activatePluginWithHooks, setPluginFeatureWithHooks } from "./lifecycle";
import { pluginTestCtx, pluginTestEnv, PLUGIN_TEST_CREDENTIAL_KEY } from "./testing/fixtures";

const PACK = "scalius.bangladesh";

describe("putting an app's payment and SMS services to use in the lifecycle", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let env: Env;

  beforeEach(async () => {
    let binding: D1Database;
    ({ sqlite, db, binding } = createSqliteD1Database());
    env = pluginTestEnv(binding);
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
    await syncBundledPlugin(db, PACK);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    sqlite.close();
    vi.restoreAllMocks();
  });

  const context = () => ({ db, env, ctx: pluginTestCtx() });

  async function activate(features: readonly string[]) {
    const current = await requirePluginInstallation(db, PACK);
    return activatePluginWithHooks(context(), PACK, {
      actorUserId: "owner",
      expectedRevision: current.revision,
      expectedGrantKey: pluginGrantKey(pluginGrantRequest(current.declaredManifest, features)),
      ...(features.length > 0 ? { features } : {}),
    });
  }

  async function turnOn(feature: string) {
    const current = await requirePluginInstallation(db, PACK);
    return setPluginFeatureWithHooks(context(), PACK, {
      feature,
      enabled: true,
      expectedRevision: current.revision,
      expectedGrantKey: pluginGrantKey(pluginGrantRequest(current.declaredManifest, [...current.features, feature])),
      actorUserId: "owner",
    });
  }

  it("adds a turned-on payment feature to checkout's methods after cash on delivery", async () => {
    await activate([]);
    expect((await paymentMethodsDocument.read(db)).enabledMethods ?? ["cod"]).toEqual(["cod"]);
    const result = await turnOn("bkash");
    expect(result.changed).toBe(true);
    expect((await paymentMethodsDocument.read(db)).enabledMethods).toEqual(["cod", `${PACK}:bkash`]);
  });

  it("does the same for a payment feature approved with the activation", async () => {
    await activate(["bkash"]);
    expect((await paymentMethodsDocument.read(db)).enabledMethods).toEqual(["cod", `${PACK}:bkash`]);
  });

  it("never adds back a method the merchant hid, and changes nothing when the feature was already on", async () => {
    await activate([]);
    await turnOn("bkash");
    await paymentMethodsDocument.write(db, { enabledMethods: ["cod"], defaultMethod: "cod" });
    const again = await turnOn("bkash");
    expect(again.changed).toBe(false);
    expect((await paymentMethodsDocument.read(db)).enabledMethods).toEqual(["cod"]);
  });

  it("makes a ready SMS feature the SMS service when none is chosen, and never replaces a chosen one", async () => {
    await activate([]);
    // Turned on before its key is saved: not ready, so not chosen.
    await turnOn("smsnetbd");
    expect((await smsDocument.read(db)).activeProvider).toBe("");
    const installed = await requirePluginInstallation(db, PACK);
    await writePluginSettings(db, PACK, { smsnetbd_api_key: "k3J9xQ2mP7vL5nR8wT4z" }, {
      expectedRevision: installed.revision,
      credentialEncryptionKey: PLUGIN_TEST_CREDENTIAL_KEY,
    });
    // The next lifecycle step finds it ready and chooses it.
    await turnOn("bkash");
    expect((await smsDocument.read(db)).activeProvider).toBe(`${PACK}:smsnetbd`);

    await smsDocument.write(db, { activeProvider: "someone.else:sms" });
    await turnOn("bdbulksms");
    expect((await smsDocument.read(db)).activeProvider).toBe("someone.else:sms");
  });
});
