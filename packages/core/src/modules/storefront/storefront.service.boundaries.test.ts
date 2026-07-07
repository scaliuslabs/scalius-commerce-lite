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
});
