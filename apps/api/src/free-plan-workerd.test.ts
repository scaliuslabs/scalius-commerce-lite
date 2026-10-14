// Extends zod with .openapi() before the route schemas load.
import "@hono/zod-openapi";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@scalius/database/client";
import { createSqliteD1Database, type SqliteTestDatabase } from "@scalius/database/testing/sqlite-d1";
import { user as userTable } from "@scalius/database/schema";
import { createAuth } from "@scalius/core/auth";
import { savePlatformSettings } from "@scalius/core/modules/platform";
import { PLAN_LIMITS, type WorkersPlan } from "@scalius/shared/plan-limits";
import { storefrontBatchPath } from "@scalius/shared/public-api-cache-routes";
import { composeApiRuntimeEnv } from "./runtime/runtime-env";
import { STORE } from "./testing/free-plan-store";
import { cartItems, seedCatalog, seedOrders } from "./testing/free-plan-seed";

/**
 * The API Worker as production bundles it, run in workerd (Miniflare): the
 * only place a request's real CPU, the cold cost of lazily loaded route graphs
 * included, can be measured without deploying. Opt-in (bundling takes ~30 s):
 *
 *   FREE_PLAN_WORKERD=1 pnpm exec vitest run apps/api/src/free-plan-workerd.test.ts
 *
 * scripts/free-plan-budget.mjs --workerd runs it and prints the table.
 * workerd's clock advances while JavaScript runs locally, so CPU is an
 * invocation's wall time minus its waits on the D1 proxy (see
 * testing/workerd-harness.worker.ts). The numbers move with the machine: the
 * assertions are generous guards, the table is the evidence.
 */

const enabled = process.env.FREE_PLAN_WORKERD === "1";
/** The plan profile the bundled Worker is built for (`define` in its config, as the Paid deploy generates). */
const PLAN: WorkersPlan = process.env.FREE_PLAN_WORKERD_PLAN === "paid" ? "paid" : "free";
const apiDir = resolve(import.meta.dirname, "..");
const HARNESS = resolve(import.meta.dirname, "testing/workerd-harness.worker.ts");
const COMPATIBILITY_DATE = "2026-10-01";
const COMPATIBILITY_FLAGS = ["nodejs_compat", "global_fetch_strictly_public", "disable_nodejs_process_v2"];
const CREDENTIAL_KEY = btoa("0123456789abcdef0123456789abcdef");

/** Miniflare's own (undici) request init, not the Workers-types one `RequestInit` names here. */
type DispatchInit = NonNullable<Parameters<Miniflare["dispatchFetch"]>[1]>;

interface Timing { kind: string; cpuMs: number; wallMs: number; waitMs: number; d1Calls: number }
interface Row { id: string; label: string; cold: Timing; warm: Timing[]; }

const rows: Row[] = [];
const passwords: Array<{ spec: string; hash: { min: number; median: number; max: number }; verify: { min: number; median: number; max: number } }> = [];

describe.skipIf(!enabled)("the API Worker in workerd", () => {
  let created: SqliteTestDatabase;
  let mf: Miniflare;
  let workdir: string;
  let cookie = "";

  async function last(): Promise<Timing> {
    const response = await mf.dispatchFetch("http://harness/__harness/last");
    return await response.json() as Timing;
  }

  type Call = [string, DispatchInit?];

  async function measured(request: () => Call, runs: number): Promise<{ cold: Timing; warm: Timing[]; statuses: number[] }> {
    const timings: Timing[] = [];
    const statuses: number[] = [];
    for (let index = 0; index < runs; index += 1) {
      const [url, init] = request();
      const response = await mf.dispatchFetch(url, init);
      statuses.push(response.status);
      await response.arrayBuffer();
      timings.push(await last());
    }
    return { cold: timings[0]!, warm: timings.slice(1), statuses };
  }

  async function record(id: string, label: string, runs: number, request: (index: number) => Call): Promise<Row> {
    let index = -1;
    const result = await measured(() => request(++index), runs);
    for (const status of result.statuses) expect(status, `${id} status`).toBeLessThan(500);
    const row = { id, label, cold: result.cold, warm: result.warm };
    rows.push(row);
    return row;
  }

  beforeAll(async () => {
    created = createSqliteD1Database({ foreignKeys: true });
    seedCatalog(created.sqlite);
    seedOrders(created.sqlite, 1000);

    workdir = mkdtempSync(join(tmpdir(), "scalius-free-plan-workerd-"));
    writeFileSync(join(workdir, "wrangler.json"), JSON.stringify({
      name: "free-plan-workerd",
      main: HARNESS,
      minify: true,
      compatibility_date: COMPATIBILITY_DATE,
      compatibility_flags: COMPATIBILITY_FLAGS,
      ...(PLAN === "paid" ? { define: { __SCALIUS_PLAN__: JSON.stringify(PLAN) } } : {}),
    }));
    execFileSync(join(apiDir, "node_modules/.bin/wrangler"), ["deploy", "--dry-run", "--outdir", join(workdir, "dist"), "--config", join(workdir, "wrangler.json")], {
      cwd: apiDir,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });

    const binding = created.binding as unknown as {
      prepare(sql: string): { bind(...values: unknown[]): { all(): Promise<unknown>; run(): Promise<unknown>; raw(): Promise<unknown> } };
      batch(statements: unknown[]): Promise<unknown>;
    };
    mf = new Miniflare(convertV4MiniflareOptions({
      modules: true,
      scriptPath: join(workdir, "dist", "workerd-harness.worker.js"),
      modulesRoot: join(workdir, "dist"),
      compatibilityDate: COMPATIBILITY_DATE,
      compatibilityFlags: COMPATIBILITY_FLAGS,
      r2Buckets: ["BUCKET"],
      bindings: { SCALIUS_SECRET: STORE.masterSecret, CREDENTIAL_ENCRYPTION_KEY: CREDENTIAL_KEY },
      serviceBindings: {
        DB_PROXY: async (request: Request) => {
          const body = await request.json() as { op: string; sql: string; params: unknown[]; statements: Array<{ sql: string; params: unknown[] }> };
          try {
            if (body.op === "batch") {
              return Response.json(await binding.batch(body.statements.map((statement) => binding.prepare(statement.sql).bind(...statement.params))));
            }
            const statement = binding.prepare(body.sql).bind(...body.params);
            const result = body.op === "raw" ? await statement.raw() : body.op === "run" ? await statement.run() : await statement.all();
            return Response.json(result);
          } catch (error) {
            return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
          }
        },
      },
    }) as never);

    // The store: Platform settings, the owner.
    const db = getDb({ DB: created.binding } as unknown as Env);
    await savePlatformSettings(db, { storefrontUrl: STORE.storefront, apiUrl: STORE.api, dashboardUrl: STORE.dashboard }, null);
    const composed = await composeApiRuntimeEnv({
      DB: created.binding, SCALIUS_SECRET: STORE.masterSecret, CREDENTIAL_ENCRYPTION_KEY: CREDENTIAL_KEY,
    } as unknown as Env);
    // The owner's hash is the one this plan's sign-in verifies (no upgrade write inside a measurement).
    vi.stubGlobal("__SCALIUS_PLAN__", PLAN);
    const auth = createAuth(composed);
    const owner = await auth.api.signUpEmail({ body: { email: STORE.ownerEmail, password: STORE.ownerPassword, name: "Owner" } });
    vi.unstubAllGlobals();
    await db.update(userTable).set({ isSuperAdmin: true, role: "admin" }).where(eq(userTable.id, owner.user.id));
  }, 240_000);

  afterAll(async () => {
    const target = process.env.FREE_PLAN_WORKERD_REPORT;
    if (target) writeFileSync(target, `${JSON.stringify({ plan: PLAN, rows, passwords }, null, 2)}\n`);
    await mf?.dispose();
    created?.sqlite.close();
    if (workdir) rmSync(workdir, { recursive: true, force: true });
  });

  const json = (url: string, body: unknown, headers: Record<string, string> = {}): [string, DispatchInit] =>
    [url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }];

  it("password hashing at the Free and Paid cost", async () => {
    for (const [name, spec] of Object.entries({ free: PLAN_LIMITS.free.password, paid: PLAN_LIMITS.paid.password })) {
      const response = await mf.dispatchFetch("http://harness/__harness/password", { method: "POST", body: JSON.stringify({ spec, runs: 15 }) });
      const cost = await response.json() as { hash: { min: number; median: number; max: number }; verify: { min: number; median: number; max: number } };
      passwords.push({ spec: `${name}: ${JSON.stringify(spec)}`, ...cost });
      if (name === "free") {
        // The hash is one share of a 10 ms request: its best case must leave room for the rest of a sign-in.
        expect(cost.hash.min, "Free hash CPU (best of 15)").toBeLessThan(5);
        expect(cost.verify.min, "Free verify CPU (best of 15)").toBeLessThan(5);
      }
    }
  });

  it("the floor: a probe request, and constructing Better Auth", async () => {
    await record("workerd-health", "Probe request /api/v1/health (the Worker entry only)", 6, () => [`${STORE.api}/api/v1/health`]);
    const response = await mf.dispatchFetch("http://harness/__harness/auth-construct");
    const cost = await response.json() as { first: number; min: number; median: number; max: number };
    rows.push({
      id: "workerd-auth-construct",
      label: "createAuth(env): Better Auth constructed once per request (first, then median of 10)",
      cold: { kind: "construct", cpuMs: cost.first, wallMs: cost.first, waitMs: 0, d1Calls: 0 },
      warm: [{ kind: "construct", cpuMs: cost.median, wallMs: cost.median, waitMs: 0, d1Calls: 0 }],
    });
  });

  it("staff sign-in (first request pays the dashboard and auth graphs)", async () => {
    const row = await record("workerd-sign-in", "Staff password sign-in", 4, () => json(`${STORE.dashboard}/api/auth/sign-in/email`, {
      email: STORE.ownerEmail, password: STORE.ownerPassword,
    }, { Origin: STORE.dashboard }));
    expect(row.warm.length).toBeGreaterThan(0);
    const response = await mf.dispatchFetch(...json(`${STORE.dashboard}/api/auth/sign-in/email`, { email: STORE.ownerEmail, password: STORE.ownerPassword }, { Origin: STORE.dashboard }));
    const header = response.headers.getSetCookie().find((value) => value.includes("session_token="));
    expect(header, `sign-in answered ${response.status}: ${(await response.text()).slice(0, 300)}`).toBeDefined();
    cookie = header!.split(";")[0]!;
    expect(cookie).toContain("session_token=");
  });

  it("admin order list and product save", async () => {
    const admin = (path: string, init: DispatchInit = {}): Call => [`${STORE.dashboard}${path}`, {
      ...init,
      headers: { Cookie: cookie, Origin: STORE.dashboard, "Content-Type": "application/json" },
    }];
    await record("workerd-admin-orders", "Admin order list (50 rows)", 6, () => admin("/api/v1/admin/orders?limit=50&page=1"));
    await record("workerd-admin-product-save", "Admin product save", 5, (index) => {
      const revision = Number((created.sqlite.prepare("SELECT aggregate_revision AS r FROM products WHERE id = 'p_cotton'").get() as { r: number }).r);
      return admin("/api/v1/admin/products/p_cotton", {
        method: "PUT",
        body: JSON.stringify({
          id: "p_cotton", name: "Cotton Panjabi", description: "<p>Soft cotton.</p>", price: 1800 + index + 1, categoryId: "cat_panjabi",
          isActive: true, freeDelivery: false, metaTitle: null, metaDescription: null, slug: "cotton-panjabi", productCondition: "new",
          media: [], attributes: [], additionalInfo: [], expectedAggregateRevision: revision,
        }),
      });
    });
  });

  it("storefront pages through the batch route (cache miss, then hit)", async () => {
    const page = (parts: string[]) => (): Call => [`https://api.internal${storefrontBatchPath(parts)}`, { headers: { "X-Scalius-Cache-Generation": "gen1" } }];
    const product = ["/api/v1/storefront/layout", "/api/v1/products/linen-panjabi", "/api/v1/shipping-methods", "/api/v1/checkout/config", "/api/v1/storefront/product-apps/linen-panjabi"];
    await record("workerd-page-product-miss", "Storefront product page, all parts render (first call cold, then cached parts)", 6, page(product));
    const home = ["/api/v1/storefront/layout", "/api/v1/storefront/homepage", "/api/v1/shipping-methods", "/api/v1/checkout/config"];
    await record("workerd-page-home", "Storefront home page", 6, page(home));
  });

  it("checkout: tax quote and a 20-line commit", async () => {
    const lines = 20;
    const quoteBody = { items: cartItems(lines).map(({ productId, variantId, quantity }) => ({ productId, variantId, quantity })), city: "city_1", zone: "zone_1", shippingMethodId: "m_std", discountCodes: [] };
    await record("workerd-checkout-quote", "Checkout tax quote (20 lines)", 5, () => json(`${STORE.api}/api/v1/orders/tax-quote`, quoteBody));
    const quote = await (await mf.dispatchFetch(...json(`${STORE.api}/api/v1/orders/tax-quote`, quoteBody))).json() as { data: { quoteFingerprint: string } };
    await record("workerd-checkout-commit", "Checkout commit (20 lines)", 5, (index) => json(`${STORE.api}/api/v1/orders`, {
      checkoutRequestId: `workerd_${crypto.randomUUID()}`,
      expectedQuoteFingerprint: quote.data.quoteFingerprint,
      customerName: "Budget Buyer",
      customerPhone: `+88017${String(30000000 + index)}`,
      customerEmail: "buyer@shop.test",
      shippingAddress: "House 1, Road 2, Gulshan",
      city: "city_1", zone: "zone_1", notes: null,
      items: cartItems(lines), discountCodes: [], shippingCharge: 60, shippingMethodId: "m_std", paymentMethod: "cod",
    }));
  });

  it("customer OTP request", async () => {
    created.sqlite.exec("UPDATE settings SET value = value WHERE category = 'auth'");
    await record("workerd-otp-request", "Customer OTP request", 5, (index) => json(`${STORE.api}/api/v1/customer-auth/send-otp`, { method: "email", identifier: `buyer${index}@shop.test` }, { "CF-Connecting-IP": `203.0.113.${index + 1}` }));
  });

  it("cron maintenance, then a drain tick running a requested projection rebuild", async () => {
    const worker = await mf.getWorker();
    const timings: Timing[] = [];
    for (let index = 0; index < 4; index += 1) {
      await worker.scheduled({ cron: "* * * * *", scheduledTime: new Date(Date.parse("2026-10-03T10:15:00Z") + index * 900_000) });
      timings.push(await last());
    }
    rows.push({ id: "workerd-cron", label: "Cron maintenance run (idle store, sweep tick)", cold: timings[0]!, warm: timings.slice(1) });
    const drained: Timing[] = [];
    for (let index = 0; index < 3; index += 1) {
      created.sqlite.exec("INSERT INTO system_kv (key, value) VALUES ('catalog:projections:rebuild-cursor', '') ON CONFLICT(key) DO UPDATE SET value = ''");
      await worker.scheduled({ cron: "* * * * *", scheduledTime: new Date(Date.parse("2026-10-03T10:16:00Z") + index * 60_000) });
      drained.push(await last());
    }
    rows.push({ id: "workerd-drain-rebuild", label: "Drain tick: catalogue projection rebuild chunk", cold: drained[0]!, warm: drained.slice(1) });
  });
});

