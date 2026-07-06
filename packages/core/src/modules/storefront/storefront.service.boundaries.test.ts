import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import { describe, expect, it } from "vitest";

const STOREFRONT_SERVICE_SOURCE = [
  join(cwd(), "packages/core/src/modules/storefront/storefront.service.ts"),
  join(cwd(), "src/modules/storefront/storefront.service.ts"),
].find(existsSync);

if (!STOREFRONT_SERVICE_SOURCE) {
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
});
