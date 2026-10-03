// A test Worker for the sandbox loader (plugins.sandbox.test.ts). It is the
// real host code (PluginHost, SandboxLoader, PluginBridge, the dispatcher and
// the admin app) bundled by Wrangler and run by Miniflare with a real Worker
// Loader binding. Only the database differs: D1 calls are forwarded to the
// test process, which holds the migrated schema in node:sqlite.

import type { Database } from "@scalius/database/client";
import { PluginBridge as WorkerPluginBridge } from "../bridge-entrypoint";
import type { PluginBridgeEnvironment } from "../bridge";

// Like the API Worker, nothing heavy loads in global scope: host code is
// imported on the first request.

interface HarnessBindings {
  DB_PROXY: { fetch(input: string, init?: RequestInit): Promise<Response> };
  BUCKET: R2Bucket;
  LOADER: WorkerLoader;
  CREDENTIAL_ENCRYPTION_KEY: string;
}

type Statement = { sql: string; params: unknown[] };

/** A D1Database whose statements run in the test process. */
function remoteD1(proxy: HarnessBindings["DB_PROXY"]): D1Database {
  const send = async (body: unknown): Promise<unknown> => {
    const response = await proxy.fetch("http://db/", { method: "POST", body: JSON.stringify(body) });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  };
  const statement = (sql: string, params: unknown[] = []) => ({
    sql,
    params,
    bind: (...values: unknown[]) => statement(sql, values),
    all: () => send({ op: "all", sql, params }),
    run: () => send({ op: "run", sql, params }),
    raw: () => send({ op: "raw", sql, params }),
    first: async (column?: string) => {
      const result = await send({ op: "all", sql, params }) as { results: Array<Record<string, unknown>> };
      const row = result.results[0];
      return column ? row?.[column] ?? null : row ?? null;
    },
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: (statements: Statement[]) => send({ op: "batch", statements: statements.map(({ sql, params }) => ({ sql, params })) }),
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

function harnessEnv(bindings: HarnessBindings): Env {
  return {
    ...(bindings as unknown as Env),
    DB: remoteD1(bindings.DB_PROXY),
    CACHE: { get: async () => null, put: async () => undefined, delete: async () => undefined, list: async () => ({ keys: [], list_complete: true }) },
    RL_STANDARD: { limit: async () => ({ success: true }) },
    JOBS_QUEUE: { send: async () => undefined, sendBatch: async () => undefined },
    PUBLIC_API_BASE_URL: "https://api.shop.test",
    STOREFRONT_URL: "https://shop.test",
    BETTER_AUTH_URL: "https://admin.shop.test",
    JWT_SECRET: "sandbox-harness-jwt-secret-0123456789abcdef",
    BETTER_AUTH_SECRET: "sandbox-harness-auth-secret-0123456789abcdef",
  } as unknown as Env;
}

async function harnessDb(env: Env): Promise<Database> {
  const [{ drizzle }, schema] = await Promise.all([import("drizzle-orm/d1"), import("@scalius/database/schema")]);
  return drizzle(env.DB as D1Database, { schema }) as unknown as Database;
}

/** The real bridge entrypoint, with the harness database. */
export class PluginBridge extends WorkerPluginBridge {
  protected override readonly environment = async (): Promise<PluginBridgeEnvironment> => {
    const env = harnessEnv(this.env as unknown as HarnessBindings);
    const db = await harnessDb(env);
    return { env, ctx: this.ctx, db: () => db, composedEnv: async () => env };
  };
}

export default {
  async fetch(request: Request, bindings: HarnessBindings, ctx: ExecutionContext): Promise<Response> {
    const env = harnessEnv(bindings);
    const db = await harnessDb(env);
    const [{ requirePluginInstallation }, { PluginHost }, { runPluginFunctions }] = await Promise.all([
      import("@scalius/core/modules/plugins"),
      import("../host"),
      import("../functions"),
    ]);
    const command = await request.json() as {
      action: "event" | "function" | "route" | "cron" | "lifecycle" | "deliver" | "price" | "provider";
      pluginId: string;
      [key: string]: unknown;
    };
    if (command.action === "price") {
      // A checkout priced the way the quote and the order price it, with
      // every active app's checkout functions (core checkout/pricing.ts).
      const [{ listActiveFunctionRegistrations }, checkout, { createCheckoutAppFunctions }] = await Promise.all([
        import("@scalius/core/modules/plugins"),
        import("@scalius/core/modules/checkout"),
        import("../checkout-functions"),
      ]);
      const data = command.input as Parameters<typeof checkout.loadStorefrontCheckoutAuthority>[1] & { discountCodes: string[] };
      const read = await checkout.loadStorefrontCheckoutAuthority(db, data);
      const apps = createCheckoutAppFunctions({ env, ctx, db, registrations: await listActiveFunctionRegistrations(db) });
      const priced = await checkout.priceStorefrontCheckout(db, {
        cartValidation: read.cartValidation,
        delivery: read.deliveryPreflight,
        discountCodes: data.discountCodes,
        currency: { code: "BDT", decimalPlaces: 2, priceIncrementMinor: 100 },
        taxAuthority: read.taxAuthority,
        apps,
        channel: "online_store",
        location: { city: data.city, zone: data.zone, area: data.area },
      });
      return Response.json({
        points: [...apps.points].sort(),
        appDiscounts: priced.appDiscounts,
        ruleErrors: priced.ruleErrors,
        discountMinor: priced.taxQuote.discountMinor,
        totalMinor: priced.taxQuote.totalMinor,
      });
    }
    if (command.action === "deliver") {
      // The whole `plugins.deliver` consumer: claim, host, record.
      const { processPluginEventDelivery } = await import("../event-delivery");
      return Response.json(await processPluginEventDelivery({ db, env, ctx, deliveryId: command.deliveryId as string }));
    }
    const installation = await requirePluginInstallation(db, command.pluginId);
    const host = new PluginHost({ env, ctx, db });
    switch (command.action) {
      case "event":
        return Response.json(await host.invokeEvent(installation, command.event as never));
      case "function":
        return Response.json(await runPluginFunctions(command.point as never, command.input as never, env, ctx, { db }));
      case "route":
        return Response.json(await host.invokeRoute(installation, command.surface as never, command.name as string, command.request as never));
      case "cron":
        return Response.json(await host.invokeCron(installation, command.name as string, command.scheduledAt as string));
      case "lifecycle":
        return Response.json(await host.invokeLifecycle(installation, command.hook as never));
      case "provider":
        // The port's answer, or its ProviderError's fields as they reached the host.
        try {
          return Response.json({
            ok: true,
            value: await host.invokeProvider(installation, command.kind as never, command.provider as string, command.operation as never, command.input as never),
          });
        } catch (error) {
          const failure = error as { name?: string; category?: string; uncertain?: boolean; code?: string; message?: string };
          return Response.json({ ok: false, error: { name: failure.name, category: failure.category, uncertain: failure.uncertain, code: failure.code, message: failure.message } });
        }
    }
  },
};
