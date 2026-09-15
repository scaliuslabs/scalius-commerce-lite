import { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ValidationError } from "@scalius/core/errors";
import {
  EMPTY_PLATFORM_CONFIG,
  PLATFORM_CORS_ORIGINS_MAX_COUNT,
} from "@scalius/shared/platform-config";

import {
  PLATFORM_CONFIG_CACHE_KEY,
  PLATFORM_SETTINGS_CATEGORY,
  cachePlatformConfig,
  getConfiguredStorefrontUrl,
  getPlatformSettings,
  invalidatePlatformConfigCache,
  readCachedPlatformConfig,
  resolvePlatformConfig,
  savePlatformSettings,
} from "./platform-settings.service";

const PRODUCTION_PATCH = {
  storefrontUrl: "https://shop.example.com",
  apiUrl: "https://api.example.com",
  dashboardUrl: "https://dashboard.example.com",
  mediaUrl: "https://cdn.example.com",
  customerAuthCookieDomain: "example.com",
  corsAllowedOrigins: ["https://mobile.example.com"],
};

function createSchema(sqlite: DatabaseSync): void {
  sqlite.exec(`
    CREATE TABLE settings (
      id TEXT PRIMARY KEY NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'string',
      category TEXT NOT NULL DEFAULT 'general',
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at INTEGER,
      UNIQUE(key, category)
    );
    CREATE TABLE site_settings (
      id TEXT PRIMARY KEY NOT NULL,
      singleton_key TEXT NOT NULL DEFAULT 'default' UNIQUE,
      logo TEXT,
      favicon TEXT,
      site_name TEXT NOT NULL,
      site_description TEXT,
      header_config TEXT NOT NULL,
      header_config_revision INTEGER NOT NULL DEFAULT 1 CHECK (header_config_revision >= 1),
      footer_config TEXT NOT NULL,
      footer_config_revision INTEGER NOT NULL DEFAULT 1 CHECK (footer_config_revision >= 1),
      social_links TEXT,
      contact_info TEXT,
      site_title TEXT,
      homepage_title TEXT,
      homepage_meta_description TEXT,
      homepage_config TEXT NOT NULL DEFAULT '{}',
      homepage_config_revision INTEGER NOT NULL DEFAULT 1 CHECK (homepage_config_revision >= 1),
      robots_txt TEXT,
      storefront_url TEXT DEFAULT '/',
      auth_verification_method TEXT NOT NULL DEFAULT 'email',
      guest_checkout_enabled INTEGER NOT NULL DEFAULT 1,
      checkout_mode TEXT NOT NULL DEFAULT 'all',
      partial_payment_enabled INTEGER NOT NULL DEFAULT 0,
      partial_payment_amount REAL NOT NULL DEFAULT 0,
      checkout_flow_revision INTEGER NOT NULL DEFAULT 1,
      whatsapp_access_token TEXT,
      whatsapp_phone_number_id TEXT,
      whatsapp_template_name TEXT DEFAULT 'auth_otp',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

function createDatabase(sqlite: DatabaseSync): Database {
  return drizzle(async (query, params, method) => {
    const statement = sqlite.prepare(query);
    statement.setReturnArrays(true);
    if (method === "run") {
      statement.run(...params);
      return { rows: [] };
    }
    if (method === "get") {
      return { rows: statement.get(...params) as unknown as unknown[] };
    }
    return { rows: statement.all(...params) as unknown as unknown[][] };
  }) as unknown as Database;
}

function createKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

function storedPlatformRows(sqlite: DatabaseSync): Record<string, string> {
  const rows = sqlite
    .prepare("SELECT key, value FROM settings WHERE category = ? ORDER BY key")
    .all(PLATFORM_SETTINGS_CATEGORY) as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

describe("platform settings storage", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    createSchema(sqlite);
    db = createDatabase(sqlite);
  });

  afterEach(() => {
    sqlite.close();
    vi.restoreAllMocks();
  });

  it("returns the empty configuration for a fresh database", async () => {
    await expect(getPlatformSettings(db)).resolves.toEqual({ ...EMPTY_PLATFORM_CONFIG });
    await expect(getConfiguredStorefrontUrl(db)).resolves.toBe("");
  });

  it("assembles the pre-document per-key rows and writes the document back", async () => {
    const insert = sqlite.prepare(
      "INSERT INTO settings (id, key, value, type, category) VALUES (?, ?, ?, 'string', ?)",
    );
    insert.run("s1", "api_url", "https://api.example.com", PLATFORM_SETTINGS_CATEGORY);
    insert.run("s2", "dashboard_url", "https://dashboard.example.com", PLATFORM_SETTINGS_CATEGORY);
    insert.run("s3", "media_url", "https://cdn.example.com", PLATFORM_SETTINGS_CATEGORY);
    insert.run("s4", "customer_auth_cookie_domain", "example.com", PLATFORM_SETTINGS_CATEGORY);
    insert.run(
      "s5",
      "cors_allowed_origins",
      JSON.stringify(["https://mobile.example.com"]),
      PLATFORM_SETTINGS_CATEGORY,
    );

    await expect(getPlatformSettings(db)).resolves.toEqual({
      ...EMPTY_PLATFORM_CONFIG,
      apiUrl: "https://api.example.com",
      dashboardUrl: "https://dashboard.example.com",
      mediaUrl: "https://cdn.example.com",
      customerAuthCookieDomain: "example.com",
      corsAllowedOrigins: ["https://mobile.example.com"],
    });

    // The document row is written back; the legacy rows stay untouched so no
    // D1 migration is required and a rollback keeps reading production data.
    expect(storedPlatformRows(sqlite).config).toBe(JSON.stringify({
      apiUrl: "https://api.example.com",
      dashboardUrl: "https://dashboard.example.com",
      mediaUrl: "https://cdn.example.com",
      customerAuthCookieDomain: "example.com",
      corsAllowedOrigins: ["https://mobile.example.com"],
    }));

    // A later read comes from the document, not the legacy rows.
    sqlite.exec("UPDATE settings SET value = 'https://stale.example.com' WHERE key = 'api_url'");
    await expect(getPlatformSettings(db)).resolves.toMatchObject({
      apiUrl: "https://api.example.com",
    });
  });

  it("round-trips every field through save and get", async () => {
    const saved = await savePlatformSettings(db, {
      ...PRODUCTION_PATCH,
      storefrontUrl: "https://Shop.Example.com/",
      customerAuthCookieDomain: ".Example.com",
      corsAllowedOrigins: "https://mobile.example.com, https://mobile.example.com/ https://kiosk.example.com",
    });

    expect(saved).toEqual({
      ...PRODUCTION_PATCH,
      corsAllowedOrigins: ["https://mobile.example.com", "https://kiosk.example.com"],
    });
    await expect(getPlatformSettings(db)).resolves.toEqual(saved);
    await expect(getConfiguredStorefrontUrl(db)).resolves.toBe("https://shop.example.com");
    expect(storedPlatformRows(sqlite)).toEqual({
      config: JSON.stringify({
        apiUrl: "https://api.example.com",
        dashboardUrl: "https://dashboard.example.com",
        mediaUrl: "https://cdn.example.com",
        customerAuthCookieDomain: "example.com",
        corsAllowedOrigins: ["https://mobile.example.com", "https://kiosk.example.com"],
      }),
    });
    expect(
      sqlite.prepare("SELECT storefront_url FROM site_settings").get(),
    ).toEqual({ storefront_url: "https://shop.example.com" });
  });

  it("applies partial patches without touching other stored values", async () => {
    await savePlatformSettings(db, PRODUCTION_PATCH);

    const updated = await savePlatformSettings(db, {
      mediaUrl: "http://localhost:8787/api/v1/media",
    });

    expect(updated).toEqual({
      ...PRODUCTION_PATCH,
      mediaUrl: "http://localhost:8787/api/v1/media",
    });
  });

  it("clears optional values with an empty string", async () => {
    await savePlatformSettings(db, PRODUCTION_PATCH);

    const cleared = await savePlatformSettings(db, {
      apiUrl: "",
      dashboardUrl: "  ",
      mediaUrl: "",
      customerAuthCookieDomain: "",
      corsAllowedOrigins: [],
    });

    expect(cleared).toEqual({
      ...EMPTY_PLATFORM_CONFIG,
      storefrontUrl: "https://shop.example.com",
    });
    expect(storedPlatformRows(sqlite)).toEqual({
      config: JSON.stringify({
        apiUrl: "",
        dashboardUrl: "",
        mediaUrl: "",
        customerAuthCookieDomain: "",
        corsAllowedOrigins: [],
      }),
    });
  });

  it("rejects an empty storefront URL because the store origin is required", async () => {
    await savePlatformSettings(db, PRODUCTION_PATCH);

    await expect(savePlatformSettings(db, { storefrontUrl: "" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(getConfiguredStorefrontUrl(db)).resolves.toBe("https://shop.example.com");
  });

  it.each([
    ["apiUrl", "http://api.example.com", "API URL must be an HTTPS origin"],
    ["apiUrl", "https://api.example.com/v1", "API URL must be an HTTPS origin"],
    ["dashboardUrl", "https://user:pw@dashboard.example.com", "Dashboard URL must be an HTTPS origin"],
    ["mediaUrl", "http://cdn.example.com/media", "Media URL must be an HTTPS base URL"],
    ["mediaUrl", "https://cdn.example.com/media?x=1", "Media URL must be an HTTPS base URL"],
    ["customerAuthCookieDomain", "https://example.com", "Customer cookie domain must be a bare hostname"],
    ["customerAuthCookieDomain", "*.example.com", "Customer cookie domain must be a bare hostname"],
    ["storefrontUrl", "http://shop.example.com", "Enter the HTTPS origin of the public store"],
    ["storefrontUrl", "https://shop.example.com/store", "Enter the HTTPS origin of the public store"],
  ] as const)("rejects invalid %s %s without writing", async (key, value, message) => {
    await expect(savePlatformSettings(db, { [key]: value })).rejects.toThrow(message);
    await expect(savePlatformSettings(db, { [key]: value })).rejects.toBeInstanceOf(ValidationError);
    expect(storedPlatformRows(sqlite)).toEqual({});
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM site_settings").get()).toEqual({ count: 0 });
  });

  it("rejects invalid extra CORS origins and wildcards", async () => {
    for (const value of [
      ["https://mobile.example.com", "http://insecure.example.com"],
      "https://mobile.example.com, https://*.wild.example.com",
      ["https://mobile.example.com/app"],
      ["mobile.example.com"],
    ]) {
      await expect(savePlatformSettings(db, { corsAllowedOrigins: value })).rejects.toThrow(
        "Every extra CORS origin must be an HTTPS origin without a path.",
      );
    }
    expect(storedPlatformRows(sqlite)).toEqual({});
  });

  it("rejects more than the maximum number of distinct extra CORS origins", async () => {
    const tooMany = Array.from(
      { length: PLATFORM_CORS_ORIGINS_MAX_COUNT + 1 },
      (_, index) => `https://origin-${index}.example.com`,
    );
    await expect(savePlatformSettings(db, { corsAllowedOrigins: tooMany })).rejects.toThrow(
      `At most ${PLATFORM_CORS_ORIGINS_MAX_COUNT} extra CORS origins can be configured.`,
    );

    const duplicatesAreFine = [...tooMany.slice(0, PLATFORM_CORS_ORIGINS_MAX_COUNT), tooMany[0]!];
    const saved = await savePlatformSettings(db, { corsAllowedOrigins: duplicatesAreFine });
    expect(saved.corsAllowedOrigins).toEqual(tooMany.slice(0, PLATFORM_CORS_ORIGINS_MAX_COUNT));
  });

  it("validates every field in a patch before writing any of them", async () => {
    await expect(savePlatformSettings(db, {
      storefrontUrl: "https://shop.example.com",
      apiUrl: "https://api.example.com",
      dashboardUrl: "not a url",
    })).rejects.toBeInstanceOf(ValidationError);

    expect(storedPlatformRows(sqlite)).toEqual({});
    await expect(getConfiguredStorefrontUrl(db)).resolves.toBe("");
  });

  it("normalizes legacy or malformed stored rows instead of trusting them", async () => {
    sqlite.exec(`
      INSERT INTO site_settings (id, site_name, header_config, footer_config, storefront_url, created_at, updated_at)
      VALUES ('settings_1', 'Store', '{}', '{}', '/', 0, 0);
      INSERT INTO settings (id, key, value, type, category) VALUES
        ('s1', 'api_url', 'http://api.example.com', 'string', 'platform'),
        ('s2', 'dashboard_url', 'https://Dashboard.Example.com/', 'string', 'platform'),
        ('s3', 'media_url', 'https://cdn.example.com/assets/', 'string', 'platform'),
        ('s4', 'customer_auth_cookie_domain', '.Example.com', 'string', 'platform'),
        ('s5', 'cors_allowed_origins', 'https://a.example.com https://a.example.com,https://*.b.example.com', 'string', 'platform'),
        ('s6', 'api_url', 'https://other-category.example.com', 'string', 'general');
    `);

    await expect(getPlatformSettings(db)).resolves.toEqual({
      storefrontUrl: "",
      apiUrl: "",
      dashboardUrl: "https://dashboard.example.com",
      mediaUrl: "https://cdn.example.com/assets",
      customerAuthCookieDomain: "example.com",
      corsAllowedOrigins: ["https://a.example.com"],
    });
  });
});

describe("platform config KV cache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the versioned cache key without an expiring TTL", async () => {
    const kv = createKv();
    const config = { ...EMPTY_PLATFORM_CONFIG, ...PRODUCTION_PATCH };

    await cachePlatformConfig(kv, config);

    expect(PLATFORM_CONFIG_CACHE_KEY).toBe("platform:config:v1");
    // Every save deletes the key; an expiring entry would re-write KV on every
    // Worker every few minutes for a value that only changes on save.
    expect(kv.put).toHaveBeenCalledWith(
      PLATFORM_CONFIG_CACHE_KEY,
      JSON.stringify(config),
    );
    await expect(readCachedPlatformConfig(kv)).resolves.toEqual(config);
    expect(kv.get).toHaveBeenCalledWith(PLATFORM_CONFIG_CACHE_KEY, { cacheTtl: 60 });
  });

  it("invalidates the cached configuration", async () => {
    const kv = createKv({ [PLATFORM_CONFIG_CACHE_KEY]: JSON.stringify(PRODUCTION_PATCH) });

    await invalidatePlatformConfigCache(kv);

    expect(kv.delete).toHaveBeenCalledWith(PLATFORM_CONFIG_CACHE_KEY);
    await expect(readCachedPlatformConfig(kv)).resolves.toBeNull();
  });

  it("returns null for a missing binding, a cache miss, or an unreadable entry", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(readCachedPlatformConfig(null)).resolves.toBeNull();
    await expect(readCachedPlatformConfig(undefined)).resolves.toBeNull();
    await expect(readCachedPlatformConfig(createKv())).resolves.toBeNull();
    await expect(
      readCachedPlatformConfig(createKv({ [PLATFORM_CONFIG_CACHE_KEY]: "{not json" })),
    ).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("is not decodable");
  });

  it("normalizes cached values so a stale or tampered entry cannot widen the config", async () => {
    const kv = createKv({
      [PLATFORM_CONFIG_CACHE_KEY]: JSON.stringify({
        storefrontUrl: "http://shop.example.com",
        apiUrl: "https://api.example.com/v1",
        dashboardUrl: "https://dashboard.example.com",
        corsAllowedOrigins: ["https://*.evil.example.com", "https://ok.example.com"],
        extra: "ignored",
      }),
    });

    await expect(readCachedPlatformConfig(kv)).resolves.toEqual({
      ...EMPTY_PLATFORM_CONFIG,
      dashboardUrl: "https://dashboard.example.com",
      corsAllowedOrigins: ["https://ok.example.com"],
    });
  });

  it("tolerates KV binding failures without throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = {
      get: vi.fn(async () => {
        throw new Error("kv get down");
      }),
      put: vi.fn(async () => {
        throw new Error("kv put down");
      }),
      delete: vi.fn(async () => {
        throw new Error("kv delete down");
      }),
    };

    await expect(readCachedPlatformConfig(broken)).resolves.toBeNull();
    await expect(
      cachePlatformConfig(broken, { ...EMPTY_PLATFORM_CONFIG, ...PRODUCTION_PATCH }),
    ).resolves.toBeUndefined();
    await expect(invalidatePlatformConfigCache(broken)).resolves.toBeUndefined();
    await expect(cachePlatformConfig(null, { ...EMPTY_PLATFORM_CONFIG })).resolves.toBeUndefined();
    await expect(invalidatePlatformConfigCache(undefined)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(3);
  });
});

describe("resolvePlatformConfig", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    createSchema(sqlite);
    db = createDatabase(sqlite);
  });

  afterEach(() => {
    sqlite.close();
    vi.restoreAllMocks();
  });

  it("serves a KV hit without opening the database", async () => {
    const kv = createKv({
      [PLATFORM_CONFIG_CACHE_KEY]: JSON.stringify({ ...EMPTY_PLATFORM_CONFIG, ...PRODUCTION_PATCH }),
    });
    const getDb = vi.fn(() => db);

    await expect(resolvePlatformConfig({ getDb, kv })).resolves.toEqual({
      ...EMPTY_PLATFORM_CONFIG,
      ...PRODUCTION_PATCH,
    });
    expect(getDb).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("reads the database on a cache miss and fills the cache", async () => {
    await savePlatformSettings(db, PRODUCTION_PATCH);
    const kv = createKv();
    const getDb = vi.fn(() => db);

    const resolved = await resolvePlatformConfig({ getDb, kv });

    expect(resolved).toEqual({ ...EMPTY_PLATFORM_CONFIG, ...PRODUCTION_PATCH });
    expect(getDb).toHaveBeenCalledTimes(1);
    expect(kv.put).toHaveBeenCalledWith(
      PLATFORM_CONFIG_CACHE_KEY,
      JSON.stringify(resolved),
    );
    expect(JSON.parse(kv.store.get(PLATFORM_CONFIG_CACHE_KEY) ?? "null")).toEqual(resolved);
  });

  it("works without a KV binding", async () => {
    await savePlatformSettings(db, PRODUCTION_PATCH);

    await expect(resolvePlatformConfig({ getDb: () => db })).resolves.toEqual({
      ...EMPTY_PLATFORM_CONFIG,
      ...PRODUCTION_PATCH,
    });
    await expect(resolvePlatformConfig({ getDb: () => db, kv: null })).resolves.toEqual({
      ...EMPTY_PLATFORM_CONFIG,
      ...PRODUCTION_PATCH,
    });
  });

  it("fails closed to the empty configuration when the database read fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const kv = createKv();
    sqlite.exec("DROP TABLE settings");

    const resolved = await resolvePlatformConfig({ getDb: () => db, kv });

    expect(resolved).toEqual({ ...EMPTY_PLATFORM_CONFIG });
    expect(resolved).not.toBe(EMPTY_PLATFORM_CONFIG);
    expect(resolved.corsAllowedOrigins).not.toBe(EMPTY_PLATFORM_CONFIG.corsAllowedOrigins);
    expect(kv.put).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain("DB read failed");
  });

  it("fails closed when the database cannot even be opened", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const kv = createKv();

    const resolved = await resolvePlatformConfig({
      getDb: () => {
        throw new Error("DATABASE_PROVIDER misconfigured");
      },
      kv,
    });

    expect(resolved).toEqual({ ...EMPTY_PLATFORM_CONFIG });
    expect(kv.put).not.toHaveBeenCalled();
  });
});
