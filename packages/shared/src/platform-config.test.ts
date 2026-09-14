import { describe, expect, it } from "vitest";

import { isReady } from "./readiness";

import {
  EMPTY_PLATFORM_CONFIG,
  INTERNAL_SERVICE_ORIGIN,
  LOCAL_DEVELOPMENT_PLATFORM_CONFIG,
  PLATFORM_CONFIG_PUBLIC_PATH,
  PLATFORM_CORS_ORIGINS_MAX_COUNT,
  PLATFORM_URL_KEYS,
  PLATFORM_URL_MAX_LENGTH,
  getPlatformConfigReadiness,
  PLATFORM_READINESS_FIX,
  isInternalServiceUrl,
  isLoopbackUrl,
  mediaHostFromUrl,
  normalizeCookieDomain,
  normalizeCorsOrigins,
  normalizeMediaBaseUrl,
  normalizePlatformConfig,
  normalizePlatformOriginUrl,
  publicRequestOrigin,
  storefrontPurgeUrl,
  withLocalDevelopmentDefaults,
  type PlatformConfig,
} from "./platform-config";

const PRODUCTION_CONFIG: PlatformConfig = {
  storefrontUrl: "https://shop.example.com",
  apiUrl: "https://api.example.com",
  dashboardUrl: "https://dashboard.example.com",
  mediaUrl: "https://cdn.example.com",
  customerAuthCookieDomain: "example.com",
  corsAllowedOrigins: ["https://mobile.example.com"],
};

describe("platform config constants", () => {
  it("exposes the fixed contract shared by every Worker", () => {
    expect(INTERNAL_SERVICE_ORIGIN).toBe("https://api.internal");
    expect(PLATFORM_CONFIG_PUBLIC_PATH).toBe("/api/v1/platform");
    expect(PLATFORM_URL_KEYS).toEqual(["storefrontUrl", "apiUrl", "dashboardUrl", "mediaUrl"]);
    expect(LOCAL_DEVELOPMENT_PLATFORM_CONFIG).toEqual({
      storefrontUrl: "http://localhost:4322",
      apiUrl: "http://localhost:8787",
      dashboardUrl: "http://localhost:4323",
      mediaUrl: "http://localhost:8787/api/v1/media",
      customerAuthCookieDomain: "",
      corsAllowedOrigins: [],
    });
    expect(EMPTY_PLATFORM_CONFIG).toEqual({
      storefrontUrl: "",
      apiUrl: "",
      dashboardUrl: "",
      mediaUrl: "",
      customerAuthCookieDomain: "",
      corsAllowedOrigins: [],
    });
    expect(Object.isFrozen(EMPTY_PLATFORM_CONFIG)).toBe(true);
    expect(Object.isFrozen(LOCAL_DEVELOPMENT_PLATFORM_CONFIG)).toBe(true);
  });
});

describe("normalizePlatformOriginUrl", () => {
  it("returns the bare origin for HTTPS values and trims whitespace", () => {
    expect(normalizePlatformOriginUrl("  https://Shop.Example.com  ")).toBe("https://shop.example.com");
    expect(normalizePlatformOriginUrl("https://shop.example.com/")).toBe("https://shop.example.com");
    expect(normalizePlatformOriginUrl("https://shop.example.com:8443")).toBe("https://shop.example.com:8443");
  });

  it("allows plain HTTP only for loopback hosts", () => {
    expect(normalizePlatformOriginUrl("http://localhost:4322")).toBe("http://localhost:4322");
    expect(normalizePlatformOriginUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(normalizePlatformOriginUrl("http://[::1]:8787")).toBe("http://[::1]:8787");
    expect(normalizePlatformOriginUrl("http://shop.example.com")).toBe("");
    expect(normalizePlatformOriginUrl("http://localhost.evil.test")).toBe("");
    expect(normalizePlatformOriginUrl("http://127.0.0.10")).toBe("");
  });

  it("rejects paths, queries, fragments, credentials, other schemes, and junk", () => {
    expect(normalizePlatformOriginUrl("https://shop.example.com/store")).toBe("");
    expect(normalizePlatformOriginUrl("https://shop.example.com/?ref=1")).toBe("");
    expect(normalizePlatformOriginUrl("https://shop.example.com/#top")).toBe("");
    expect(normalizePlatformOriginUrl("https://user:pass@shop.example.com")).toBe("");
    expect(normalizePlatformOriginUrl("ftp://shop.example.com")).toBe("");
    expect(normalizePlatformOriginUrl("javascript:alert(1)")).toBe("");
    expect(normalizePlatformOriginUrl("shop.example.com")).toBe("");
    expect(normalizePlatformOriginUrl("")).toBe("");
    expect(normalizePlatformOriginUrl("   ")).toBe("");
    expect(normalizePlatformOriginUrl(undefined)).toBe("");
    expect(normalizePlatformOriginUrl(null)).toBe("");
    expect(normalizePlatformOriginUrl(42)).toBe("");
    expect(normalizePlatformOriginUrl({ href: "https://shop.example.com" })).toBe("");
  });

  it("rejects values longer than the maximum URL length", () => {
    const longHost = `https://${"a".repeat(PLATFORM_URL_MAX_LENGTH)}.example.com`;
    expect(normalizePlatformOriginUrl(longHost)).toBe("");
  });
});

describe("normalizeMediaBaseUrl", () => {
  it("keeps a media path so local development can serve from the API", () => {
    expect(normalizeMediaBaseUrl("http://localhost:8787/api/v1/media")).toBe(
      "http://localhost:8787/api/v1/media",
    );
    expect(normalizeMediaBaseUrl("https://cdn.example.com/assets/")).toBe(
      "https://cdn.example.com/assets",
    );
  });

  it("strips trailing slashes from bare origins", () => {
    expect(normalizeMediaBaseUrl("https://cdn.example.com/")).toBe("https://cdn.example.com");
    expect(normalizeMediaBaseUrl("https://cdn.example.com")).toBe("https://cdn.example.com");
  });

  it("applies the same scheme rules and rejects queries, fragments, and credentials", () => {
    expect(normalizeMediaBaseUrl("http://cdn.example.com/media")).toBe("");
    expect(normalizeMediaBaseUrl("https://cdn.example.com/media?x=1")).toBe("");
    expect(normalizeMediaBaseUrl("https://cdn.example.com/media#frag")).toBe("");
    expect(normalizeMediaBaseUrl("https://user:pass@cdn.example.com/media")).toBe("");
    expect(normalizeMediaBaseUrl("cdn.example.com")).toBe("");
    expect(normalizeMediaBaseUrl(null)).toBe("");
  });
});

describe("mediaHostFromUrl", () => {
  it("returns host with port for CSP and image checks", () => {
    expect(mediaHostFromUrl("https://cdn.example.com/assets")).toBe("cdn.example.com");
    expect(mediaHostFromUrl("http://localhost:8787/api/v1/media")).toBe("localhost:8787");
  });

  it("returns an empty host for invalid or non-loopback HTTP media URLs", () => {
    expect(mediaHostFromUrl("")).toBe("");
    expect(mediaHostFromUrl("http://cdn.example.com")).toBe("");
    expect(mediaHostFromUrl("not a url")).toBe("");
  });
});

describe("normalizeCookieDomain", () => {
  it("lowercases, trims, and strips leading dots from bare hostnames", () => {
    expect(normalizeCookieDomain("Example.com")).toBe("example.com");
    expect(normalizeCookieDomain("  .example.com  ")).toBe("example.com");
    expect(normalizeCookieDomain("..shop.example.com")).toBe("shop.example.com");
    expect(normalizeCookieDomain("localhost")).toBe("localhost");
  });

  it("rejects schemes, ports, paths, wildcards, invalid labels, and non-strings", () => {
    expect(normalizeCookieDomain("https://example.com")).toBe("");
    expect(normalizeCookieDomain("example.com:443")).toBe("");
    expect(normalizeCookieDomain("example.com/path")).toBe("");
    expect(normalizeCookieDomain("*.example.com")).toBe("");
    expect(normalizeCookieDomain("-bad.example.com")).toBe("");
    expect(normalizeCookieDomain("bad-.example.com")).toBe("");
    expect(normalizeCookieDomain("exa mple.com")).toBe("");
    expect(normalizeCookieDomain("example.com.")).toBe("");
    expect(normalizeCookieDomain("")).toBe("");
    expect(normalizeCookieDomain(undefined)).toBe("");
    expect(normalizeCookieDomain(123)).toBe("");
  });

  it("rejects hostnames longer than 253 characters or labels longer than 63", () => {
    expect(normalizeCookieDomain(`${"a".repeat(64)}.example.com`)).toBe("");
    expect(normalizeCookieDomain(`${"a".repeat(63)}.example.com`)).toBe(
      `${"a".repeat(63)}.example.com`,
    );
    const tooLong = Array.from({ length: 30 }, () => "abcdefghij").join(".");
    expect(tooLong.length).toBeGreaterThan(253);
    expect(normalizeCookieDomain(tooLong)).toBe("");
  });
});

describe("normalizeCorsOrigins", () => {
  it("accepts arrays and comma or whitespace separated strings", () => {
    expect(normalizeCorsOrigins(["https://a.example.com", "https://b.example.com/"])).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
    expect(normalizeCorsOrigins("https://a.example.com, https://b.example.com\nhttps://c.example.com")).toEqual([
      "https://a.example.com",
      "https://b.example.com",
      "https://c.example.com",
    ]);
  });

  it("dedupes after normalization and drops invalid entries", () => {
    expect(normalizeCorsOrigins([
      "https://A.example.com",
      "https://a.example.com/",
      "https://a.example.com",
      "http://insecure.example.com",
      "https://*.wild.example.com",
      "https://path.example.com/app",
      "not-a-url",
      "",
      42,
    ])).toEqual(["https://a.example.com"]);
  });

  it("limits the list to the maximum origin count", () => {
    const many = Array.from(
      { length: PLATFORM_CORS_ORIGINS_MAX_COUNT + 5 },
      (_, index) => `https://origin-${index}.example.com`,
    );
    const normalized = normalizeCorsOrigins(many);
    expect(normalized).toHaveLength(PLATFORM_CORS_ORIGINS_MAX_COUNT);
    expect(normalized).toEqual(many.slice(0, PLATFORM_CORS_ORIGINS_MAX_COUNT));
  });

  it("returns an empty list for non-list values", () => {
    expect(normalizeCorsOrigins(undefined)).toEqual([]);
    expect(normalizeCorsOrigins(null)).toEqual([]);
    expect(normalizeCorsOrigins({ origin: "https://a.example.com" })).toEqual([]);
    expect(normalizeCorsOrigins("")).toEqual([]);
  });
});

describe("normalizePlatformConfig", () => {
  it("normalizes every field from a raw object", () => {
    expect(normalizePlatformConfig({
      storefrontUrl: "https://Shop.Example.com/",
      apiUrl: "https://api.example.com",
      dashboardUrl: "http://dashboard.example.com",
      mediaUrl: "https://cdn.example.com/assets/",
      customerAuthCookieDomain: ".Example.com",
      corsAllowedOrigins: "https://mobile.example.com https://mobile.example.com",
    })).toEqual({
      storefrontUrl: "https://shop.example.com",
      apiUrl: "https://api.example.com",
      dashboardUrl: "",
      mediaUrl: "https://cdn.example.com/assets",
      customerAuthCookieDomain: "example.com",
      corsAllowedOrigins: ["https://mobile.example.com"],
    });
  });

  it("returns the empty configuration for non-object input", () => {
    expect(normalizePlatformConfig(undefined)).toEqual({ ...EMPTY_PLATFORM_CONFIG });
    expect(normalizePlatformConfig(null)).toEqual({ ...EMPTY_PLATFORM_CONFIG });
    expect(normalizePlatformConfig("https://shop.example.com")).toEqual({ ...EMPTY_PLATFORM_CONFIG });
    expect(normalizePlatformConfig(7)).toEqual({ ...EMPTY_PLATFORM_CONFIG });
  });

  it("never returns the shared frozen instance", () => {
    const normalized = normalizePlatformConfig({});
    expect(normalized).not.toBe(EMPTY_PLATFORM_CONFIG);
    expect(normalized.corsAllowedOrigins).not.toBe(EMPTY_PLATFORM_CONFIG.corsAllowedOrigins);
  });
});

describe("isLoopbackUrl / isInternalServiceUrl", () => {
  it("detects loopback hosts on http and https", () => {
    expect(isLoopbackUrl("http://localhost:4323")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:8787")).toBe(true);
    expect(isLoopbackUrl("https://localhost")).toBe(true);
    expect(isLoopbackUrl("https://shop.example.com")).toBe(false);
    expect(isLoopbackUrl("http://localhost.evil.test")).toBe(false);
    expect(isLoopbackUrl("")).toBe(false);
    expect(isLoopbackUrl(undefined)).toBe(false);
  });

  it("recognizes the service-binding origin only", () => {
    expect(isInternalServiceUrl("https://api.internal/api/v1/platform")).toBe(true);
    expect(isInternalServiceUrl("https://api.internal")).toBe(true);
    expect(isInternalServiceUrl("https://api.internal.example.com")).toBe(false);
    expect(isInternalServiceUrl("http://api.internal")).toBe(false);
    expect(isInternalServiceUrl("nope")).toBe(false);
    expect(isInternalServiceUrl(undefined)).toBe(false);
  });
});

describe("withLocalDevelopmentDefaults", () => {
  it("fills unset URLs with the fixed local ports when the request is loopback", () => {
    const config = withLocalDevelopmentDefaults(
      { ...EMPTY_PLATFORM_CONFIG, corsAllowedOrigins: [] },
      "http://localhost:8787",
    );
    expect(config).toEqual({
      ...LOCAL_DEVELOPMENT_PLATFORM_CONFIG,
      corsAllowedOrigins: [],
    });
  });

  it("keeps configured values and only fills the gaps", () => {
    const config = withLocalDevelopmentDefaults(
      { ...PRODUCTION_CONFIG, mediaUrl: "" },
      "http://127.0.0.1:8787",
    );
    expect(config).toEqual({
      ...PRODUCTION_CONFIG,
      mediaUrl: LOCAL_DEVELOPMENT_PLATFORM_CONFIG.mediaUrl,
    });
  });

  it("never guesses origins for non-loopback, service-binding, or missing request origins", () => {
    const empty: PlatformConfig = { ...EMPTY_PLATFORM_CONFIG, corsAllowedOrigins: [] };
    expect(withLocalDevelopmentDefaults(empty, "https://api.example.com")).toBe(empty);
    expect(withLocalDevelopmentDefaults(empty, INTERNAL_SERVICE_ORIGIN)).toBe(empty);
    expect(withLocalDevelopmentDefaults(empty, "http://localhost.evil.test")).toBe(empty);
    expect(withLocalDevelopmentDefaults(empty, null)).toBe(empty);
    expect(withLocalDevelopmentDefaults(empty, undefined)).toBe(empty);
    expect(withLocalDevelopmentDefaults(empty, "")).toBe(empty);
  });
});

describe("publicRequestOrigin", () => {
  it("returns the origin for public request URLs", () => {
    expect(publicRequestOrigin("https://api.example.com/api/v1/products?x=1")).toBe(
      "https://api.example.com",
    );
    expect(publicRequestOrigin("http://localhost:8787/api/v1/health")).toBe("http://localhost:8787");
  });

  it("ignores the service-binding origin and malformed URLs", () => {
    expect(publicRequestOrigin(`${INTERNAL_SERVICE_ORIGIN}/api/v1/platform`)).toBeNull();
    expect(publicRequestOrigin(INTERNAL_SERVICE_ORIGIN)).toBeNull();
    expect(publicRequestOrigin("not a url")).toBeNull();
    expect(publicRequestOrigin("blob:https://api.example.com/uuid")).toBeNull();
    expect(publicRequestOrigin("")).toBeNull();
    expect(publicRequestOrigin(null)).toBeNull();
    expect(publicRequestOrigin(undefined)).toBeNull();
  });
});

describe("storefrontPurgeUrl", () => {
  it("appends the purge path to a valid storefront origin", () => {
    expect(storefrontPurgeUrl("https://shop.example.com/")).toBe("https://shop.example.com/api/purge-cache");
    expect(storefrontPurgeUrl("http://localhost:4322")).toBe("http://localhost:4322/api/purge-cache");
  });

  it("returns an empty string when the storefront origin is missing or invalid", () => {
    expect(storefrontPurgeUrl("")).toBe("");
    expect(storefrontPurgeUrl("http://shop.example.com")).toBe("");
    expect(storefrontPurgeUrl("https://shop.example.com/store")).toBe("");
  });
});

describe("getPlatformConfigReadiness", () => {
  it("is ready when all four public URLs are set", () => {
    expect(getPlatformConfigReadiness(PRODUCTION_CONFIG))
      .toEqual({ status: "ready", issues: [], missing: [] });
    expect(getPlatformConfigReadiness({ ...PRODUCTION_CONFIG, customerAuthCookieDomain: "", corsAllowedOrigins: [] }))
      .toEqual({ status: "ready", issues: [], missing: [] });
    expect(isReady(getPlatformConfigReadiness(PRODUCTION_CONFIG))).toBe(true);
  });

  it("lists every missing URL key in contract order", () => {
    const empty = getPlatformConfigReadiness({ ...EMPTY_PLATFORM_CONFIG, corsAllowedOrigins: [] });
    expect(empty.status).toBe("incomplete");
    expect(empty.missing).toEqual(["storefrontUrl", "apiUrl", "dashboardUrl", "mediaUrl"]);
    expect(empty.issues.map((issue) => issue.code)).toEqual([
      "missing_storefront_url",
      "missing_api_url",
      "missing_dashboard_url",
      "missing_media_url",
    ]);

    const partial = getPlatformConfigReadiness({ ...PRODUCTION_CONFIG, apiUrl: "", mediaUrl: "" });
    expect(partial.status).toBe("incomplete");
    expect(partial.missing).toEqual(["apiUrl", "mediaUrl"]);
    expect(isReady(partial)).toBe(false);
  });

  it("gives every issue merchant-facing copy that names the dashboard page", () => {
    const [issue] = getPlatformConfigReadiness({ ...PRODUCTION_CONFIG, apiUrl: "" }).issues;
    expect(issue).toEqual({
      code: "missing_api_url",
      message: "API URL is not configured.",
      fix: PLATFORM_READINESS_FIX,
    });
    expect(PLATFORM_READINESS_FIX).toContain("Settings -> System -> Platform");
  });
});
