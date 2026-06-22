import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const storefrontRoot = (() => {
  const packageRelative = process.cwd();
  if (existsSync(join(packageRelative, "src/pages/account.astro"))) return packageRelative;
  return join(process.cwd(), "apps/storefront");
})();

function readStorefrontSource(pathFromRoot: string): string {
  return readFileSync(join(storefrontRoot, pathFromRoot), "utf8");
}

describe("discount validation URL safety", () => {
  it("sends discount validation data in a POST body instead of a URL query", () => {
    const source = readStorefrontSource("src/lib/api/discounts.ts");

    expect(source).toContain("postApiV1DiscountsValidate");
    expect(source).toContain("body.items = apiItems");
    expect(source).not.toContain("getApiV1DiscountsValidate");
    expect(source).not.toContain("queryParams.items");
    expect(source).not.toContain("JSON.stringify(apiItems)");
    expect(source).not.toContain("customerPhone: customerPhone");
  });
});
