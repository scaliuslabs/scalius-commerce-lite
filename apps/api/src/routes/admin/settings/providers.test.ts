// The app providers of a port as the settings pages list them: readiness from
// the app's own settings and approval, and a connection test that runs the
// app's testConnection through the plugin host (bundled loader here).
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { activatePlugin, installPlugin, requirePluginInstallation, writePluginSettings } from "@scalius/core/modules/plugins";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { errorResponseFromError } from "../../../utils/api-response";
import { PLUGIN_TEST_CREDENTIAL_KEY, pluginTestCtx, pluginTestEnv } from "../../../plugins/testing/fixtures";
import { WALLET_FIXTURE_CODE, WALLET_FIXTURE_ID, WALLET_FIXTURE_MANIFEST, WALLET_FIXTURE_SECRET } from "../../../plugins/testing/provider-fixture";

const sha256 = createHash("sha256").update(WALLET_FIXTURE_CODE).digest("hex");
const fixture = vi.hoisted(() => ({ module: null as unknown }));

// The request's provider runtime, with the fixture compiled in as a bundled plugin.
vi.mock("../../../plugins/providers/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../plugins/providers/runtime")>();
  return {
    ...actual,
    requestProviderRuntime: (c: Parameters<typeof actual.requestProviderRuntime>[0]) => {
      const db = c.get("db");
      const ctx = pluginTestCtx();
      return {
        env: c.env,
        db,
        canRun: () => true,
        host: async () => {
          const [{ PluginHost }, { BundledLoader }] = await Promise.all([import("../../../plugins/host"), import("../../../plugins/loaders/bundled")]);
          const loader = new BundledLoader(
            { env: c.env, ctx, db: () => db, composedEnv: async () => c.env },
            { [WALLET_FIXTURE_ID]: { version: "1.0.0", sha256, load: async () => fixture.module } },
          );
          return new PluginHost({ env: c.env, ctx, db, loaderFor: () => loader });
        },
      };
    },
  };
});

import { appProviderSettingsRoutes } from "./providers";

let workdir: string;
beforeAll(async () => {
  workdir = mkdtempSync(join(tmpdir(), "scalius-provider-settings-"));
  const file = join(workdir, "wallet.mjs");
  writeFileSync(file, WALLET_FIXTURE_CODE);
  fixture.module = await import(pathToFileURL(file).href);
});
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

describe("app provider settings", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let env: Env;

  function createApp(permissions: readonly string[] = Object.values(PERMISSIONS)) {
    const app = new OpenAPIHono<{ Bindings: Env }>();
    app.onError((error, c) => {
      const { body, status } = errorResponseFromError(error);
      return c.json(body, status);
    });
    app.use("*", async (c, next) => {
      c.set("db", db);
      c.set("adminPermissions", new Set(permissions));
      await next();
    });
    app.route("/", appProviderSettingsRoutes);
    return app;
  }

  beforeEach(async () => {
    let binding: D1Database;
    ({ sqlite, db, binding } = createSqliteD1Database());
    env = pluginTestEnv(binding);
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
    await installPlugin(db, { manifest: WALLET_FIXTURE_MANIFEST, source: "upload", bundleSha256: sha256, actorUserId: "owner" });
  });
  afterEach(() => sqlite.close());

  async function list(kind: string) {
    const response = await createApp().request(`/providers?kind=${kind}`, {}, env);
    expect(response.status).toBe(200);
    return ((await response.json()) as { data: { providers: Array<Record<string, unknown>> } }).data.providers;
  }

  async function test() {
    const response = await createApp().request(`/providers/${encodeURIComponent(`${WALLET_FIXTURE_ID}:wallet`)}/test`, { method: "POST" }, env);
    expect(response.status).toBe(200);
    return ((await response.json()) as { data: { ok: boolean; message: string } }).data;
  }

  it("lists an installed app's providers of the port with readiness, and tests only a ready one", async () => {
    // Installed, not configured or activated: listed, not usable, never called.
    expect(await list("payment")).toEqual([expect.objectContaining({
      id: `${WALLET_FIXTURE_ID}:wallet`,
      kind: "payment",
      appName: "Acme Wallet",
      // The fixture lists no icon, of its own or its provider's: the method shows the neutral mark.
      appIcon: null,
      icon: null,
      canTestConnection: true,
      readiness: expect.objectContaining({ configured: false, usable: false, missingFields: ["secret"] }),
    })]);
    expect(await test()).toEqual({ ok: false, message: expect.stringContaining("secret") });

    const configured = await writePluginSettings(db, WALLET_FIXTURE_ID, { secret: WALLET_FIXTURE_SECRET }, {
      expectedRevision: 1,
      credentialEncryptionKey: PLUGIN_TEST_CREDENTIAL_KEY,
    });
    await activatePlugin(db, WALLET_FIXTURE_ID, { actorUserId: "owner", expectedRevision: configured.revision });
    // Usable, but "Ready" waits for a passing test: listing never calls the provider.
    expect((await list("payment"))[0]).toMatchObject({
      readiness: { configured: true, enabled: true, usable: true },
      connection: { status: "untested", testedAt: null, message: null },
    });
    expect(await test()).toEqual({ ok: true, message: "Secret saved." });
    expect((await list("payment"))[0]).toMatchObject({ connection: { status: "passed", testedAt: expect.any(String), message: null } });
    expect(await list("courier")).toEqual([]);

    // New keys are not vouched for by a test of the old ones.
    const installation = await requirePluginInstallation(db, WALLET_FIXTURE_ID);
    await writePluginSettings(db, WALLET_FIXTURE_ID, { secret: `${WALLET_FIXTURE_SECRET}-2` }, {
      expectedRevision: installation.revision,
      credentialEncryptionKey: PLUGIN_TEST_CREDENTIAL_KEY,
    });
    expect((await list("payment"))[0]).toMatchObject({ connection: { status: "untested" } });
  });

  it("answers to the port's built-in permissions, not to any settings permission", async () => {
    const path = `/providers/${encodeURIComponent(`${WALLET_FIXTURE_ID}:wallet`)}/test`;
    // Payment providers: read with View store settings, tested with Edit store settings (Settings → Payments).
    expect((await createApp([PERMISSIONS.SETTINGS_FRAUD_CHECKER_VIEW]).request("/providers?kind=payment", {}, env)).status).toBe(403);
    expect((await createApp([PERMISSIONS.SETTINGS_FRAUD_CHECKER_VIEW]).request("/providers?kind=courier_history", {}, env)).status).toBe(200);
    expect((await createApp([PERMISSIONS.SETTINGS_GENERAL_VIEW]).request("/providers?kind=payment", {}, env)).status).toBe(200);
    expect((await createApp([PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT]).request(path, { method: "POST" }, env)).status).toBe(403);
    expect((await createApp([PERMISSIONS.SETTINGS_GENERAL_VIEW, PERMISSIONS.SETTINGS_GENERAL_EDIT]).request(path, { method: "POST" }, env)).status).toBe(200);
    // Couriers: Settings → Shipping's own permissions.
    expect((await createApp([PERMISSIONS.SETTINGS_GENERAL_VIEW]).request("/providers?kind=courier", {}, env)).status).toBe(403);
    expect((await createApp([PERMISSIONS.SETTINGS_DELIVERY_PROVIDERS_VIEW]).request("/providers?kind=courier", {}, env)).status).toBe(200);
  });

  it("refuses ids that are not an installed app provider", async () => {
    expect((await createApp().request("/providers/stripe/test", { method: "POST" }, env)).status).toBe(400);
    expect((await createApp().request(`/providers/${encodeURIComponent("acme.other:wallet")}/test`, { method: "POST" }, env)).status).toBe(404);
    expect((await createApp().request("/providers?kind=bank", {}, env)).status).toBe(400);
  });
});
