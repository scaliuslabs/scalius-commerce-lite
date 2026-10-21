// The bundled loader's egress guard must survive an app that reassigns
// `globalThis.fetch` (audit N6). The host keeps the fetch it captured at module
// load; the guard is a best-effort rule for trusted code, not a sandbox, but
// an app must never be handed the host's requests (provider calls carry API
// keys). This file runs the real behaviour: no ambient-fetch test seam, and a
// host fetch stub installed before the loader module loads.
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const hostReached = vi.hoisted(() => {
  Reflect.deleteProperty(globalThis, Symbol.for("scalius.plugins.ambientHostFetch"));
  const reached: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    reached.push(input instanceof Request ? input.url : String(input));
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  return reached;
});
vi.mock("./bundled.gen", async (importOriginal) => (await import("./testing/fixture-apps")).withHelloBundled(await importOriginal()));
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { PluginInstallation } from "@scalius/core/modules/plugins";
import type { PluginContext } from "@scalius/plugin-sdk";
import { PluginHost } from "./host";
import { BundledLoader, createEgressGuard } from "./loaders/bundled";
import { HELLO_BUNDLED } from "./testing/fixture-apps";
import { installHello, pluginTestCtx, pluginTestEnv } from "./testing/fixtures";
import helloModule from "./testing/apps/hello/src/index";

const ALLOWED = "api.example.com";
const hostStub = globalThis.fetch;

describe("createEgressGuard on a stand-in global scope", () => {
  function scope() {
    const original = vi.fn(async (_input: RequestInfo | URL) => new Response("host"));
    const target = { fetch: original as unknown as typeof fetch };
    return { original, target };
  }

  it("puts the host's guard back over the captured original when an app replaced it, never wrapping the replacement", async () => {
    const { original, target } = scope();
    const guard = createEgressGuard(target, original as unknown as typeof fetch, { lock: false });
    guard.ensure();
    expect(target.fetch).toBe(guard.guarded);

    // An app keeps the guarded fetch and installs its own function.
    const replacement = vi.fn(async (_input: RequestInfo | URL) => new Response("app"));
    target.fetch = replacement as unknown as typeof fetch;
    guard.ensure();

    expect(target.fetch).toBe(guard.guarded);
    await target.fetch("https://provider.example/charge");
    expect(original).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();
  });

  it("locks the guard in place where the runtime allows it", () => {
    const { original, target } = scope();
    const guard = createEgressGuard(target, original as unknown as typeof fetch, { lock: true });
    guard.ensure();
    expect(() => { target.fetch = (async () => new Response("app")) as typeof fetch; }).toThrow(TypeError);
    expect(() => Object.defineProperty(target, "fetch", { value: () => undefined })).toThrow(TypeError);
    expect(target.fetch).toBe(guard.guarded);
  });

  it("falls back to assignment when the runtime refuses to lock", () => {
    const { original } = scope();
    const refusing = { fetch: original as unknown as typeof fetch };
    Object.defineProperty(refusing, "fetch", { value: original, writable: true, configurable: false });
    const guard = createEgressGuard(refusing, original as unknown as typeof fetch, { lock: true });
    expect(() => guard.ensure()).not.toThrow();
    expect(refusing.fetch).toBe(guard.guarded);
  });
});

describe("a bundled app that reassigns globalThis.fetch", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let binding: D1Database;
  let installation: PluginInstallation;
  const appCalls: string[] = [];

  beforeEach(async () => {
    ({ sqlite, db, binding } = createSqliteD1Database());
    installation = await installHello(db, sqlite);
    hostReached.length = 0;
    appCalls.length = 0;
  });
  afterAll(() => sqlite?.close());

  function probeModule() {
    const probe = async (_request: unknown, ctx: PluginContext) => {
      const saved = globalThis.fetch;
      const own = async (input: RequestInfo | URL) => {
        appCalls.push(String(input));
        return saved(input);
      };
      const outcome: Record<string, string> = {};
      try {
        globalThis.fetch = own as typeof fetch;
        outcome.assign = "assigned";
      } catch {
        outcome.assign = "refused";
      }
      try {
        Object.defineProperty(globalThis, "fetch", { value: own, writable: true, configurable: true });
        outcome.define = "defined";
      } catch {
        outcome.define = "refused";
      }
      try {
        await fetch("https://evil.example/");
        outcome.plain = "reached";
      } catch (error) {
        outcome.plain = (error as Error).message.slice(0, 80);
      }
      try {
        await saved("https://evil.example/saved");
        outcome.saved = "reached";
      } catch (error) {
        outcome.saved = (error as Error).message.slice(0, 80);
      }
      // A host call from inside the invocation: ctx.http.fetch runs the host's fetch.
      outcome.http = await ctx.http.fetch(`https://${ALLOWED}/guarded`).then(() => "reached", (error: Error) => error.message);
      return { body: outcome };
    };
    const definition = helloModule as unknown as { routes: { public: Record<string, unknown> } };
    return { default: { ...definition, routes: { ...definition.routes, public: { ...definition.routes.public, greet: probe } } } };
  }

  function host(): PluginHost {
    const env = pluginTestEnv(binding);
    const loader = new BundledLoader({ env, ctx: pluginTestCtx(), db: () => db, composedEnv: async () => env }, {
      "acme.hello": { ...HELLO_BUNDLED, load: async () => probeModule() },
    });
    return new PluginHost({
      env,
      ctx: pluginTestCtx(),
      db,
      loaderFor: () => ({
        kind: "bundled",
        invoke: (target) => loader.invoke({
          ...target,
          bridgeProps: { ...target.bridgeProps, authority: { ...target.bridgeProps.authority, allowedHosts: [ALLOWED] } },
        }),
      }),
    });
  }

  it("never sees a later host fetch, while a disallowed in-scope fetch is still refused", async () => {
    const request = { method: "GET", subpath: "", query: {}, headers: {}, body: null, rawBody: null, staffId: null };
    const outcome = await host().invokeRoute(installation, "public", "greet", request);
    expect(outcome.ok).toBe(true);
    const body = outcome.value?.body as Record<string, string>;

    // In its own scope the app is refused whatever it installed.
    expect(body.plain).toMatch(/not permitted to access the internet/);
    expect(body.saved).toMatch(/not permitted to access the internet/);
    // The host's request through the bridge reached the captured original.
    expect(body.http).toBe("reached");
    expect(hostReached).toEqual([`https://${ALLOWED}/guarded`]);

    // After the invocation, host code still gets its own fetch, not the app's.
    hostReached.length = 0;
    await fetch("https://host.example/after");
    expect(hostReached).toEqual(["https://host.example/after"]);
    expect(appCalls).toEqual([]);
    expect(globalThis.fetch).not.toBe(hostStub);
  });
});
