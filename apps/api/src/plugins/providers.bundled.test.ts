// App provider operations through the bundled loader (the Workers Free path):
// the host validates both sides of the port, keeps the app's own state, maps
// every failure to the port's ProviderError and masks the app's secrets. The
// same fixture bytes run in the sandbox loader (plugins.sandbox.test.ts).
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { getObjectRecord } from "@scalius/core/modules/objects";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
  activatePlugin,
  installPlugin,
  listPluginLogs,
  writePluginSettings,
  type PluginInstallation,
} from "@scalius/core/modules/plugins";
import { ProviderError } from "@scalius/shared/plugins/providers";
import { PluginHost } from "./host";
import { BundledLoader } from "./loaders/bundled";
import { PLUGIN_TEST_CREDENTIAL_KEY, pluginTestCtx, pluginTestEnv } from "./testing/fixtures";
import {
  WALLET_FIXTURE_CODE,
  WALLET_FIXTURE_ID,
  WALLET_FIXTURE_MANIFEST,
  WALLET_FIXTURE_SECRET,
  walletSessionInput,
} from "./testing/provider-fixture";

const sha256 = createHash("sha256").update(WALLET_FIXTURE_CODE).digest("hex");
let workdir: string;
let walletModule: unknown;

beforeAll(async () => {
  workdir = mkdtempSync(join(tmpdir(), "scalius-provider-fixture-"));
  const file = join(workdir, "wallet.mjs");
  writeFileSync(file, WALLET_FIXTURE_CODE);
  walletModule = await import(pathToFileURL(file).href);
});
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

describe("app providers through the bundled loader", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let binding: D1Database;
  let installation: PluginInstallation;
  let host: PluginHost;

  beforeEach(async () => {
    ({ sqlite, db, binding } = createSqliteD1Database());
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
    const installed = await installPlugin(db, { manifest: WALLET_FIXTURE_MANIFEST, source: "upload", bundleSha256: sha256, actorUserId: "owner" });
    const configured = await writePluginSettings(db, WALLET_FIXTURE_ID, { secret: WALLET_FIXTURE_SECRET }, {
      expectedRevision: installed.revision,
      credentialEncryptionKey: PLUGIN_TEST_CREDENTIAL_KEY,
    });
    installation = await activatePlugin(db, WALLET_FIXTURE_ID, { actorUserId: "owner", expectedRevision: configured.revision });
    const env = pluginTestEnv(binding);
    const ctx = pluginTestCtx();
    const loader = new BundledLoader(
      { env, ctx, db: () => db, composedEnv: async () => env },
      { [WALLET_FIXTURE_ID]: { version: "1.0.0", sha256, load: async () => walletModule } },
    );
    host = new PluginHost({ env, ctx, db, loaderFor: () => loader });
  });
  afterEach(() => sqlite.close());

  it("creates a session with the app's own objects, idempotently per attempt", async () => {
    const first = await host.invokeProvider(installation, "payment", "wallet", "createSession", walletSessionInput(12_550));
    expect(first).toEqual({
      providerRef: "W-ORD1_full_12550",
      redirectUrl: "https://wallet.acme.test/pay?amount=125.50&currency=BDT",
    });
    expect(await host.invokeProvider(installation, "payment", "wallet", "createSession", walletSessionInput(12_550))).toEqual(first);
    expect(await getObjectRecord(db, WALLET_FIXTURE_ID, "sessions", "attempt-12550")).toMatchObject({ order_id: "ORD1" });
    expect((await listPluginLogs(db, WALLET_FIXTURE_ID)).map((line) => line.source)).toContain("provider:wallet.createSession");
  });

  it("authenticates webhooks with the decrypted secret", async () => {
    const body = JSON.stringify({ id: "evt1", orderId: "ORD1", ref: "W-1", amountMinor: 12_550 });
    const request = (signature: string) => ({ method: "POST", rawBody: body, headers: { "x-wallet-signature": signature }, query: {} });
    expect(await host.invokeProvider(installation, "payment", "wallet", "verifyWebhook", request("forged"))).toEqual({ status: "invalid", reason: "Bad signature" });
    expect(await host.invokeProvider(installation, "payment", "wallet", "verifyWebhook", request(WALLET_FIXTURE_SECRET))).toEqual({
      status: "event",
      event: { kind: "confirmed", eventType: "wallet.paid", eventId: "evt1", orderId: "ORD1", providerRef: "W-1", amountMinor: 12_550, currency: "BDT" },
    });
    expect(await host.invokeProvider(installation, "payment", "wallet", "testConnection", {})).toEqual({ ok: true, message: "Secret saved." });
  });

  it("maps every failure to the port's error", async () => {
    const attempt = (amountMinor: number) => host.invokeProvider(installation, "payment", "wallet", "createSession", walletSessionInput(amountMinor))
      .then(() => null, (error: unknown) => error);
    expect(await attempt(1300)).toMatchObject({ category: "declined", uncertain: false, code: "wallet_declined", message: "The wallet declined the payment." });
    const timeout = await attempt(1400) as ProviderError;
    expect(timeout).toBeInstanceOf(ProviderError);
    expect(timeout).toMatchObject({ category: "retryable", uncertain: true, code: "wallet_timeout" });
    // The app's own message cannot leak its secret.
    expect(timeout.message).not.toContain(WALLET_FIXTURE_SECRET);
    expect(await attempt(1500)).toMatchObject({ category: "retryable", uncertain: true, code: "provider_invalid_response" });
    expect(await attempt(1600)).toMatchObject({ category: "retryable", uncertain: true, code: "provider_error" });
    const logged = JSON.stringify(await listPluginLogs(db, WALLET_FIXTURE_ID));
    expect(logged).toContain("Invalid createSession answer at redirectUrl.");
    expect(logged).not.toContain(WALLET_FIXTURE_SECRET);
  });

  it("refuses what the app did not declare or was not approved for, without running it", async () => {
    await expect(host.invokeProvider(installation, "payment", "wallet", "listRefunds", { sourceRef: "W-1" }))
      .rejects.toMatchObject({ category: "misconfigured", code: "provider_unsupported" });
    await expect(host.invokeProvider(installation, "courier", "wallet", "trackShipment", { externalId: "x" }))
      .rejects.toMatchObject({ category: "misconfigured" });
    const unapproved = { ...installation, grant: { ...installation.grant!, providers: [] } };
    await expect(host.invokeProvider(unapproved, "payment", "wallet", "createSession", walletSessionInput(100)))
      .rejects.toMatchObject({ category: "misconfigured" });
    await expect(host.invokeProvider(installation, "payment", "wallet", "createSession", { ...walletSessionInput(100), amountMinor: 1.5 } as never))
      .rejects.toBeInstanceOf(TypeError);
    expect(await getObjectRecord(db, WALLET_FIXTURE_ID, "sessions", "attempt-100")).toBeNull();
  });

  it("fails closed when the app's credentials cannot be opened", async () => {
    const otherKeyHost = new PluginHost({
      env: pluginTestEnv(binding, { CREDENTIAL_ENCRYPTION_KEY: "another-credential-key-0123456789abcdef" }),
      ctx: pluginTestCtx(),
      db,
      loaderFor: () => { throw new Error("must not load"); },
    });
    await expect(otherKeyHost.invokeProvider(installation, "payment", "wallet", "createSession", walletSessionInput(100)))
      .rejects.toMatchObject({ category: "misconfigured", code: "provider_settings_unreadable" });
  });
});
