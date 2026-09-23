import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_WRANGLER_VARS,
  apps,
  collectConfigNames,
  collectDuplicateEnvDeclarations,
  collectResourceBindingViolations,
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

describe("worker env check: per-store resource shape", () => {
  it("keeps every committed config to one KV, one bucket, one jobs queue, and two limiters", () => {
    for (const app of apps) {
      for (const configPath of app.configs) {
        expect(collectResourceBindingViolations(configPath, readRepoJsonc(configPath)), configPath).toEqual([]);
      }
    }
    const api = readRepoJsonc("apps/api/wrangler.jsonc");
    expect(api.queues.consumers.map((consumer) => consumer.queue)).toEqual(["jobs", "jobs-dlq"]);
    expect(api.queues.consumers[0].max_batch_timeout).toBeLessThanOrEqual(2);
    expect(readRepoJsonc("apps/storefront/wrangler.jsonc").kv_namespaces.map((kv) => kv.binding)).toEqual(["CACHE"]);
  });

  it("fails on a second namespace, bucket, queue, or limiter", () => {
    expect(collectResourceBindingViolations("apps/api/wrangler.jsonc", {
      kv_namespaces: [{ binding: "CACHE" }, { binding: "OAUTH_KV" }],
      r2_buckets: [{ binding: "BUCKET" }, { binding: "AGENT_ARTIFACTS" }],
      ratelimits: [{ name: "RL_STANDARD" }, { name: "SEARCH_RATE_LIMITER" }],
      queues: { producers: [{ binding: "JOBS_QUEUE" }, { binding: "AUTH_OTP_QUEUE" }] },
    })).toEqual([
      expect.stringContaining("kv_namespaces OAUTH_KV"),
      expect.stringContaining("r2_buckets AGENT_ARTIFACTS"),
      expect.stringContaining("ratelimits SEARCH_RATE_LIMITER"),
      expect.stringContaining("queue_producers AUTH_OTP_QUEUE"),
    ]);
  });
});

describe("worker env check: allowlists", () => {
  it("installs exactly the master secret on every Worker and the AES key on the API", () => {
    const byName = Object.fromEntries(apps.map((app) => [app.name, app.extraEnv]));

    expect(byName.api).toContain("SCALIUS_SECRET");
    expect(byName.api).toContain("CREDENTIAL_ENCRYPTION_KEY");
    expect(byName.storefront).toEqual(["SCALIUS_SECRET"]);
    expect(Object.keys(byName)).toEqual(["api", "storefront"]);
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
      "AGENT_TOKEN_PEPPER",
      "CUSTOMER_SESSION_HASH_KEY",
      "PLATFORM_CONFIG",
      "STOREFRONT_URL",
      "PUBLIC_API_BASE_URL",
      "BETTER_AUTH_URL",
      "R2_PUBLIC_URL",
      "CDN_DOMAIN_URL",
      "CUSTOMER_AUTH_COOKIE_DOMAIN",
      "CORS_ALLOWED_ORIGINS",
      "LOCAL_MAILPIT_URL",
      "DATABASE_PROVIDER",
      "TURSO_DATABASE_URL",
      "TURSO_AUTH_TOKEN",
      "POSTGRES_DATABASE_URL",
      "HYPERDRIVE",
      "DATABASE_MIGRATION_FREEZE",
    ]) {
      expect(api.extraEnv).toContain(name);
    }
  });
});

describe("worker env check: one Env declaration per Worker", () => {
  it("declares exactly one Env file per app", () => {
    for (const app of apps) {
      expect(app.envFiles, app.name).toHaveLength(1);
    }
    expect(apps.find((app) => app.name === "api").envFiles).toEqual([
      "apps/api/src/env.d.ts",
    ]);
  });

  it("fails closed when another declaration file in the Worker redeclares Env", () => {
    const [message] = collectDuplicateEnvDeclarations(apps.find((app) => app.name === "api"), {
      listDeclarationFilesImpl: () => [
        "apps/api/src/env.d.ts",
        "apps/api/src/hono-env.d.ts",
      ],
      readTextImpl: () => "declare global { type Env = { CACHE: KVNamespace } }",
    });

    expect(message).toContain("apps/api/src/hono-env.d.ts declares a second Env block");
    expect(message).toContain("apps/api/src/env.d.ts");
  });

  it("passes when only the declared Env file declares Env", () => {
    expect(collectDuplicateEnvDeclarations(apps.find((app) => app.name === "api"), {
      listDeclarationFilesImpl: () => [
        "apps/api/src/env.d.ts",
        "apps/api/src/hono-env.d.ts",
      ],
      readTextImpl: () => "declare module \"hono\" { interface ContextVariableMap { env: Env } }",
    })).toEqual([]);
  });

  it("reports no duplicate Env blocks anywhere in the committed Workers", () => {
    for (const app of apps) {
      expect(collectDuplicateEnvDeclarations(app), app.name).toEqual([]);
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
      ratelimits: [{ name: "RL_STANDARD", namespace_id: "1" }],
      services: [{ binding: "BACKEND_API", service: "scalius-api" }],
      assets: { directory: "../admin-v2/dist", binding: "ASSETS" },
    });

    expect([...names].sort()).toEqual([
      "ASSETS",
      "BACKEND_API",
      "CACHE",
      "CHECKOUT_COORDINATOR",
      "EMAIL",
      "LOCAL_MAILPIT_URL",
      "RL_STANDARD",
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
