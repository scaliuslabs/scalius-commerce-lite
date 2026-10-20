// The bundled loader runs app code in the API Worker's own isolate, which
// has the network. The sandbox cuts it (`globalOutbound: null`), so an app's
// only egress is `ctx.http.fetch` (allowedHosts, https, public, redirects
// re-checked). The bundled loader must hold the same line: a plain `fetch`
// from app code is refused there exactly as the sandbox refuses it, even to a
// host the app is allowed, while `ctx.http.fetch` and the host's own fetches
// keep working.
import type { DatabaseSync } from "node:sqlite";
import { vi, afterEach, beforeEach, describe, expect, it } from "vitest";
vi.mock("./bundled.gen", async (importOriginal) => (await import("./testing/fixture-apps")).withHelloBundled(await importOriginal()));
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { PluginInstallation } from "@scalius/core/modules/plugins";
import type { PluginContext } from "@scalius/plugin-sdk";
import { PluginHost } from "./host";
import { BundledLoader } from "./loaders/bundled";
import { HELLO_BUNDLED } from "./testing/fixture-apps";
import { installHello, pluginTestCtx, pluginTestEnv } from "./testing/fixtures";
import helloModule from "./testing/apps/hello/src/index";

const ALLOWED = "api.example.com";

async function attempt(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "reached";
  } catch (error) {
    const coded = error as { code?: unknown; message?: unknown };
    return typeof coded.code === "string" ? coded.code : String(coded.message ?? error).slice(0, 120);
  }
}

/** Hello with its public `greet` route replaced by an egress probe. */
function probeModule() {
  const probe = async (_request: unknown, ctx: PluginContext) => {
    const later = new Promise<string>((resolve) => setTimeout(() => resolve(attempt(() => fetch(`https://${ALLOWED}/timer`))), 0));
    return {
      body: {
        plainAllowed: await attempt(() => fetch(`https://${ALLOWED}/plain`)),
        plainOther: await attempt(() => globalThis.fetch(new Request("https://evil.example/"))),
        plainLater: await later,
        http: await attempt(() => ctx.http.fetch(`https://${ALLOWED}/guarded`)),
        httpOther: await attempt(() => ctx.http.fetch("https://evil.example/")),
      },
    };
  };
  const definition = helloModule as unknown as { routes: { public: Record<string, unknown> } };
  return { default: { ...definition, routes: { ...definition.routes, public: { ...definition.routes.public, greet: probe } } } };
}

describe("app egress through the bundled loader", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let binding: D1Database;
  let installation: PluginInstallation;
  const reached: string[] = [];

  beforeEach(async () => {
    ({ sqlite, db, binding } = createSqliteD1Database());
    installation = await installHello(db, sqlite);
    reached.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      reached.push(input instanceof Request ? input.url : String(input));
      return new Response("ok", { status: 200 });
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    sqlite.close();
  });

  function host(): PluginHost {
    const env = pluginTestEnv(binding);
    const loader = new BundledLoader({ env, ctx: pluginTestCtx(), db: () => db, composedEnv: async () => env }, {
      "acme.hello": { ...HELLO_BUNDLED, load: async () => probeModule() },
    });
    return new PluginHost({
      env,
      ctx: pluginTestCtx(),
      db,
      // The app is granted one host, so only the loader's rule can refuse it.
      loaderFor: () => ({
        kind: "bundled",
        invoke: (target) => loader.invoke({
          ...target,
          bridgeProps: { ...target.bridgeProps, authority: { ...target.bridgeProps.authority, allowedHosts: [ALLOWED] } },
        }),
      }),
    });
  }

  it("refuses a plain fetch from app code, even to an allowed host, as the sandbox does; ctx.http.fetch still enforces allowedHosts", async () => {
    const request = { method: "GET", subpath: "", query: {}, headers: {}, body: null, rawBody: null, staffId: null };
    const outcome = await host().invokeRoute(installation, "public", "greet", request);
    expect(outcome.ok).toBe(true);
    const body = outcome.value?.body as Record<string, string>;
    expect(body.plainAllowed).toMatch(/not permitted to access the internet/);
    expect(body.plainOther).toMatch(/not permitted to access the internet/);
    expect(body.plainLater).toMatch(/not permitted to access the internet/);
    expect(body.http).toBe("reached");
    expect(body.httpOther).toBe("http.not_allowed");
    expect(reached).toEqual([`https://${ALLOWED}/guarded`]);
  });

  it("leaves the host's own fetches alone outside an app's invocation", async () => {
    await host().invokeRoute(installation, "public", "greet", { method: "GET", subpath: "", query: {}, headers: {}, body: null, rawBody: null, staffId: null });
    reached.length = 0;
    await fetch("https://host.example/after");
    expect(reached).toEqual(["https://host.example/after"]);
  });
});
