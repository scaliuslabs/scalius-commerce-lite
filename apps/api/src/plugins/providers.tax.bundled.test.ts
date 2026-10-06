// An app tax provider through the bundled loader (the Workers Free path), as
// checkout calls it (MARKETS-DESIGN step 3c): a country region names the app
// and its tax replaces the store's rates there; the store-wide choice covers
// every region without its own; the system provider keeps the rest; and a
// quote fails closed (`tax_unavailable`) when the app cannot answer.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { activatePlugin, deactivatePlugin, getPluginInstallation, installPlugin, writePluginSettings } from "@scalius/core/modules/plugins";
import {
  calculateStorefrontTaxQuote,
  commitTaxDocument,
  createTaxRate,
  createTaxRegion,
  TAX_UNAVAILABLE_REASON,
  updateTaxSettings,
} from "@scalius/core/modules/tax";
import { PLUGIN_API_VERSION } from "@scalius/shared/plugins/api-version";
import { pluginTestCtx, pluginTestEnv } from "./testing/fixtures";

const PLUGIN_ID = "acme.levy";
const LEVY = `${PLUGIN_ID}:levy`;
const MANIFEST = {
  id: PLUGIN_ID,
  name: "Acme Levy",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "A tax provider fixture.",
  author: { name: "Acme" },
  settings: [{ key: "api_key", label: "API key", type: "secret", required: true }],
  providers: { tax: [{ id: "levy", name: "Acme Levy", operations: ["commit", "void"] }] },
} as const;

// 20% of every line and of shipping, named by the destination's country.
const CODE = `
const manifest = ${JSON.stringify(MANIFEST)};
const tax = (amount, country) => ({ taxMinor: Math.round(amount * 0.2), rateBps: 2000, jurisdiction: country, name: country + " VAT" });
export default {
  manifest,
  providers: {
    levy: {
      kind: "tax",
      async calculate(input) {
        return {
          calculationId: "levy-" + input.idempotencyKey.slice(4, 20),
          lines: input.lines.map((line) => ({ lineId: line.lineId, taxes: [tax(line.amountMinor, input.destination.country)] })),
          shipping: input.shippingMinor > 0 ? [tax(input.shippingMinor, input.destination.country)] : [],
        };
      },
      async commit(input) { return { documentId: "doc-" + input.orderId }; },
      async void(input) { return { documentId: "doc-" + input.orderId }; },
    },
  },
};
`;
const sha256 = createHash("sha256").update(CODE).digest("hex");
const fixture = vi.hoisted(() => ({ module: null as unknown, sha256: "" }));

vi.mock("./providers/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providers/runtime")>();
  const runtimeFor = (env: Env, db: Database) => ({
    env,
    db,
    canRun: () => true,
    host: async () => {
      const [{ PluginHost }, { BundledLoader }, { pluginTestCtx: testCtx }] = await Promise.all([
        import("./host"),
        import("./loaders/bundled"),
        import("./testing/fixtures"),
      ]);
      const ctx = testCtx();
      const loader = new BundledLoader(
        { env, ctx, db: () => db, composedEnv: async () => env },
        { [PLUGIN_ID]: { version: "1.0.0", sha256: fixture.sha256, load: async () => fixture.module } },
      );
      return new PluginHost({ env, ctx, db, loaderFor: () => loader });
    },
  });
  return {
    ...actual,
    createAppProviderRuntime: (options: { env: Env; db: Database }) => runtimeFor(options.env, options.db),
  };
});

import { createAppProviders } from "./providers/app-providers";
import { createAppProviderRuntime } from "./providers/runtime";

const KEY = Buffer.alloc(32, 7).toString("base64");

let workdir: string;
beforeAll(async () => {
  workdir = mkdtempSync(join(tmpdir(), "scalius-tax-fixture-"));
  const file = join(workdir, "levy.mjs");
  writeFileSync(file, CODE);
  fixture.module = await import(pathToFileURL(file).href);
  fixture.sha256 = sha256;
});
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

describe("an app tax provider through the bundled loader", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let env: Env;

  beforeEach(async () => {
    let binding: D1Database;
    ({ sqlite, db, binding } = createSqliteD1Database());
    env = pluginTestEnv(binding, { CREDENTIAL_ENCRYPTION_KEY: KEY });
    sqlite.prepare("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)").run();
    const installed = await installPlugin(db, { manifest: MANIFEST, source: "upload", bundleSha256: sha256, actorUserId: "owner" });
    const configured = await writePluginSettings(db, PLUGIN_ID, { api_key: "levy-api-key-0123456789" }, {
      expectedRevision: installed.revision,
      credentialEncryptionKey: KEY,
    });
    await activatePlugin(db, PLUGIN_ID, { actorUserId: "owner", expectedRevision: configured.revision });
    sqlite.exec(`
      INSERT INTO tax_classes (id, name) VALUES ('taxc_std', 'Standard');
      INSERT INTO tax_settings (id, enabled, tax_shipping, default_tax_class_id, display_label, version)
        VALUES ('default', 1, 1, 'taxc_std', 'Tax', 1);
    `);
    const bd = await createTaxRegion(db, { countryCode: "BD" });
    await createTaxRate(db, { taxClassId: "taxc_std", taxRegionId: bd.id, name: "VAT", rateBps: 1_500 });
    await createTaxRegion(db, { countryCode: "GB", providerId: LEVY });
    await createTaxRegion(db, { countryCode: "US" });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    sqlite.close();
    vi.restoreAllMocks();
  });

  const apps = () => createAppProviders(createAppProviderRuntime({ env, db, ctx: pluginTestCtx() }), KEY);
  const quote = (countryCode: string | null) => calculateStorefrontTaxQuote(db, {
    destination: countryCode ? { city: null, zone: null, area: null, countryCode } : { city: "city_1", zone: "zone_1", area: null },
    lines: [{ lineId: "l1", productId: "p1", variantId: "v1", unitPriceMinor: 10_000, quantity: 1, taxClassId: null }],
    shippingMinor: 1_000,
    currency: { code: "USD", decimalPlaces: 2, priceIncrementMinor: 1 },
  }, undefined, { apps: apps() });

  it("lets a country region's app provider replace the store's rates there, and keeps the system provider elsewhere", async () => {
    const gb = await quote("GB");
    expect(gb).toMatchObject({
      taxMinor: 2_200,
      totalMinor: 13_200,
      shippingTaxed: true,
      jurisdiction: { countryCode: "GB", providerId: LEVY, calculationId: expect.stringMatching(/^levy-/) },
    });
    expect(gb.lines[0]!.components).toEqual([{
      rateId: `${LEVY}:GB`, name: "GB VAT", rateBps: 2_000, priority: 0, compound: false,
      jurisdictionType: "provider", jurisdictionId: "GB", amountMinor: 2_000,
    }]);
    // After the order commits, the app's calculation becomes its document (the system keeps none).
    await expect(commitTaxDocument(gb, "ord_1", apps())).resolves.toEqual({ documentId: "doc-ord_1" });
    // Bangladesh: the merchant's rates through the system provider.
    const bd = await quote(null);
    await expect(commitTaxDocument(bd, "ord_2", apps())).resolves.toBeNull();
    expect(bd).toMatchObject({ taxMinor: 1_650, jurisdiction: { countryCode: "BD", providerId: "system", calculationId: null } });
    // The US region has no rate and no provider of its own: the system provider, no tax.
    expect(await quote("US")).toMatchObject({ taxMinor: 0, jurisdiction: { providerId: "system" } });
    // No region of France: no tax, and nobody asked.
    expect(await quote("FR")).toMatchObject({ taxMinor: 0, jurisdiction: { countryCode: "FR" } });
  });

  it("lets a store-wide app provider tax every region without a provider of its own", async () => {
    await updateTaxSettings(db, {
      expectedVersion: 1, enabled: true, taxShipping: true, defaultTaxClassId: "taxc_std", shippingTaxClassId: null,
      displayLabel: "Tax", providerId: LEVY,
    });
    expect(await quote("US")).toMatchObject({ taxMinor: 2_200, jurisdiction: { countryCode: "US", providerId: LEVY } });
    expect(await quote(null)).toMatchObject({ taxMinor: 2_200, jurisdiction: { countryCode: "BD", providerId: LEVY } });
  });

  it("fails closed when the app cannot run", async () => {
    const installation = await getPluginInstallation(db, PLUGIN_ID);
    await deactivatePlugin(db, PLUGIN_ID, { expectedRevision: installation!.revision });
    await expect(quote("GB")).rejects.toMatchObject({ details: { reason: TAX_UNAVAILABLE_REASON } });
    // Without the request's app providers too.
    await expect(calculateStorefrontTaxQuote(db, {
      destination: { city: null, zone: null, area: null, countryCode: "GB" },
      lines: [{ lineId: "l1", productId: "p1", variantId: "v1", unitPriceMinor: 10_000, quantity: 1, taxClassId: null }],
      shippingMinor: 0,
      currency: { code: "USD", decimalPlaces: 2, priceIncrementMinor: 1 },
    })).rejects.toMatchObject({ details: { reason: TAX_UNAVAILABLE_REASON } });
    // Bangladesh keeps working on the system provider.
    expect((await quote(null)).taxMinor).toBe(1_650);
  });
});
