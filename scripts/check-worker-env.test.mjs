import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_WRANGLER_VARS,
  apps,
  collectConfigNames,
  collectWranglerVarsViolations,
  extractEnvNames,
  runWorkerEnvCheck,
  stripJsonc,
} from "./check-worker-env.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);

function readRepoJsonc(path) {
  return JSON.parse(stripJsonc(readFileSync(resolve(root, path), "utf8")));
}

describe("worker env check: Wrangler vars", () => {
  it("allows only the dev mailbox var, and only in the local API config", () => {
    expect(ALLOWED_WRANGLER_VARS).toEqual({
      "apps/api/wrangler.local.jsonc": ["LOCAL_MAILPIT_URL"],
    });
    expect(collectWranglerVarsViolations("apps/api/wrangler.local.jsonc", {
      vars: { LOCAL_MAILPIT_URL: "http://127.0.0.1:8025" },
    })).toEqual([]);
    expect(collectWranglerVarsViolations("apps/api/wrangler.jsonc", {})).toEqual([]);
    expect(collectWranglerVarsViolations("apps/storefront/wrangler.jsonc", { vars: {} })).toEqual([]);
  });

  it("fails closed on any other var and points at the dashboard Platform settings", () => {
    const [message] = collectWranglerVarsViolations("apps/api/wrangler.jsonc", {
      vars: {
        STOREFRONT_URL: "https://storefront.example.test",
        DATABASE_PROVIDER: "d1",
        LOCAL_MAILPIT_URL: "http://127.0.0.1:8025",
      },
    });

    expect(message).toContain("apps/api/wrangler.jsonc declares Wrangler vars DATABASE_PROVIDER, LOCAL_MAILPIT_URL, STOREFRONT_URL");
    expect(message).toContain("Settings -> System -> Platform");
    expect(message).toContain("/api/v1/platform");
    expect(message).toContain("wrangler secret put");
    expect(message).not.toContain("storefront.example.test");
  });

  it("rejects retired vars in the local API config while naming the allowed one", () => {
    const [message] = collectWranglerVarsViolations("apps/api/wrangler.local.jsonc", {
      vars: { LOCAL_MAILPIT_URL: "http://127.0.0.1:8025", PUBLIC_API_BASE_URL: "http://localhost:8787" },
    });

    expect(message).toContain("declares Wrangler vars PUBLIC_API_BASE_URL");
    expect(message).toContain("Only LOCAL_MAILPIT_URL may stay in this file.");
  });

  it("keeps every committed Wrangler config free of vars", () => {
    for (const app of apps) {
      for (const configPath of app.configs) {
        expect(
          collectWranglerVarsViolations(configPath, readRepoJsonc(configPath)),
          configPath,
        ).toEqual([]);
      }
    }
    expect(readRepoJsonc("apps/api/wrangler.local.jsonc").vars).toEqual({
      LOCAL_MAILPIT_URL: "http://127.0.0.1:8025",
    });
  });

  it("surfaces vars violations through the full check", () => {
    const { errors } = runWorkerEnvCheck({
      readTextImpl(path) {
        if (path === "apps/api/wrangler.jsonc") {
          return JSON.stringify({
            cache: { enabled: true },
            exports: { default: { cache: { enabled: false } }, PublicApi: { cache: { enabled: true } } },
            vars: { PURGE_URL: "https://storefront.example.test/api/purge-cache" },
          });
        }
        return readFileSync(resolve(root, path), "utf8");
      },
    });

    expect(errors.some((error) => error.includes("apps/api/wrangler.jsonc declares Wrangler vars PURGE_URL"))).toBe(true);
  });
});

describe("worker env check: allowlists", () => {
  it("installs exactly the master secret on every Worker and the AES key on API + admin", () => {
    const byName = Object.fromEntries(apps.map((app) => [app.name, app.extraEnv]));

    expect(byName.api).toContain("SCALIUS_SECRET");
    expect(byName.api).toContain("CREDENTIAL_ENCRYPTION_KEY");
    expect(byName["admin-v2"]).toContain("SCALIUS_SECRET");
    expect(byName["admin-v2"]).toContain("CREDENTIAL_ENCRYPTION_KEY");
    expect(byName.storefront).toEqual(["SCALIUS_SECRET"]);
  });

  it("never allowlists retired secrets, URL vars, or removed knobs", () => {
    const retired = [
      "FIREBASE_SERVICE_ACCOUNT_CRED_JSON",
      "PROJECT_CACHE_PREFIX",
      "FCM_SEND_CONCURRENCY",
      "PUBLIC_API_URL",
      "PUBLIC_STOREFRONT_URL",
      "DASHBOARD_URL",
      "CACHE_NAMESPACE",
      "TRUSTED_ORIGINS",
      "CREDENTIAL_CORS_ALLOWED_ORIGINS",
    ];
    for (const app of apps) {
      for (const name of retired) {
        expect(app.extraEnv, `${app.name} allowlists ${name}`).not.toContain(name);
      }
    }

    const storefrontOnlyRetired = ["API_TOKEN", "JWT_SECRET", "PURGE_TOKEN", "STOREFRONT_URL", "PUBLIC_API_BASE_URL", "CDN_DOMAIN_URL"];
    const storefront = apps.find((app) => app.name === "storefront");
    for (const name of storefrontOnlyRetired) {
      expect(storefront.extraEnv).not.toContain(name);
    }
  });

  it("matches the derived and resolved names the API env declares", () => {
    const api = apps.find((app) => app.name === "api");
    for (const name of [
      "BETTER_AUTH_SECRET",
      "JWT_SECRET",
      "API_TOKEN",
      "PURGE_TOKEN",
      "AGENT_TOKEN_PEPPER",
      "CUSTOMER_SESSION_HASH_KEY",
      "PLATFORM_CONFIG",
      "STOREFRONT_URL",
      "PUBLIC_API_BASE_URL",
      "BETTER_AUTH_URL",
      "R2_PUBLIC_URL",
      "CDN_DOMAIN_URL",
      "PURGE_URL",
      "CUSTOMER_AUTH_COOKIE_DOMAIN",
      "CORS_ALLOWED_ORIGINS",
      "LOCAL_MAILPIT_URL",
      "DATABASE_PROVIDER",
      "TURSO_DATABASE_URL",
      "TURSO_AUTH_TOKEN",
      "POSTGRES_DATABASE_URL",
      "HYPERDRIVE",
      "DATABASE_MIGRATION_FREEZE",
      "OAUTH_PROVIDER",
    ]) {
      expect(api.extraEnv).toContain(name);
    }
  });
});

describe("worker env check: parsing", () => {
  it("collects bindings and vars from a Wrangler config", () => {
    const names = collectConfigNames({
      vars: { LOCAL_MAILPIT_URL: "http://127.0.0.1:8025" },
      kv_namespaces: [{ binding: "CACHE", id: "x" }],
      durable_objects: { bindings: [{ name: "CHECKOUT_COORDINATOR", class_name: "CheckoutCoordinator" }] },
      send_email: [{ name: "EMAIL" }],
      ratelimits: [{ name: "SEARCH_RATE_LIMITER", namespace_id: "1" }],
      services: [{ binding: "API", service: "scalius-api" }],
    });

    expect([...names].sort()).toEqual([
      "API",
      "CACHE",
      "CHECKOUT_COORDINATOR",
      "EMAIL",
      "LOCAL_MAILPIT_URL",
      "SEARCH_RATE_LIMITER",
    ]);
  });

  it("reads Env names from interface, type alias, and generated base blocks", () => {
    expect([...extractEnvNames(`
      interface Env {
        CACHE: KVNamespace;
        readonly SCALIUS_SECRET?: string;
        [key: string]: unknown;
      }
      type Env = { DB?: D1Database };
      interface __BaseEnv_generated { BUCKET: R2Bucket }
    `)].sort()).toEqual(["BUCKET", "CACHE", "DB", "SCALIUS_SECRET"]);
  });
});
