import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { storefrontRootPath, storefrontSourcePath } from "./test-source-paths";

const middlewareSource = readFileSync(
  `${storefrontSourcePath()}/middleware.ts`,
  "utf8",
);
const wranglerSource = readFileSync(
  storefrontRootPath("wrangler.jsonc"),
  "utf8",
);

describe("storefront response cache boundaries", () => {
  it("keeps private and variant-specific responses out of shared caching", () => {
    expect(middlewareSource).toContain("requestBypassesPublicStorefrontCache");
    expect(middlewareSource).toContain(
      "hasStorefrontProductVariantSelectionParams(url)",
    );
    expect(middlewareSource).toContain('"BYPASS_VARIANT_SELECTION"');
    expect(middlewareSource).toContain('"BYPASS_AUTH"');
    expect(middlewareSource).toContain(
      '"private, no-cache, no-store, must-revalidate"',
    );
  });

  it("marks only successful anonymous public responses for the native lane", () => {
    expect(middlewareSource).toContain("getPublicStorefrontCachePolicy(request)");
    expect(middlewareSource).toContain("response.status === 200");
    expect(middlewareSource).toContain('response.headers.set("X-Cache-Status", "NATIVE")');
    expect(middlewareSource).toContain('response.headers.set("X-Storefront-Build", BUILD_ID)');
  });

  it("contains no Cache API or KV-generation implementation", () => {
    expect(middlewareSource).not.toContain("caches.default");
    expect(middlewareSource).not.toContain("CACHE_CONTROL");
    expect(middlewareSource).not.toContain("cacheGeneration");
    expect(middlewareSource).not.toContain("cacheVersion");
  });

  it("isolates native HTML caches between Worker deployments", () => {
    expect(wranglerSource).toMatch(
      /"cache"\s*:\s*\{[\s\S]*?"enabled"\s*:\s*true,[\s\S]*?"cross_version_cache"\s*:\s*false/,
    );
  });
});
