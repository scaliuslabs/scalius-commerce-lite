// Registry and upload releases (docs/platform/PLUGINS.md, "Registry"):
// verification against the trusted keys, download from a registry, upload
// trust choices, and updates that load the new code and run its data updates,
// rolling back when either fails. The test registry signs with its own
// keypair, made at run time.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
  activatePlugin,
  getPluginKv,
  installPlugin,
  listPluginMigrations,
  pluginRegistrySettingsDocument,
  requirePluginInstallation,
  type PluginInstallation,
} from "@scalius/core/modules/plugins";
import { PLUGIN_API_VERSION } from "@scalius/shared/plugins";
import { getObjectRecord } from "@scalius/core/modules/objects";
import { sha256Hex } from "@scalius/shared/plugins/registry";
import { definePlugin } from "@scalius/plugin-sdk";
import { BundledLoader } from "./loaders/bundled";
import { updatePluginToRelease } from "./lifecycle";
import { readPluginPackageZip } from "./package-zip";
import { downloadRegistryRelease, verifyRelease, verifyUploadedPackage } from "./releases";
import { pluginTestCtx, pluginTestEnv } from "./testing/fixtures";
import { createTestDeveloper, createTestRegistry, sealedBundle, testPackage, type TestRelease } from "./testing/registry-fixture";

const ICON = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>');

function manifest(version: string, extra: Record<string, unknown> = {}) {
  return {
    id: "acme.points",
    name: "Acme Points",
    version,
    apiVersion: PLUGIN_API_VERSION,
    description: "Points for orders.",
    author: { name: "Acme" },
    icon: "assets/icon.svg",
    ...extra,
  };
}

async function release(version: string, extra: Record<string, unknown> = {}): Promise<TestRelease> {
  const assets = { "assets/icon.svg": ICON };
  return { manifest: manifest(version, extra), code: await sealedBundle(`export default { v: ${JSON.stringify(version)} };\n`, assets), assets };
}

describe("app releases", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let env: Env;
  let registry: Awaited<ReturnType<typeof createTestRegistry>>;

  beforeEach(async () => {
    let binding: D1Database;
    ({ sqlite, db, binding } = createSqliteD1Database());
    const objects = new Map<string, Uint8Array>();
    env = pluginTestEnv(binding, {
      BUCKET: {
        put: vi.fn(async (key: string, value: Uint8Array | string) => {
          objects.set(key, typeof value === "string" ? new TextEncoder().encode(value) : value);
        }),
        get: vi.fn(async (key: string) => (objects.has(key) ? { arrayBuffer: async () => objects.get(key)!.buffer } : null)),
      },
    });
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
    registry = await createTestRegistry();
    vi.stubGlobal("fetch", vi.fn(registry.fetch));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    sqlite.close();
  });

  async function trustRegistry() {
    await pluginRegistrySettingsDocument.write(db, {
      registries: [{ id: "acme", name: "Acme apps", indexUrl: registry.indexUrl }],
      trustedKeys: [registry.developer.key],
    });
  }

  it("verifies a signed release, its hash, its compatibility and its sealed images", async () => {
    const good = await release("1.0.0");
    const entry = await registry.publish(good);
    const code = new TextEncoder().encode(good.code);
    const base = {
      manifest: good.manifest, code, expectedSha256: entry.sha256, signature: entry.signature,
      trustedKeys: [registry.developer.key], asset: async (path: string) => good.assets![path] ?? null, source: "registry" as const,
    };
    const verified = await verifyRelease(base);
    expect(verified).toMatchObject({ sha256: entry.sha256, signer: registry.developer.key });
    expect([...verified.assets.keys()]).toEqual(["assets/icon.svg"]);

    await expect(verifyRelease({ ...base, code: new TextEncoder().encode(`${good.code}//x`) })).rejects.toMatchObject({ pluginCode: "package.hash_mismatch" });
    await expect(verifyRelease({ ...base, trustedKeys: [] })).rejects.toMatchObject({ pluginCode: "signature.untrusted" });
    await expect(verifyRelease({ ...base, manifest: { ...good.manifest, scopes: ["read_orders"] } })).rejects.toMatchObject({ pluginCode: "signature.invalid" });
    await expect(verifyRelease({ ...base, signature: null })).rejects.toMatchObject({ pluginCode: "signature.missing" });
    await expect(verifyRelease({ ...base, asset: async () => new TextEncoder().encode("<svg/>") })).rejects.toMatchObject({ pluginCode: "package.invalid" });
    await expect(verifyRelease({ ...base, manifest: { ...good.manifest, apiVersion: "2099-01" } }))
      .rejects.toMatchObject({ pluginCode: "installation.incompatible" });
  });

  it("downloads only from a configured registry and only what a trusted key signed", async () => {
    await expect(downloadRegistryRelease(db, { registryId: "acme", id: "acme.points" })).rejects.toMatchObject({ pluginCode: "registry.not_configured" });
    await registry.publish(await release("1.0.0"));
    await registry.publish(await release("1.1.0"));
    await trustRegistry();
    const newest = await downloadRegistryRelease(db, { registryId: "acme", id: "acme.points" });
    expect(newest.manifest.version).toBe("1.1.0");
    expect((await downloadRegistryRelease(db, { registryId: "acme", id: "acme.points", version: "1.0.0" })).manifest.version).toBe("1.0.0");
    await expect(downloadRegistryRelease(db, { registryId: "acme", id: "acme.missing" })).rejects.toMatchObject({ pluginCode: "registry.not_found" });

    // A release whose served code differs from what was signed.
    await registry.publish(await release("1.2.0"), { tamper: true });
    await expect(downloadRegistryRelease(db, { registryId: "acme", id: "acme.points" })).rejects.toMatchObject({ pluginCode: "package.hash_mismatch" });
    // A release signed by someone the store does not trust.
    const stranger = await createTestDeveloper("Stranger");
    await registry.publish(await release("1.3.0"), { signer: stranger });
    await expect(downloadRegistryRelease(db, { registryId: "acme", id: "acme.points" })).rejects.toMatchObject({ pluginCode: "signature.untrusted" });
  });

  it("asks before trusting a new developer or an unsigned package, and refuses a forged one", async () => {
    const good = await release("1.0.0");
    const developer = await createTestDeveloper("Acme Labs");
    const signed = await readPluginPackageZip(await testPackage(good, developer));
    await expect(verifyUploadedPackage(db, signed, { allowUnsigned: false, trustDeveloper: false }))
      .rejects.toMatchObject({ pluginCode: "signature.untrusted", details: expect.objectContaining({ keyId: developer.key.id, developer: "Acme Labs" }) });
    const trusted = await verifyUploadedPackage(db, signed, { allowUnsigned: false, trustDeveloper: true });
    expect(trusted.newKey).toEqual(developer.key);
    expect(trusted.release.signer).toEqual(developer.key);

    const unsigned = await readPluginPackageZip(await testPackage(good));
    await expect(verifyUploadedPackage(db, unsigned, { allowUnsigned: false, trustDeveloper: false })).rejects.toMatchObject({ pluginCode: "signature.missing" });
    expect((await verifyUploadedPackage(db, unsigned, { allowUnsigned: true, trustDeveloper: false })).release.signer).toBeNull();

    // A signature for other code never passes, even with trust.
    const forged = await readPluginPackageZip(await testPackage(good, developer));
    forged.set("plugin.js", new TextEncoder().encode(`${good.code}// changed`));
    await expect(verifyUploadedPackage(db, forged, { allowUnsigned: true, trustDeveloper: true })).rejects.toMatchObject({ pluginCode: "signature.invalid" });
  });

  it("refuses packages that are not ZIPs or that escape their folder", async () => {
    await expect(readPluginPackageZip(new TextEncoder().encode("not a zip"))).rejects.toMatchObject({ pluginCode: "package.invalid" });
    const { storedZip } = await import("./testing/registry-fixture");
    await expect(readPluginPackageZip(storedZip({ "../evil.js": "x" }))).rejects.toMatchObject({ pluginCode: "package.invalid" });
    const nested = await readPluginPackageZip(storedZip({ "acme-points/manifest.json": "{}", "acme-points/plugin.js": "x" }));
    expect([...nested.keys()].sort()).toEqual(["manifest.json", "plugin.js"]);
  });

  describe("updates", () => {
    const modules: Record<string, unknown> = {};

    function loaderFor(installation: PluginInstallation) {
      return new BundledLoader({ env, ctx: pluginTestCtx(), db: () => db, composedEnv: async () => env }, {
        [installation.pluginId]: { version: installation.version, sha256: installation.bundleSha256, load: async () => modules[installation.version] },
      });
    }

    async function installV1(): Promise<PluginInstallation> {
      modules["1.0.0"] = definePlugin({ manifest: manifest("1.0.0") as never });
      const installed = await installPlugin(db, { manifest: manifest("1.0.0"), source: "upload", bundleSha256: await sha256Hex("v1"), actorUserId: "owner" });
      return activatePlugin(db, "acme.points", { actorUserId: "owner", expectedRevision: installed.revision });
    }

    async function update(current: PluginInstallation, version: string, extra: Record<string, unknown>) {
      const parsed = (await import("@scalius/shared/plugins")).parsePluginManifest(manifest(version, extra));
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
      return updatePluginToRelease(
        { db, env, ctx: pluginTestCtx(), loaderFor },
        current,
        { manifest: parsed.manifest, sha256: await sha256Hex(version), signerKeyId: null, source: "upload" },
        { expectedRevision: current.revision },
      );
    }

    it("loads the new code, runs its data updates once and records them", async () => {
      const v1 = await installV1();
      const migrations = [{ version: 1, description: "Seed the counter" }];
      const objects = { counters: { name: "Counters", fields: [{ key: "value", name: "Value", type: "integer" }] } };
      modules["2.0.0"] = definePlugin({
        manifest: manifest("2.0.0", { migrations, objects }) as never,
        migrations: { 1: async (ctx) => {
          await ctx.kv.set("counter", 0);
          await ctx.objects.counters!.put("initial", { value: 0 });
        } },
      });
      const result = await update(v1, "2.0.0", { migrations, objects });
      expect(result).toMatchObject({ rolledBack: false, error: null, installation: { version: "2.0.0", status: "active", migratedVersion: 1 } });
      expect(await getPluginKv(db, "acme.points", "counter")).toBe(0);
      expect(await getObjectRecord(db, "acme.points", "counters", "initial")).toEqual({ value: 0 });
      expect((await listPluginMigrations(db, "acme.points")).map((entry) => [entry.version, entry.pluginVersion])).toEqual([[1, "2.0.0"]]);
    });

    it("rolls back to the previous version when a data update fails", async () => {
      const v1 = await installV1();
      const migrations = [{ version: 1, description: "Seed" }, { version: 2, description: "Break" }];
      modules["2.0.0"] = definePlugin({
        manifest: manifest("2.0.0", { migrations }) as never,
        migrations: {
          1: async (ctx) => { await ctx.kv.set("seeded", true); },
          2: async () => { throw new Error("backfill failed"); },
        },
      });
      const result = await update(v1, "2.0.0", { migrations });
      expect(result.rolledBack).toBe(true);
      expect(result.error).toMatch(/Data update 2 failed/);
      const restored = await requirePluginInstallation(db, "acme.points");
      expect(restored).toMatchObject({ version: "1.0.0", bundleSha256: v1.bundleSha256, status: "active" });
      expect(restored.failureReason).toMatch(/Update to 2.0.0 was rolled back/);
      // The data update that ran stays recorded (a rollback never reverses data).
      expect((await listPluginMigrations(db, "acme.points")).map((entry) => entry.version)).toEqual([1]);
    });

    it("rolls back when the new code does not match its manifest", async () => {
      const v1 = await installV1();
      const cron = [{ name: "tick", schedule: "0 3 * * *" }];
      // The manifest declares a cron job the code does not implement.
      modules["2.0.0"] = definePlugin({ manifest: manifest("2.0.0", { cron }) as never });
      const result = await update(v1, "2.0.0", { cron });
      expect(result.rolledBack).toBe(true);
      expect(result.error).toMatch(/could not start/);
      expect(await requirePluginInstallation(db, "acme.points")).toMatchObject({ version: "1.0.0", status: "active" });
    });

    it("rolls back an update that waited for approval when its data update fails on approval", async () => {
      const v1 = await installV1();
      const migrations = [{ version: 1, description: "Break" }];
      modules["2.0.0"] = definePlugin({
        manifest: manifest("2.0.0", { migrations, scopes: ["read_orders"] }) as never,
        migrations: { 1: async () => { throw new Error("no"); } },
      });
      const waiting = await update(v1, "2.0.0", { migrations, scopes: ["read_orders"] });
      expect(waiting.installation).toMatchObject({ version: "2.0.0", status: "installed" });
      const { activatePluginWithHooks } = await import("./lifecycle");
      const { pluginGrantKey, pluginGrantRequest } = await import("@scalius/shared/plugins");
      const approved = await activatePluginWithHooks({ db, env, ctx: pluginTestCtx(), loaderFor }, "acme.points", {
        actorUserId: "owner",
        expectedRevision: waiting.installation.revision,
        expectedGrantKey: pluginGrantKey(pluginGrantRequest(waiting.installation.manifest)),
      });
      expect(approved.hookError).toMatch(/The update was undone. Data update 1 failed/);
      expect(approved.installation).toMatchObject({ version: "1.0.0", status: "active", grant: v1.grant });
    });

    it("waits for approval when the update asks for more, without running its code", async () => {
      const v1 = await installV1();
      const load = vi.fn();
      modules["2.0.0"] = new Proxy({}, { get: () => load() });
      const result = await update(v1, "2.0.0", { scopes: ["read_orders"] });
      expect(result).toMatchObject({ rolledBack: false, installation: { version: "2.0.0", status: "installed" } });
      expect(load).not.toHaveBeenCalled();
    });
  });
});
