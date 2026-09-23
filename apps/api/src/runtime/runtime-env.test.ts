import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RUNTIME_SECRET_PURPOSES,
  deriveRuntimeSecret,
} from "@scalius/shared/runtime-secrets";
const PLATFORM_CONFIG_CACHE_KEY = "settings:platform";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock("@scalius/database/client", () => ({
  getDb: mocks.getDb,
}));

import { composeApiRuntimeEnv, hasMasterSecret } from "./runtime-env";

const MASTER_SECRET = "runtime-env-test-master-secret-with-more-than-32-chars";

const PRODUCTION_CONFIG = {
  storefrontUrl: "https://shop.example.com",
  apiUrl: "https://api.example.com",
  dashboardUrl: "https://dashboard.example.com",
  mediaUrl: "https://cdn.example.com",
  customerAuthCookieDomain: "example.com",
  corsAllowedOrigins: ["https://mobile.example.com", "https://kiosk.example.com"],
  setupTokenRequired: false,
  identityHandoff: {
    enabled: false,
    issuer: "",
    audience: "",
    jwksUrl: "",
    localLoginDisabled: false,
  },
};

/** Minimal drizzle-shaped database: awaiting the query reads the platform document. */
function createDb(options: {
  document?: Record<string, unknown>;
  fail?: boolean;
} = {}) {
  const where = vi.fn(() => ({
    then: (resolve: (rows: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
      (options.fail
        ? Promise.reject(new Error("D1 unavailable"))
        : Promise.resolve(options.document
          ? [{ category: "platform", value: JSON.stringify(options.document), revision: 1 }]
          : [])).then(resolve, reject),
  }));
  return {
    where,
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where })),
      })),
    },
  };
}

function createKv(stored: string | null = null) {
  return {
    get: vi.fn(async () => stored),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
}

function createEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    SCALIUS_SECRET: MASTER_SECRET,
    CREDENTIAL_ENCRYPTION_KEY: "credential-key",
    CACHE: createKv(),
    DB: { id: "d1" },
    ...overrides,
  } as unknown as Env;
}

describe("composeApiRuntimeEnv", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mocks.getDb.mockReset();
  });

  it("derives every runtime secret from SCALIUS_SECRET and passes bindings through by reference", async () => {
    const cache = createKv(JSON.stringify(PRODUCTION_CONFIG));
    const env = createEnv({ CACHE: cache });

    const composed = await composeApiRuntimeEnv(env, {
      requestUrl: "https://api.example.com/api/v1/products",
    });

    for (const [name, purpose] of Object.entries(RUNTIME_SECRET_PURPOSES)) {
      expect(composed[name], name).toBe(await deriveRuntimeSecret(MASTER_SECRET, purpose));
    }
    expect(composed.JWT_SECRET).not.toBe(composed.BETTER_AUTH_SECRET);
    expect(composed.API_TOKEN).not.toBe(composed.JWT_SECRET);
    expect(composed.CREDENTIAL_ENCRYPTION_KEY).toBe("credential-key");
    expect(composed.SCALIUS_SECRET).toBe(MASTER_SECRET);
    expect(composed.CACHE).toBe(cache);
    expect(composed.DB).toBe(env.DB);
    // The input env is never mutated.
    expect(env.JWT_SECRET).toBeUndefined();
    expect(env.PLATFORM_CONFIG).toBeUndefined();
  });

  it("does not synthesize secrets when the master secret is missing", async () => {
    const env = createEnv({
      SCALIUS_SECRET: "too-short",
      CACHE: createKv(JSON.stringify(PRODUCTION_CONFIG)),
    });

    expect(hasMasterSecret(env)).toBe(false);
    const composed = await composeApiRuntimeEnv(env);

    for (const name of Object.keys(RUNTIME_SECRET_PURPOSES)) {
      expect(composed[name], name).toBeUndefined();
    }
    expect(composed.PLATFORM_CONFIG).toEqual(PRODUCTION_CONFIG);
  });

  it("reads the platform configuration from KV without opening the database", async () => {
    const cache = createKv(JSON.stringify(PRODUCTION_CONFIG));
    const composed = await composeApiRuntimeEnv(createEnv({ CACHE: cache }));

    expect(cache.get).toHaveBeenCalledWith(PLATFORM_CONFIG_CACHE_KEY, { cacheTtl: 60 });
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
    expect(composed.PLATFORM_CONFIG).toEqual(PRODUCTION_CONFIG);
    expect(composed).toMatchObject({
      STOREFRONT_URL: "https://shop.example.com",
      PUBLIC_API_BASE_URL: "https://api.example.com",
      BETTER_AUTH_URL: "https://dashboard.example.com",
      R2_PUBLIC_URL: "https://cdn.example.com",
      CDN_DOMAIN_URL: "cdn.example.com",
      CUSTOMER_AUTH_COOKIE_DOMAIN: "example.com",
      CORS_ALLOWED_ORIGINS: "https://mobile.example.com,https://kiosk.example.com",
    });
  });

  it("reads the database on a KV miss and caches the resolved configuration", async () => {
    const cache = createKv(null);
    const { db, where } = createDb({ document: PRODUCTION_CONFIG });
    mocks.getDb.mockReturnValue(db);
    const env = createEnv({ CACHE: cache });

    const composed = await composeApiRuntimeEnv(env);

    expect(mocks.getDb).toHaveBeenCalledWith(env);
    expect(where).toHaveBeenCalledTimes(1);
    expect(cache.put).toHaveBeenCalledWith(
      PLATFORM_CONFIG_CACHE_KEY,
      JSON.stringify(PRODUCTION_CONFIG),
    );
    expect(composed.PLATFORM_CONFIG).toEqual(PRODUCTION_CONFIG);
    expect(composed.STOREFRONT_URL).toBe("https://shop.example.com");
  });

  it("fills unset origins with the fixed local development ports when the request arrives on loopback", async () => {
    mocks.getDb.mockReturnValue(createDb({ document: { storefrontUrl: "/" } }).db);

    const composed = await composeApiRuntimeEnv(createEnv({ CACHE: createKv(null) }), {
      requestUrl: "http://localhost:8787/api/v1/products",
    });

    expect(composed).toMatchObject({
      STOREFRONT_URL: "http://localhost:4322",
      PUBLIC_API_BASE_URL: "http://localhost:8787",
      BETTER_AUTH_URL: "http://localhost:4323",
      R2_PUBLIC_URL: "http://localhost:8787/api/v1/media",
      CDN_DOMAIN_URL: "localhost:8787",
    });
    expect(composed.PLATFORM_CONFIG).toMatchObject({
      storefrontUrl: "http://localhost:4322",
      apiUrl: "http://localhost:8787",
      dashboardUrl: "http://localhost:4323",
      mediaUrl: "http://localhost:8787/api/v1/media",
    });
  });

  it("never guesses production origins from a non-loopback request", async () => {
    mocks.getDb.mockReturnValue(createDb().db);

    const composed = await composeApiRuntimeEnv(createEnv({ CACHE: createKv(null) }), {
      requestUrl: "https://api.example.com/api/v1/products",
    });

    expect(composed.STOREFRONT_URL).toBeUndefined();
    expect(composed.BETTER_AUTH_URL).toBeUndefined();
    expect(composed.R2_PUBLIC_URL).toBeUndefined();
    expect(composed.CDN_DOMAIN_URL).toBeUndefined();
    expect(composed.CUSTOMER_AUTH_COOKIE_DOMAIN).toBeUndefined();
    expect(composed.CORS_ALLOWED_ORIGINS).toBeUndefined();
  });

  describe("apiUrl request-origin fallback", () => {
    const stored = { ...PRODUCTION_CONFIG, apiUrl: "" };

    it("uses the public request origin when no API URL is stored", async () => {
      const composed = await composeApiRuntimeEnv(
        createEnv({ CACHE: createKv(JSON.stringify(stored)) }),
        { requestUrl: "https://api.example.com/api/v1/platform?x=1" },
      );

      expect(composed.PUBLIC_API_BASE_URL).toBe("https://api.example.com");
      expect(composed.PLATFORM_CONFIG?.apiUrl).toBe("https://api.example.com");
    });

    it("ignores the service-binding origin https://api.internal", async () => {
      const composed = await composeApiRuntimeEnv(
        createEnv({ CACHE: createKv(JSON.stringify(stored)) }),
        { requestUrl: "https://api.internal/api/v1/platform" },
      );

      expect(composed.PUBLIC_API_BASE_URL).toBeUndefined();
      expect(composed.PLATFORM_CONFIG?.apiUrl).toBe("");
    });

    it("leaves the API URL unset for queue and cron invocations without a request", async () => {
      const composed = await composeApiRuntimeEnv(
        createEnv({ CACHE: createKv(JSON.stringify(stored)) }),
      );

      expect(composed.PUBLIC_API_BASE_URL).toBeUndefined();
    });

    it("prefers the stored API URL over the request origin", async () => {
      const composed = await composeApiRuntimeEnv(
        createEnv({ CACHE: createKv(JSON.stringify(PRODUCTION_CONFIG)) }),
        { requestUrl: "https://edge-alias.example.net/api/v1/products" },
      );

      expect(composed.PUBLIC_API_BASE_URL).toBe("https://api.example.com");
    });
  });

  it("joins the extra CORS origins into a comma list and drops invalid entries", async () => {
    const composed = await composeApiRuntimeEnv(
      createEnv({
        CACHE: createKv(JSON.stringify({
          ...PRODUCTION_CONFIG,
          corsAllowedOrigins: [
            "https://mobile.example.com",
            "http://insecure.example.com",
            "https://kiosk.example.com/path",
            "https://kiosk.example.com",
          ],
        })),
      }),
    );

    expect(composed.CORS_ALLOWED_ORIGINS).toBe("https://mobile.example.com,https://kiosk.example.com");
    expect(composed.PLATFORM_CONFIG?.corsAllowedOrigins).toEqual([
      "https://mobile.example.com",
      "https://kiosk.example.com",
    ]);

    const none = await composeApiRuntimeEnv(
      createEnv({ CACHE: createKv(JSON.stringify({ ...PRODUCTION_CONFIG, corsAllowedOrigins: [] })) }),
    );
    expect(none.CORS_ALLOWED_ORIGINS).toBeUndefined();
  });

  it("fails closed to an empty platform configuration when the database read fails", async () => {
    mocks.getDb.mockReturnValue(createDb({ fail: true }).db);
    const cache = createKv(null);

    const composed = await composeApiRuntimeEnv(createEnv({ CACHE: cache }), {
      requestUrl: "https://api.example.com/api/v1/products",
    });

    expect(composed.JWT_SECRET).toEqual(expect.any(String));
    expect(composed.PLATFORM_CONFIG).toMatchObject({
      storefrontUrl: "",
      dashboardUrl: "",
      mediaUrl: "",
      corsAllowedOrigins: [],
    });
    expect(composed.STOREFRONT_URL).toBeUndefined();
    expect(cache.put).not.toHaveBeenCalled();
  });
});
