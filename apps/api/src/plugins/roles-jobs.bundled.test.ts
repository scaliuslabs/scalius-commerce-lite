// App customer roles (`ctx.customers.roles`, customer-roles.ts) and app
// background jobs (`ctx.jobs`, jobs.ts) through the bundled loader on the
// migrated schema, with the Members test app: roles are the app's own
// (scope, cap, deleted customers, another app's rows), checkout functions
// see their own roles in `cart.customer.roles`, a job runs step by step on
// the bulk-run drain (idempotent start, state and progress, retries, cancel,
// an inactive app, staff reads that never show it) and uninstalling without
// the data removes both.
import type { DatabaseSync } from "node:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./bundled.gen", async (importOriginal) => (await import("./testing/fixture-apps")).withFixtureApps(await importOriginal()));
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { activatePlugin, deactivatePlugin, installPlugin, requirePluginInstallation, uninstallPlugin, type PluginInstallation } from "@scalius/core/modules/plugins";
import { PLUGIN_CUSTOMER_ROLES_MAX } from "@scalius/shared/plugins/customer-roles";
import { planLimits } from "@scalius/shared/plan-limits";
import { errorResponseFromError } from "../utils/api-response";
import { createBulkRun, drainBulkRuns } from "../bulk-runs/engine";
import { adminResourceBulkRoutes } from "../routes/admin/resources-bulk";
import { BUNDLED_PLUGINS } from "./bundled.gen";
import { PluginBridgeHost, type PluginBridgeEnvironment } from "./bridge";
import { pluginBridgeAuthority } from "./host";
import { runPluginFunctions } from "./functions";
import { installHello, pluginTestCtx, pluginTestEnv, settleBackground, testCart } from "./testing/fixtures";
import { manifest as membersManifest, MEMBERS_PER_STEP } from "./testing/apps/members/src/index";

let sqlite: DatabaseSync;
let db: Database;
let binding: D1Database;

beforeEach(() => {
  ({ sqlite, db, binding } = createSqliteD1Database());
  sqlite.exec(`
    INSERT INTO customers (id, name, phone) VALUES
      ('cust_a', 'Ayesha', '+8801711000001'), ('cust_b', 'Babul', '+8801711000002'),
      ('cust_c', 'Chandni', '+8801711000003'), ('cust_d', 'Dipu', '+8801711000004'),
      ('cust_e', 'Emon', '+8801711000005');
    INSERT INTO customers (id, name, phone, deleted_at) VALUES ('cust_gone', 'Gone', '+8801711000009', unixepoch());
  `);
});
afterEach(() => sqlite.close());

async function installMembers(): Promise<PluginInstallation> {
  sqlite.prepare("INSERT OR IGNORE INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
  const installed = await installPlugin(db, { manifest: membersManifest, source: "bundled", bundleSha256: BUNDLED_PLUGINS["acme.members"]!.sha256, actorUserId: "owner" });
  return activatePlugin(db, "acme.members", { actorUserId: "owner", expectedRevision: installed.revision });
}

/** The bridge's environment; `afterResponse: null` runs the after-start drain through `ctx.waitUntil` as in production. */
function environment(ctx = pluginTestCtx(), afterResponse: PluginBridgeEnvironment["afterResponse"] | null = () => undefined): PluginBridgeEnvironment {
  return { env: pluginTestEnv(binding), ctx, db: () => db, composedEnv: async () => pluginTestEnv(binding), ...(afterResponse ? { afterResponse } : {}) };
}

/** Steps run only when a test drains (the after-start drain is dropped unless `ctx` is given). */
function bridgeOf(installation: PluginInstallation, ctx?: ExecutionContext): PluginBridgeHost {
  return new PluginBridgeHost(
    { pluginId: installation.pluginId, version: installation.version, authority: pluginBridgeAuthority(installation) },
    ctx ? environment(ctx, null) : environment(),
  );
}

/** Another app with read_customers (the roles table names the app; no installation is needed to prove isolation). */
function otherAppBridge(): PluginBridgeHost {
  return new PluginBridgeHost({
    pluginId: "acme.other",
    version: "1.0.0",
    authority: { permissions: ["customers.view"], allowedHosts: [], objects: {}, customFields: [], jobs: [] },
  }, environment());
}

const runtime = () => ({ env: pluginTestEnv(binding), ctx: pluginTestCtx() });
const jobRow = (id: string) => sqlite.prepare("SELECT status, chunks, cursor, processed, total, error_code AS errorCode, lease_until AS leaseUntil, results FROM bulk_runs WHERE id = ?").get(id) as {
  status: string; chunks: number; cursor: string | null; processed: number; total: number; errorCode: string | null; leaseUntil: number | null; results: string;
};
const expireLeases = () => sqlite.exec("UPDATE bulk_runs SET lease_until = NULL");
const roleRows = (pluginId: string) => sqlite.prepare("SELECT customer_id AS customerId, role, ref FROM plugin_customer_roles WHERE plugin_id = ? ORDER BY customer_id, role").all(pluginId);

describe("app customer roles", () => {
  it("grants, lists and revokes the app's own roles; a re-grant updates the ref and a revoke is idempotent", async () => {
    const bridge = bridgeOf(await installMembers());
    await bridge.customerRolesGrant("cust_a", "seller", "seller_1");
    await bridge.customerRolesGrant("cust_a", "member");
    await bridge.customerRolesGrant("cust_a", "seller", "seller_2");
    const listed = await bridge.customerRolesList("cust_a");
    expect(listed.map(({ role, ref }) => ({ role, ref }))).toEqual([{ role: "member", ref: null }, { role: "seller", ref: "seller_2" }]);
    expect(listed.every((entry) => !Number.isNaN(Date.parse(entry.grantedAt)) && entry.grantedAt.endsWith("Z"))).toBe(true);
    await bridge.customerRolesRevoke("cust_a", "seller");
    await bridge.customerRolesRevoke("cust_a", "seller");
    await bridge.customerRolesRevoke("cust_b", "never");
    expect(roleRows("acme.members")).toEqual([{ customerId: "cust_a", role: "member", ref: null }]);
  });

  it("refuses an invalid role or ref, a missing or deleted customer, and an app without read_customers", async () => {
    const hello = await installHello(db, sqlite);
    const bridge = bridgeOf(await installMembers());
    await expect(bridge.customerRolesGrant("cust_a", "Seller")).rejects.toThrow("[customers_invalid]");
    await expect(bridge.customerRolesGrant("cust_a", "x".repeat(33))).rejects.toThrow("[customers_invalid]");
    await expect(bridge.customerRolesGrant("cust_a", "seller", "a\nb")).rejects.toThrow("[customers_invalid]");
    await expect(bridge.customerRolesGrant("cust_a", "seller", "r".repeat(129))).rejects.toThrow("[customers_invalid]");
    await expect(bridge.customerRolesGrant("cust_none", "seller")).rejects.toThrow("[customers_not_found]");
    await expect(bridge.customerRolesGrant("cust_gone", "seller")).rejects.toThrow("[customers_not_found]");

    const helloBridge = bridgeOf(hello);
    await expect(helloBridge.customerRolesGrant("cust_a", "seller")).rejects.toThrow("[customers_not_allowed]");
    await expect(helloBridge.customerRolesList("cust_a")).rejects.toThrow("[customers_not_allowed]");
    await expect(helloBridge.customerRolesRevoke("cust_a", "seller")).rejects.toThrow("[customers_not_allowed]");
    expect(roleRows("acme.members")).toEqual([]);
  });

  it("holds at most ten roles per app and customer, even under concurrent grants, and never shows another app's", async () => {
    const bridge = bridgeOf(await installMembers());
    for (let index = 0; index < PLUGIN_CUSTOMER_ROLES_MAX - 1; index += 1) await bridge.customerRolesGrant("cust_a", `role_${index}`);
    // Two grants race for the last place: exactly one wins.
    const raced = await Promise.allSettled([bridge.customerRolesGrant("cust_a", "late_1"), bridge.customerRolesGrant("cust_a", "late_2")]);
    expect(raced.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(String((raced.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult).reason)).toContain("[customer_roles_limit]");
    await expect(bridge.customerRolesGrant("cust_a", "eleventh")).rejects.toThrow("[customer_roles_limit]");
    // At the cap, a role it already holds can still be granted again (its ref changes).
    await bridge.customerRolesGrant("cust_a", "role_0", "again");
    expect(await bridge.customerRolesList("cust_a")).toHaveLength(PLUGIN_CUSTOMER_ROLES_MAX);

    // Another app has its own ten, and sees and removes none of these.
    const other = otherAppBridge();
    expect(await other.customerRolesList("cust_a")).toEqual([]);
    await other.customerRolesGrant("cust_a", "role_0");
    await other.customerRolesRevoke("cust_a", "role_1");
    expect((await bridge.customerRolesList("cust_a")).map((entry) => entry.role)).toContain("role_1");
    expect((await other.customerRolesList("cust_a")).map((entry) => entry.role)).toEqual(["role_0"]);
  });

  it("gives each app's checkout function its own roles in cart.customer.roles, and guests none", async () => {
    const members = await installMembers();
    const bridge = bridgeOf(members);
    const cartOf = (customerId: string | null) => ({
      ...testCart(100_000),
      customer: customerId ? { id: customerId, tags: [], segmentIds: [], orderCount: 0, totalSpentMinor: 0, roles: [] } : null,
    });
    const validate = (customerId: string | null) => runPluginFunctions("cart.validate", { cart: cartOf(customerId) }, pluginTestEnv(binding), pluginTestCtx(), { db });
    // Another app's member role is not this app's.
    await otherAppBridge().customerRolesGrant("cust_b", "member");
    expect((await validate("cust_b"))[0]!.output.errors).toEqual([{ code: "members_only", message: "This store sells to members only." }]);
    await bridge.customerRolesGrant("cust_a", "member");
    expect((await validate("cust_a"))[0]!.output.errors).toEqual([]);
    expect((await validate(null))[0]!.output.errors).toHaveLength(1);
  });

  it("uninstalling without the data deletes the app's roles and jobs; keeping it keeps the roles and stops the jobs", async () => {
    let members = await installMembers();
    const bridge = bridgeOf(members);
    await bridge.customerRolesGrant("cust_a", "member");
    await otherAppBridge().customerRolesGrant("cust_a", "member");
    const started = await bridge.jobsStart("import_members", { input: { customers: ["cust_b"] } });
    await uninstallPlugin(db, "acme.members", { keepData: true, expectedRevision: members.revision });
    expect(roleRows("acme.members")).toHaveLength(1);
    expect(jobRow(started.id)).toMatchObject({ status: "failed", errorCode: "app_inactive" });

    members = await installMembers();
    await bridgeOf(members).jobsStart("import_members", { input: { customers: ["cust_c"] }, key: "import-after-reinstall" });
    await uninstallPlugin(db, "acme.members", { keepData: false, expectedRevision: members.revision });
    expect(roleRows("acme.members")).toEqual([]);
    expect(sqlite.prepare("SELECT count(*) AS n FROM bulk_runs WHERE kind = 'app.job'").get()).toEqual({ n: 0 });
    // Another app's rows stay.
    expect(roleRows("acme.other")).toEqual([{ customerId: "cust_a", role: "member", ref: null }]);
  });
});

describe("app background jobs", () => {
  it("starts idempotently by key, runs its steps on the drain with state and progress, and finishes", async () => {
    const bridge = bridgeOf(await installMembers());
    const customers = ["cust_a", "cust_b", "cust_c", "cust_d", "cust_e"];
    const first = await bridge.jobsStart("import_members", { input: { customers }, key: "members-import-1" });
    expect(first).toEqual({ id: expect.stringMatching(/^job_[a-f0-9]{32}$/u), status: "running" });
    expect(await bridge.jobsStart("import_members", { input: { customers }, key: "members-import-1" })).toEqual(first);
    await expect(bridge.jobsStart("import_members", { input: { customers: ["cust_a"] }, key: "members-import-1" })).rejects.toThrow("[jobs_key_reused]");

    // A drain without a Worker runtime leaves app jobs alone.
    await drainBulkRuns(db, 10);
    expect(jobRow(first.id)).toMatchObject({ status: "running", chunks: 0 });

    await drainBulkRuns(db, 1, runtime());
    expect(jobRow(first.id)).toMatchObject({ status: "running", chunks: 1, cursor: JSON.stringify({ offset: MEMBERS_PER_STEP }), processed: 2, total: 5, leaseUntil: null });
    expect(await bridge.jobsGet(first.id)).toMatchObject({ id: first.id, name: "import_members", status: "running", progress: { done: 2, total: 5 }, message: "2 of 5 imported", error: null, steps: 1, finishedAt: null });
    await drainBulkRuns(db, 10, runtime());
    const done = await bridge.jobsGet(first.id);
    expect(done).toMatchObject({ status: "done", progress: { done: 5, total: 5 }, steps: 3, message: "5 of 5 imported", error: null });
    expect(done!.finishedAt).toEqual(expect.stringMatching(/Z$/u));
    expect(roleRows("acme.members").map((row) => (row as { customerId: string }).customerId)).toEqual(customers);
    // A finished job answers the same start again.
    expect(await bridge.jobsStart("import_members", { input: { customers }, key: "members-import-1" })).toEqual({ id: first.id, status: "done" });
  });

  it("runs the first steps right after the request that started the job", async () => {
    const ctx = pluginTestCtx();
    const bridge = bridgeOf(await installMembers(), ctx);
    const { id } = await bridge.jobsStart("import_members", { input: { customers: ["cust_a", "cust_b"] } });
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    await settleBackground();
    expect(jobRow(id)).toMatchObject({ status: "done", chunks: 1 });
  });

  it("refuses an undeclared job, a large input or key, and more running jobs than the plan allows", async () => {
    const bridge = bridgeOf(await installMembers());
    await expect(bridge.jobsStart("nope")).rejects.toThrow("[jobs_undeclared]");
    await expect(bridge.jobsStart("import_members", { input: { blob: "x".repeat(17 * 1024) } })).rejects.toThrow("[jobs_invalid]");
    await expect(bridge.jobsStart("import_members", { key: "short" })).rejects.toThrow("[jobs_invalid]");
    const limit = planLimits().plugins.runningJobs;
    for (let index = 0; index < limit; index += 1) await bridge.jobsStart("import_members", { input: { customers: [] } });
    await expect(bridge.jobsStart("import_members")).rejects.toThrow("[jobs_limit]");
    expect(await bridge.jobsList({ name: "import_members" })).toHaveLength(limit);
    await expect(bridge.jobsList({ limit: 21 })).rejects.toThrow("[jobs_invalid]");
  });

  it("tries a failing step three times a minute apart, then fails the job with a code", async () => {
    const bridge = bridgeOf(await installMembers());
    const thrown = await bridge.jobsStart("flaky", { input: { mode: "throw" } });
    const invalid = await bridge.jobsStart("flaky", { input: { mode: "invalid" } });
    await drainBulkRuns(db, 10, runtime());
    // One attempt each, then the job waits out its retry (the drain does not take it again at once).
    expect(jobRow(thrown.id)).toMatchObject({ status: "running", chunks: 0 });
    expect(JSON.parse(jobRow(thrown.id).results)).toMatchObject({ sample: [], failures: [], attempts: 1 });
    expect(jobRow(thrown.id).leaseUntil).toBeGreaterThan(Math.floor(Date.now() / 1000));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expireLeases();
      await drainBulkRuns(db, 10, runtime());
    }
    expect(await bridge.jobsGet(thrown.id)).toMatchObject({ status: "failed", error: "job_step_failed", steps: 0 });
    expect(await bridge.jobsGet(invalid.id)).toMatchObject({ status: "failed", error: "job_invalid_step", steps: 0 });
  });

  it("cancels a running job, and a cancelled or inactive app's job never runs another step", async () => {
    let members = await installMembers();
    const bridge = bridgeOf(members);
    const job = await bridge.jobsStart("import_members", { input: { customers: ["cust_a", "cust_b", "cust_c"] } });
    await drainBulkRuns(db, 1, runtime());
    expect(await bridge.jobsCancel(job.id)).toMatchObject({ status: "failed", error: "cancelled", steps: 1 });
    expect(await bridge.jobsCancel(job.id)).toMatchObject({ status: "failed", error: "cancelled" });
    await drainBulkRuns(db, 10, runtime());
    expect(jobRow(job.id)).toMatchObject({ chunks: 1 });
    await expect(bridge.jobsCancel("job_" + "0".repeat(32))).rejects.toThrow("[jobs_not_found]");

    const waiting = await bridge.jobsStart("import_members", { input: { customers: ["cust_d"] } });
    members = await requirePluginInstallation(db, "acme.members");
    await deactivatePlugin(db, "acme.members", { expectedRevision: members.revision });
    await drainBulkRuns(db, 10, runtime());
    expect(jobRow(waiting.id)).toMatchObject({ status: "failed", errorCode: "app_inactive", chunks: 0 });
  });

  it("shows an app only its own jobs, and staff bulk-run reads never show app jobs", async () => {
    const bridge = bridgeOf(await installMembers());
    const job = await bridge.jobsStart("import_members", { input: { customers: [] } });
    expect(await otherAppBridge().jobsGet(job.id)).toBeNull();
    expect(await otherAppBridge().jobsList()).toEqual([]);
    await expect(otherAppBridge().jobsCancel(job.id)).rejects.toThrow("[jobs_not_found]");

    const staff = await createBulkRun(db, { kind: "customers.tag", input: { customerIds: ["cust_a"], add: ["vip"] } } as never, { operationKey: "staff-run-1", createdBy: null, lease: false });
    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin");
    app.use("*", async (c, next) => {
      c.set("db", db as never);
      await next();
    });
    app.route("/resources", adminResourceBulkRoutes);
    app.onError((error, c) => { const { body, status } = errorResponseFromError(error); return c.json(body, status); });
    const read = async (path: string) => {
      const response = await app.request(`/api/v1/admin/resources${path}`);
      return { status: response.status, body: await response.json() as { data: { runs: Array<{ id: string }> } } };
    };
    expect((await read(`/bulk-runs/${job.id}`)).status).toBe(404);
    expect((await read(`/bulk-runs/${staff.row.id}`)).status).toBe(200);
    expect((await read("/bulk-runs")).body.data.runs.map((run) => run.id)).toEqual([staff.row.id]);
  });
});
