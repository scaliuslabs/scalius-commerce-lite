import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const root = resolve(new URL("..", import.meta.url).pathname);
const turboConfig = JSON.parse(readFileSync(resolve(root, "turbo.json"), "utf8"));

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

  it("hashes build-time environment variables", () => {
    expect(turboConfig.globalEnv).toEqual(
      expect.arrayContaining([
        "PUBLIC_API_URL",
        "PUBLIC_API_BASE_URL",
        "PUBLIC_STOREFRONT_URL",
        "STOREFRONT_URL",
        "CDN_DOMAIN_URL",
        "R2_PUBLIC_URL",
        "BETTER_AUTH_URL",
        "VITE_FIREBASE_API_KEY",
        "VITE_FIREBASE_AUTH_DOMAIN",
        "VITE_FIREBASE_PROJECT_ID",
        "VITE_FIREBASE_STORAGE_BUCKET",
        "VITE_FIREBASE_MESSAGING_SENDER_ID",
        "VITE_FIREBASE_APP_ID",
        "VITE_FIREBASE_MEASUREMENT_ID",
        "VITE_VAPID_FIREBASE",
      ]),
    );
  });
});
