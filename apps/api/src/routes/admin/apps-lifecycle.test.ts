// The registry, upload and emergency-stop routes on the migrated schema: the
// browse lists signed apps with trust and compatibility, Workers Free shows
// the command instead of installing, a registry install stores and installs
// (nothing runs until approval), uploads ask a Super Admin before trusting a
// developer or an unsigned package, the trusted keys are a Super Admin's, and
// the emergency stop needs no revision and runs no app code.
import { OpenAPIHono } from "@hono/zod-openapi";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../plugins/bundled.gen", async (importOriginal) => (await import("../../plugins/testing/hello-bundled")).withHelloBundled(await importOriginal()));
const sandbox = vi.hoisted(() => ({ available: false }));
vi.mock("../../plugins/loaders/sandbox-availability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/loaders/sandbox-availability")>()),
  isPluginSandboxAvailable: () => sandbox.available,
}));
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { activatePlugin, installPlugin, requirePluginInstallation } from "@scalius/core/modules/plugins";
import { PLUGIN_API_VERSION } from "@scalius/shared/plugins";
import { errorResponseFromError } from "../../utils/api-response";
import { pluginTestCtx, pluginTestEnv } from "../../plugins/testing/fixtures";
import { createTestDeveloper, createTestRegistry, sealedBundle, testPackage } from "../../plugins/testing/registry-fixture";
import { adminAppRoutes } from "./apps";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON from the routes, asserted field by field
type Json = Record<string, any>;

const ICON = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>');

function manifest(id: string, version: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id === "acme.points" ? "Acme Points" : "Beta Reviews",
    version,
    apiVersion: PLUGIN_API_VERSION,
    description: "An app.",
    author: { name: "Acme" },
    icon: "assets/icon.svg",
    tagline: "Points for orders",
    ...extra,
  };
}

async function release(id: string, version: string, extra: Record<string, unknown> = {}) {
  const assets = { "assets/icon.svg": ICON };
  return { manifest: manifest(id, version, extra), code: await sealedBundle(`export default {};\n`, assets), assets };
}

describe("admin app lifecycle routes", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let env: Env;
  let actor: { id: string; isSuperAdmin: boolean };
  let app: OpenAPIHono<{ Bindings: Env }>;
  let registry: Awaited<ReturnType<typeof createTestRegistry>>;
  const objects = new Map<string, Uint8Array>();

  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
    const init: RequestInit = { method };
    if (body instanceof Uint8Array) init.headers = { "Content-Type": "application/zip", "Content-Length": String(body.byteLength) };
    else if (body !== undefined) init.headers = { "Content-Type": "application/json" };
    if (body instanceof Uint8Array) init.body = body as Uint8Array<ArrayBuffer>;
    else if (body !== undefined) init.body = JSON.stringify(body);
    const response = await app.request(`/api/v1/admin${path}`, init, env, pluginTestCtx());
    return { status: response.status, json: await response.json() as Json };
  }

  beforeEach(async () => {
    sandbox.available = false;
    objects.clear();
    let binding: D1Database;
    ({ sqlite, db, binding } = createSqliteD1Database());
    env = pluginTestEnv(binding, {
      BUCKET: {
        put: vi.fn(async (key: string, value: Uint8Array) => {
          objects.set(key, value);
        }),
        get: vi.fn(async () => null),
      },
    });
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('manager', 'Manager', 'manager@shop.test', 1, 'staff', 0)").run();
    actor = { id: "owner", isSuperAdmin: true };
    registry = await createTestRegistry();
    vi.stubGlobal("fetch", vi.fn(registry.fetch));
    app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
    app.onError((error, c) => {
      const { body, status } = errorResponseFromError(error);
      return c.json(body, status);
    });
    app.use("*", async (c, next) => {
      c.set("db", db);
      c.set("user", { id: actor.id, name: actor.id, email: "", isSuperAdmin: actor.isSuperAdmin } as never);
      await next();
    });
    app.route("/apps", adminAppRoutes);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    sqlite.close();
  });

  async function configureRegistry() {
    const settings = (await call("GET", "/apps/registry/settings")).json.data;
    expect(settings).toMatchObject({ officialConfigured: false, registries: [], trustedKeys: [] });
    const saved = await call("PUT", "/apps/registry/settings", {
      expectedRevision: settings.revision,
      registries: [{ id: "acme", name: "Acme apps", indexUrl: registry.indexUrl }],
      trustedKeys: [{ name: "Acme", publicKey: registry.developer.key.publicKey }],
    });
    expect(saved.status).toBe(200);
    expect(saved.json.data.trustedKeys).toEqual([{ ...registry.developer.key, name: "Acme", official: false }]);
  }

  it("lets only a Super Admin change which developers the store trusts", async () => {
    actor = { id: "manager", isSuperAdmin: false };
    const refused = await call("PUT", "/apps/registry/settings", { expectedRevision: 0, registries: [], trustedKeys: [] });
    expect(refused.status).toBe(403);
    actor = { id: "owner", isSuperAdmin: true };
    const bad = await call("PUT", "/apps/registry/settings", { expectedRevision: 0, registries: [], trustedKeys: [{ name: "X", publicKey: "A".repeat(40) }] });
    expect(bad.status).toBe(400);
    await configureRegistry();
  });

  it("browses signed apps with trust, compatibility and the Free install command", async () => {
    const empty = (await call("GET", "/apps/registry")).json.data;
    expect(empty).toEqual({ officialConfigured: false, installMode: "command", registries: [], apps: [] });
    await registry.publish(await release("acme.points", "1.0.0"));
    await registry.publish(await release("acme.points", "1.1.0"));
    const stranger = await createTestDeveloper("Stranger");
    await registry.publish(await release("beta.reviews", "1.0.0", { minPlatformVersion: "99.0.0" }), { signer: stranger });
    await configureRegistry();
    const listed = (await call("GET", "/apps/registry")).json.data;
    expect(listed.registries).toEqual([{ id: "acme", name: "Acme apps", official: false, status: "ok", error: null }]);
    expect(listed.apps.map((entry: Json) => [entry.id, entry.version, entry.signer.trusted, entry.compatible])).toEqual([
      ["acme.points", "1.1.0", true, true],
      ["beta.reviews", "1.0.0", false, false],
    ]);
    expect(listed.apps[0]).toMatchObject({ installCommand: `pnpm plugin add acme.points --registry ${registry.indexUrl}`, installed: null, updateAvailable: false });
    expect(listed.apps[1].incompatibleReason).toMatch(/Needs Scalius 99.0.0/);

    // Free: no one-click install.
    const free = await call("POST", "/apps/registry/install", { registryId: "acme", id: "acme.points" });
    expect(free.status).toBe(409);
    expect(free.json.error.details.code).toBe("installation.sandbox_required");
  });

  it("installs from a registry on Paid: stored, installed, waiting for approval, and listed as an update later", async () => {
    sandbox.available = true;
    await registry.publish(await release("acme.points", "1.0.0"));
    await configureRegistry();
    const installed = await call("POST", "/apps/registry/install", { registryId: "acme", id: "acme.points" });
    expect(installed.status).toBe(200);
    expect(installed.json.data.app).toMatchObject({
      id: "acme.points", source: "registry", status: "installed", signed: true, thirdParty: true,
      signer: { keyId: registry.developer.key.id, name: "Acme", official: false },
      migrations: { declared: [], applied: 0 },
    });
    const sha = installed.json.data.app.icon.split("v=")[1];
    expect([...objects.keys()].sort()).toEqual([
      expect.stringMatching(new RegExp(`^private/plugins/acme.points/1.0.0/${sha}[0-9a-f]+\\.js$`)),
      expect.stringMatching(new RegExp(`^private/plugins/acme.points/1.0.0/${sha}[0-9a-f]+/assets/assets/icon.svg$`)),
    ]);
    expect((await call("POST", "/apps/registry/install", { registryId: "acme", id: "acme.points" })).status).toBe(409);

    await registry.publish(await release("acme.points", "1.1.0"));
    const listed = (await call("GET", "/apps/registry")).json.data;
    expect(listed.installMode).toBe("dashboard");
    expect(listed.apps[0]).toMatchObject({ installed: { version: "1.0.0", source: "registry" }, updateAvailable: true });
  });

  it("asks a Super Admin before an unsigned package or a new developer, and refuses others", async () => {
    sandbox.available = true;
    const unsigned = await testPackage(await release("acme.points", "1.0.0"));
    const missing = await call("POST", "/apps/upload", unsigned);
    expect(missing.status).toBe(409);
    expect(missing.json.error.details.code).toBe("signature.missing");

    actor = { id: "manager", isSuperAdmin: false };
    expect((await call("POST", "/apps/upload?allowUnsigned=true", unsigned)).status).toBe(403);
    actor = { id: "owner", isSuperAdmin: true };
    const accepted = await call("POST", "/apps/upload?allowUnsigned=true", unsigned);
    expect(accepted.status).toBe(200);
    expect(accepted.json.data).toMatchObject({ updated: false, app: { id: "acme.points", source: "upload", signed: false, signer: null, status: "installed" } });

    const developer = await createTestDeveloper("Beta Labs");
    const signed = await testPackage(await release("beta.reviews", "1.0.0"), developer);
    const untrusted = await call("POST", "/apps/upload", signed);
    expect(untrusted.status).toBe(409);
    expect(untrusted.json.error.details).toMatchObject({ code: "signature.untrusted", keyId: developer.key.id, developer: "Beta Labs" });
    const trusted = await call("POST", "/apps/upload?trustDeveloper=true", signed);
    expect(trusted.json.data.app).toMatchObject({ signed: true, signer: { keyId: developer.key.id, name: "Beta Labs" } });
    expect((await call("GET", "/apps/registry/settings")).json.data.trustedKeys.map((key: Json) => key.id)).toEqual([developer.key.id]);
  });

  it("stops one app or every third-party app at once, without a revision", async () => {
    const points = await installPlugin(db, { manifest: manifest("acme.points", "1.0.0", { icon: undefined }), source: "upload", bundleSha256: "a".repeat(64) });
    await activatePlugin(db, "acme.points", { actorUserId: "owner", expectedRevision: points.revision });
    const reviews = await installPlugin(db, { manifest: manifest("beta.reviews", "1.0.0", { icon: undefined }), source: "upload", bundleSha256: "a".repeat(64) });
    await activatePlugin(db, "beta.reviews", { actorUserId: "owner", expectedRevision: reviews.revision });

    const one = await call("POST", "/apps/acme.points/stop");
    expect(one.status).toBe(200);
    expect(one.json.data).toMatchObject({ stopped: true, app: { status: "disabled", failureReason: "Stopped with the emergency switch.", thirdParty: true } });
    expect((await call("POST", "/apps/acme.points/stop")).json.data.stopped).toBe(false);

    const all = await call("POST", "/apps/stop-third-party");
    expect(all.json.data).toEqual({ stopped: ["beta.reviews"] });
    expect((await requirePluginInstallation(db, "beta.reviews")).status).toBe("disabled");
    expect((await call("POST", "/apps/scalius.missing/stop")).status).toBe(404);
  });
});
