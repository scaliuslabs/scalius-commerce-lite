import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import { describe, expect, it } from "vitest";

const STOREFRONT_SERVICE_SOURCE = [
  join(cwd(), "packages/core/src/modules/storefront/storefront.service.ts"),
  join(cwd(), "src/modules/storefront/storefront.service.ts"),
].find(existsSync);
const API_STOREFRONT_ROUTE_SOURCE = [
  join(cwd(), "apps/api/src/routes/storefront.ts"),
  join(cwd(), "../../apps/api/src/routes/storefront.ts"),
].find(existsSync);

if (!STOREFRONT_SERVICE_SOURCE || !API_STOREFRONT_ROUTE_SOURCE) {
  throw new Error("Unable to locate storefront service source");
}

describe("storefront layout data boundaries", () => {
  it("resolves only collections explicitly placed on the homepage", () => {
    const source = readFileSync(STOREFRONT_SERVICE_SOURCE, "utf8");

    expect(source).toContain("collection.parsedConfig.showOnHomepage");
    expect(source.indexOf("filter((collection) => collection.parsedConfig.showOnHomepage)"))
      .toBeLessThan(source.indexOf("const resolvedMap = await resolveCollectionProductsBatch"));
  });

  it("includes merchant return-policy settings in the consolidated layout payload", () => {
    const source = readFileSync(STOREFRONT_SERVICE_SOURCE, "utf8");

    expect(source).toContain("parseSeoReturnPolicySettings");
    expect(source).toContain('eq(settings.key, "return_policy")');
    expect(source).toContain("const returnPolicy = parseSeoReturnPolicySettings");
    expect(source).toContain("returnPolicy,");
  });

  it("only enables Meta CAPI browser dispatch after strict credential readiness", () => {
    const serviceSource = readFileSync(STOREFRONT_SERVICE_SOURCE, "utf8");
    const routeSource = readFileSync(API_STOREFRONT_ROUTE_SOURCE, "utf8");

    expect(serviceSource).toContain("readStoredCredentialStrict");
    expect(serviceSource).toContain("credentialEncryptionKey");
    expect(serviceSource).toContain("Meta Conversions API access token");
    expect(serviceSource).toContain("metaCapiAccessToken.value.trim()");
    expect(routeSource).toContain("credentialEncryptionKey: c.env.CREDENTIAL_ENCRYPTION_KEY");
  });

  it("normalizes storefront currency through the shared supported-code contract", () => {
    const source = readFileSync(STOREFRONT_SERVICE_SOURCE, "utf8");

    expect(source).toContain("normalizeSupportedCurrencyCode");
    expect(source).toContain("const currencyCode = normalizeSupportedCurrencyCode(currencyMap.currency_code)");
    expect(source).toContain("code: DEFAULT_CURRENCY.code");
    expect(source).not.toContain('code: currencyMap.currency_code ?? "BDT"');
  });
});
