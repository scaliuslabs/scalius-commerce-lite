// The service ports through the plugin host (bundled loader): search,
// address autocomplete, FX rates, push and chat messaging reach an active,
// approved, configured app exactly through their port; an answer that does
// not match the port is refused; an app that is not ready answers nothing;
// and the consumers use them (the address autocomplete routes, a market's
// exchange rate source, a buyer push through the store's choice).
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
import { activatePlugin, installPlugin, writePluginSettings } from "@scalius/core/modules/plugins";
import { resolveAppProvider } from "@scalius/core/integrations/provider-port";
import { createMarket, getMarket, refreshMarketFxRates, updateMarket } from "@scalius/core/modules/markets";
import { notificationsDocument, sendCustomerPush } from "@scalius/core/modules/notifications";
import { errorResponseFromError } from "../../utils/api-response";
import { PLUGIN_TEST_CREDENTIAL_KEY, pluginTestCtx, pluginTestEnv } from "../testing/fixtures";
import { SERVICES_FIXTURE_CODE, SERVICES_FIXTURE_ID, SERVICES_FIXTURE_MANIFEST } from "../testing/services-fixture";
import type { AppProviderRuntime } from "./runtime";

const sha256 = createHash("sha256").update(SERVICES_FIXTURE_CODE).digest("hex");
const fixture = vi.hoisted(() => ({ module: null as unknown, runtime: null as unknown }));

/** A runtime whose host loads the fixture as a bundled plugin. */
function fixtureRuntime(env: Env, db: Database): AppProviderRuntime {
  const ctx = pluginTestCtx();
  let host: Promise<import("../host").PluginHost> | null = null;
  return {
    env,
    db,
    canRun: () => true,
    host() {
      host ??= Promise.all([import("../host"), import("../loaders/bundled")]).then(([{ PluginHost }, { BundledLoader }]) => {
        const loader = new BundledLoader(
          { env, ctx, db: () => db, composedEnv: async () => env },
          { [SERVICES_FIXTURE_ID]: { version: "1.0.0", sha256, load: async () => fixture.module } },
        );
        return new PluginHost({ env, ctx, db, loaderFor: () => loader });
      });
      return host;
    },
  };
}

vi.mock("./runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime")>();
  return {
    ...actual,
    requestProviderRuntime: (c: { env: Env; get(key: "db"): Database }) => fixtureRuntime(c.env, c.get("db")),
  };
});

import { createAppProviders } from "./app-providers";
import { appFxRateSource } from "./fx";
import { addressAutocompleteRoutes } from "../../routes/address-autocomplete";
import { marketsSettingsRoutes } from "../../routes/admin/settings/markets";

let workdir: string;
beforeAll(async () => {
  workdir = mkdtempSync(join(tmpdir(), "scalius-services-"));
  const file = join(workdir, "services.mjs");
  writeFileSync(file, SERVICES_FIXTURE_CODE);
  fixture.module = await import(pathToFileURL(file).href);
});
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

let sqlite: DatabaseSync;
let db: Database;
let env: Env;

beforeEach(async () => {
  let binding: D1Database;
  ({ sqlite, db, binding } = createSqliteD1Database());
  env = pluginTestEnv(binding);
  sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
  await installPlugin(db, { manifest: SERVICES_FIXTURE_MANIFEST, source: "upload", bundleSha256: sha256, actorUserId: "owner" });
});
afterEach(() => sqlite.close());

async function configure() {
  const configured = await writePluginSettings(db, SERVICES_FIXTURE_ID, { api_key: "services-key-0123456789" }, {
    expectedRevision: 1,
    credentialEncryptionKey: PLUGIN_TEST_CREDENTIAL_KEY,
  });
  await activatePlugin(db, SERVICES_FIXTURE_ID, { actorUserId: "owner", expectedRevision: configured.revision });
}

const apps = () => createAppProviders(fixtureRuntime(env, db), PLUGIN_TEST_CREDENTIAL_KEY);

describe("service ports through the plugin host", () => {
  it("answers nothing before the app is configured and active, then each port through its contract", async () => {
    expect((await resolveAppProvider(apps(), "search", `${SERVICES_FIXTURE_ID}:search`)).provider).toBeNull();
    await configure();
    const providers = apps();

    const search = (await resolveAppProvider(providers, "search", `${SERVICES_FIXTURE_ID}:search`)).provider!;
    expect(await search.search({ query: "hilsa", locale: "en", marketId: "mkt_backup", limit: 1 }, {})).toEqual({ productIds: ["prod_hilsa"] });
    // An answer that breaks the port is the provider's failure, never the consumer's data.
    await expect(search.search({ query: "broken", locale: "en", marketId: "mkt_backup", limit: 5 }, {})).rejects.toMatchObject({ category: "retryable" });

    const places = (await resolveAppProvider(providers, "address", `${SERVICES_FIXTURE_ID}:places`)).provider!;
    expect(places.countries).toEqual(["BD"]);
    const push = (await resolveAppProvider(providers, "push", `${SERVICES_FIXTURE_ID}:push`)).provider!;
    expect(await push.send({ audience: "customer", recipients: ["cust_1"], notification: { title: "Shipped", body: "" } }, {}))
      .toEqual({ success: true, delivered: 1, providerRef: "push-cust_1" });
    const chat = (await resolveAppProvider(providers, "messaging", `${SERVICES_FIXTURE_ID}:chat`)).provider!;
    expect(await chat.send({ channel: "whatsapp", to: "+8801711111111", template: { name: "order_update", language: "en_US", parameters: ["A"] } }, {}))
      .toEqual({ success: true, providerRef: "wamid-order_update" });
    await expect(chat.send({ channel: "whatsapp", to: "+8801700000000", text: "Hi" }, {})).rejects.toMatchObject({ category: "declined" });

    const rates = await appFxRateSource(providers, `${SERVICES_FIXTURE_ID}:rates`);
    if ("issue" in rates) throw new Error(rates.issue);
    expect(await rates.rate("BDT", "USD")).toEqual({ rate: "0.0084", asOf: new Date("2026-10-08T06:00:00Z") });
  });

  it("keeps a market's rate from the app on the scheduled refresh", async () => {
    await configure();
    const india = await createMarket(db, { name: "United States", status: "active", countries: ["US"], presence: null });
    const own = (await updateMarket(db, india.id, { expectedRevision: 1, currencyCode: "USD", fxRate: "0.008" }, { chargeable: "any" })).market;
    await updateMarket(db, india.id, { expectedRevision: own.revision, fxRateSource: `${SERVICES_FIXTURE_ID}:rates`, fxRate: "0.0083" });
    const providers = apps();
    const result = await refreshMarketFxRates(db, async (id) => {
      const source = await appFxRateSource(providers, id);
      return "issue" in source ? null : source;
    });
    expect(result).toEqual({ markets: 1, changed: 1, failed: 0 });
    expect(await getMarket(db, india.id)).toMatchObject({ fxRate: "0.0084", fxRateSource: `${SERVICES_FIXTURE_ID}:rates` });
  });

  it("sends a buyer's push through the store's app push provider when chosen", async () => {
    await configure();
    sqlite.exec("INSERT INTO customers (id, name, phone) VALUES ('cust_1', 'Karim', '+8801711111111')");
    await notificationsDocument.write(db, { pushProvider: `${SERVICES_FIXTURE_ID}:push` });
    expect(await sendCustomerPush(db, env, apps(), { customerId: "cust_1", notification: { title: "Shipped", body: "" } })).toEqual({ delivered: true });
  });
});

describe("a market's exchange rate app", () => {
  it("asks the app for the rate when the merchant chooses it, and refuses an app that cannot answer", async () => {
    const market = await createMarket(db, { name: "United States", status: "active", countries: ["US"], presence: null });
    const own = (await updateMarket(db, market.id, { expectedRevision: 1, currencyCode: "USD", fxRate: "0.008" }, { chargeable: "any" })).market;
    const router = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1/admin/settings");
    router.use("*", async (c, next) => {
      c.set("db", db as never);
      await next();
    });
    router.route("/markets", marketsSettingsRoutes);
    router.onError((error, c) => {
      const { body, status } = errorResponseFromError(error);
      return c.json(body, status);
    });
    const patch = async (payload: unknown) => {
      const response = await router.request(`/api/v1/admin/settings/markets/${market.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }, env);
      return { status: response.status, json: await response.json() as { data: { market: Record<string, unknown> }; error: { message: string } } };
    };
    // Installed but not configured: the save says why and changes nothing.
    const refused = await patch({ expectedRevision: own.revision, fxRateSource: `${SERVICES_FIXTURE_ID}:rates` });
    expect(refused.status).toBe(400);
    expect((await getMarket(db, market.id)).fxRateSource).toBe("manual");
    expect((await patch({ expectedRevision: own.revision, fxRateSource: "acme.unknown:rates" })).status).toBe(400);
    await configure();
    const chosen = await patch({ expectedRevision: own.revision, fxRateSource: `${SERVICES_FIXTURE_ID}:rates`, fxRate: "99" });
    expect(chosen.status).toBe(200);
    expect(chosen.json.data.market).toMatchObject({ fxRateSource: `${SERVICES_FIXTURE_ID}:rates`, fxRate: "0.0084" });
  });
});

describe("address autocomplete routes", () => {
  function app() {
    const router = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
    router.use("*", async (c, next) => {
      c.set("db", db as never);
      await next();
    });
    router.route("/address-rules/autocomplete", addressAutocompleteRoutes);
    router.onError((error, c) => {
      const { body, status } = errorResponseFromError(error);
      return c.json(body, status);
    });
    return router;
  }
  const body = { provider: `${SERVICES_FIXTURE_ID}:places`, country: "BD", locale: "en", sessionToken: "session-token-0123456789" };
  const post = async (path: string, payload: unknown) => {
    const response = await app().request(`/api/v1/address-rules/autocomplete/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }, env);
    return { status: response.status, cache: response.headers.get("cache-control"), json: await response.json() as { data: Record<string, unknown> } };
  };

  it("suggests and resolves through the store's address app, for its countries only, never cached", async () => {
    expect((await post("suggest", { ...body, query: "House 12" })).json.data).toEqual({ suggestions: [] });
    await configure();
    const suggested = await post("suggest", { ...body, query: "House 12" });
    expect(suggested.cache).toBe("private, no-store");
    expect(suggested.json.data).toEqual({ suggestions: [{ id: "place_1", text: "House 12, Dhanmondi", secondaryText: "Dhaka 1205" }] });
    expect((await post("resolve", { ...body, id: "place_1" })).json.data).toEqual({
      address: { countryCode: "BD", line1: "House 12, Road 5", locality: "Dhaka", postalCode: "1205" },
    });
    // Another country than the app knows: nothing, the buyer types the address.
    expect((await post("suggest", { ...body, country: "IN", query: "House 12" })).json.data).toEqual({ suggestions: [] });
    expect((await post("suggest", { ...body, query: "ab" })).status).toBe(400);
  });
});
