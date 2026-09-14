import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const root = resolve(new URL("..", import.meta.url).pathname);
const turboConfig = JSON.parse(readFileSync(resolve(root, "turbo.json"), "utf8"));
const rootPackage = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

describe("turbo cache inputs", () => {
  it("hashes app-local environment files that affect local builds", () => {
    expect(turboConfig.globalDependencies).toEqual(
      expect.arrayContaining([
        "apps/api/.dev.vars",
        "apps/api/.env*",
        "apps/admin-v2/.dev.vars",
        "apps/admin-v2/.env*",
        "apps/storefront/.dev.vars",
        "apps/storefront/.env*",
      ]),
    );
  });

  it("declares no build-time environment variables", () => {
    // Runtime configuration is a dashboard Platform setting served by
    // GET /api/v1/platform, and secrets are derived from SCALIUS_SECRET at
    // Worker entry. Nothing is baked into builds, so nothing hashes here.
    expect(turboConfig.globalEnv).toBeUndefined();
    const source = JSON.stringify(turboConfig);
    for (const retired of [
      "PUBLIC_API_URL",
      "PUBLIC_API_BASE_URL",
      "PUBLIC_STOREFRONT_URL",
      "STOREFRONT_URL",
      "CDN_DOMAIN_URL",
      "R2_PUBLIC_URL",
      "BETTER_AUTH_URL",
      "VITE_FIREBASE_",
      "VITE_VAPID_FIREBASE",
    ]) {
      expect(source).not.toContain(retired);
    }
  });

  it("keeps build outputs free of local env files", () => {
    expect(turboConfig.tasks.build.outputs).toEqual(expect.arrayContaining([
      "!dist/**/.dev.vars",
      "!dist/**/.env",
      "!dist/**/.env.*",
      "!dist/**/*.vars",
    ]));
  });

  it("runs workspace typechecks sequentially on constrained release hosts", () => {
    expect(rootPackage.scripts.typecheck).toContain("--concurrency=1");
  });
});
