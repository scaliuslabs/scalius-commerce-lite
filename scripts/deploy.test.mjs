import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  cacheStatusBuildId,
  collectStorefrontWarmPaths,
  fetchPlatformConfig,
  getExternalSchemaPreflightCommand,
  getBuildCommandForTarget,
  getDeployCommandForTarget,
  getDistSecretCommands,
  getSequentialWorkspaceCommand,
  getStorefrontCustomDomainUrl,
  getTypecheckCommandForTarget,
  normalizeDeploymentOrigin,
  parseJsoncText,
  parseOnlyTarget,
  parseStorefrontBuildId,
  resolveDeploymentUrls,
  resolveStorefrontVerificationUrl,
  sampleApiReadiness,
  resolveDeploymentDatabaseProvider,
  storefrontStaticPostDeployWarmPaths,
  verifyPostDeployTarget,
  warmStorefrontPath,
} from "./deploy.mjs";

function platformResponse(data, status = 200) {
  return new Response(JSON.stringify({ success: true, data }), { status });
}

function readyResponse() {
  return new Response(JSON.stringify({
    success: true,
    status: "ready",
    checks: {
      d1: { status: "ok", latencyMs: 20 },
      api_cache_kv: { status: "ok", latencyMs: 30 },
      r2: { status: "ok", latencyMs: 40 },
    },
  }), { status: 200 });
}

function degradedResponse(status = 503) {
  return new Response(JSON.stringify({
    success: false,
    status: "degraded",
    checks: {
      d1: { status: "ok", latencyMs: 20 },
      api_cache_kv: { status: "ok", latencyMs: 30 },
      r2: { status: "error", latencyMs: 1_500 },
    },
  }), { status });
}

describe("deploy API readiness sampling", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes when transient degraded readiness samples recover", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(degradedResponse())
      .mockResolvedValueOnce(readyResponse())
      .mockResolvedValueOnce(readyResponse())
      .mockResolvedValueOnce(readyResponse());

    const result = await sampleApiReadiness("https://api.example.test", {
      sampleCount: 4,
      delayMs: 0,
      fetchImpl,
      sleepImpl: async () => undefined,
    });

    expect(result.readyCount).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.example.test/api/v1/readyz");
    expect(console.warn).toHaveBeenCalledWith(
      "⚠ API /readyz recovered after transient degraded samples (3/4 ready).",
    );
  });

  it("fails when readiness never recovers", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(degradedResponse())
      .mockResolvedValueOnce(degradedResponse())
      .mockResolvedValueOnce(degradedResponse());

    await expect(sampleApiReadiness("https://api.example.test", {
      sampleCount: 3,
      delayMs: 0,
      fetchImpl,
      sleepImpl: async () => undefined,
    })).rejects.toThrow("API /readyz did not recover during deploy verification");
  });

  it("accepts pending merchant setup (platform_config missing) as ready infrastructure", async () => {
    const setupPending = () => new Response(JSON.stringify({
      success: false,
      status: "degraded",
      checks: {
        d1: { status: "ok", latencyMs: 20 },
        runtime_config: { status: "ok" },
        platform_config: { status: "missing", detail: "missing dashboardUrl, mediaUrl" },
      },
    }), { status: 503 });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(setupPending())
      .mockResolvedValueOnce(setupPending())
      .mockResolvedValueOnce(setupPending())
      .mockResolvedValueOnce(setupPending());

    const result = await sampleApiReadiness("https://api.example.test", {
      sampleCount: 4,
      delayMs: 0,
      fetchImpl,
      sleepImpl: async () => {},
    });

    expect(result.readyCount).toBe(4);
    expect(result.setupPending).toEqual(["platform_config"]);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("Settings -> System -> Platform"),
    );
  });

  it("still fails when an infrastructure check is degraded alongside pending setup", async () => {
    const mixed = () => new Response(JSON.stringify({
      success: false,
      status: "degraded",
      checks: {
        d1: { status: "ok", latencyMs: 20 },
        r2: { status: "error", latencyMs: 1_500 },
        platform_config: { status: "missing" },
      },
    }), { status: 503 });
    const fetchImpl = vi.fn().mockResolvedValue(mixed());

    await expect(sampleApiReadiness("https://api.example.test", {
      sampleCount: 2,
      delayMs: 0,
      fetchImpl,
      sleepImpl: async () => {},
    })).rejects.toThrow("API /readyz did not recover during deploy verification");
  });

  it("does not treat a 200 response with a degraded dependency as ready", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(degradedResponse(200))
      .mockResolvedValueOnce(readyResponse());

    await expect(sampleApiReadiness("https://api.example.test", {
      sampleCount: 2,
      delayMs: 0,
      fetchImpl,
      sleepImpl: async () => undefined,
    })).rejects.toThrow("1/2 ready");
  });

  it("does not treat an empty readiness dependency set as ready", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      status: "ready",
      checks: {},
    }), { status: 200 }));

    await expect(sampleApiReadiness("https://api.example.test", {
      sampleCount: 2,
      delayMs: 0,
      fetchImpl,
      sleepImpl: async () => undefined,
    })).rejects.toThrow("0/2 ready");
  });
});

describe("deploy target wiring", () => {
  it("parses JSONC comments without truncating provider URLs", () => {
    expect(parseJsoncText(`{
      // provider selection
      "turso": "turso://database.example.turso.io",
      "libsql": "libsql://legacy.example.turso.io",
      "https": "https://api.example.test/path//segment",
      /* generated platform metadata */
      "escaped": "quote: \\" // still inside the string"
    }`)).toEqual({
      turso: "turso://database.example.turso.io",
      libsql: "libsql://legacy.example.turso.io",
      https: "https://api.example.test/path//segment",
      escaped: 'quote: " // still inside the string',
    });
  });

  it("accepts only the platform Workers that remain", () => {
    for (const target of ["api", "storefront"]) {
      expect(parseOnlyTarget(["--only", target])).toEqual({ ok: true, target });
    }

    // The dashboard is the API Worker's static assets, not a Worker of its own.
    for (const target of ["admin", "removed-worker"]) {
      expect(parseOnlyTarget(["--only", target])).toMatchObject({
        ok: false,
        message: expect.stringContaining("api, storefront"),
      });
    }
  });

  it("passes an explicit provider-specific Wrangler config only to the API deploy", () => {
    const command = getDeployCommandForTarget(
      "api",
      "/tmp/scalius loadtest/wrangler.turso.jsonc",
    );

    expect(command.cmd).toContain("exec wrangler deploy --config");
    expect(command.cmd).toContain("wrangler.turso.jsonc");
    expect(command.cwd).toMatch(/apps\/api$/);
  });

  it("keeps typechecking and deployment commands on supported workspaces", () => {
    expect(getTypecheckCommandForTarget("api")).toContain(
      "--workspace-concurrency=1 --filter @scalius/admin-v2 --filter @scalius/api typecheck",
    );
    expect(getTypecheckCommandForTarget("storefront")).toContain("--filter @scalius/storefront typecheck");
    expect(getSequentialWorkspaceCommand("typecheck")).toContain("--concurrency=1");
    expect(getSequentialWorkspaceCommand("build")).toContain("--concurrency=1");
    expect(getBuildCommandForTarget("api")).toContain("turbo run build --filter=@scalius/api --concurrency=1");
    expect(getBuildCommandForTarget("storefront")).toContain("--filter @scalius/storefront build");
    expect(() => getBuildCommandForTarget("removed-worker")).toThrow(
      "Unknown deploy target: removed-worker",
    );
    expect(() => getTypecheckCommandForTarget("removed-worker")).toThrow(
      "Unknown deploy target: removed-worker",
    );
  });

  it("scans dist and runs canary builds for every app a target ships", () => {
    expect(getDistSecretCommands(["storefront"]).map(({ cmd }) => cmd)).toEqual([
      "node scripts/check-dist-secrets.mjs apps/storefront",
      "node scripts/check-build-canaries.mjs storefront",
    ]);
    expect(getDistSecretCommands(["api", "storefront"]).map(({ cmd }) => cmd)).toEqual([
      "node scripts/check-dist-secrets.mjs apps/admin-v2 apps/api apps/storefront",
      "node scripts/check-build-canaries.mjs admin-v2 api storefront",
    ]);
    expect(() => getDistSecretCommands(["removed-worker"])).toThrow("Unknown deploy target: removed-worker");
  });

  it("selects D1 from the binding when the committed config carries no vars", () => {
    expect(resolveDeploymentDatabaseProvider({
      d1_databases: [{ database_name: "scalius-commerce" }],
    })).toBe("d1");
    expect(resolveDeploymentDatabaseProvider(parseJsoncText(
      readFileSync(new URL("../apps/api/wrangler.jsonc", import.meta.url), "utf8"),
    ))).toBe("d1");
    expect(() => resolveDeploymentDatabaseProvider({})).toThrow(/DATABASE_PROVIDER or contain a D1 binding/);
    expect(() => resolveDeploymentDatabaseProvider({ vars: { DATABASE_PROVIDER: "mysql" } }))
      .toThrow(/Unsupported DATABASE_PROVIDER/);
  });

  it("keeps external schema changes out of ordinary deploys", () => {
    expect(resolveDeploymentDatabaseProvider({
      vars: { DATABASE_PROVIDER: "postgres" },
      d1_databases: [{ database_name: "starter" }],
    })).toBe("postgres");
    const command = getExternalSchemaPreflightCommand(
      "postgres",
      "merchant.example.neon.tech",
    );
    expect(command).toContain("upgrade:schema --provider postgres");
    expect(command).toContain("--dry-run --require-current");
    expect(command).not.toContain("freeze-proof");
  });

  it("rejects missing external preflight identity", () => {
    expect(() => getExternalSchemaPreflightCommand("postgres", ""))
      .toThrow(/database-target-host/i);
    expect(() => getExternalSchemaPreflightCommand("d1", "example.test"))
      .toThrow(/turso or postgres/i);
  });
});

describe("storefront post-deploy warming", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warms crawler discovery before buyer HTML", () => {
    expect(storefrontStaticPostDeployWarmPaths.slice(0, 2)).toEqual([
      "/robots.txt",
      "/sitemap.xml",
    ]);
    expect(storefrontStaticPostDeployWarmPaths).toContain("/");
    expect(storefrontStaticPostDeployWarmPaths).toContain("/api/product-feed.xml");
  });

  it("parses the generated build and cache-status contracts", () => {
    expect(parseStorefrontBuildId('export const BUILD_ID = "src-current";')).toBe(
      "src-current",
    );
    expect(cacheStatusBuildId("HIT; v=4; build=src-current; gen=2")).toBe(
      "src-current",
    );
    expect(cacheStatusBuildId("unknown")).toBeNull();
  });

  it("retries an old edge build until the expected build is served", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("old", {
        status: 200,
        headers: { "X-Cache-Status": "HIT; v=4; build=src-old" },
      }))
      .mockResolvedValueOnce(new Response("current", {
        status: 200,
        headers: { "X-Cache-Status": "MISS; v=4; build=src-current" },
      }));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    const result = await warmStorefrontPath(
      "https://storefront.example.test",
      "/products/example",
      {
        expectedBuildId: "src-current",
        maxAttempts: 3,
        retryDelayMs: 1,
        fetchImpl,
        sleepImpl,
      },
    );

    expect(result).toMatchObject({ attempt: 2, servedBuildId: "src-current" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledTimes(1);
  });

  it("proves an uncached health response through its explicit build header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ status: "ok", buildId: "src-current" }),
      {
        status: 200,
        headers: {
          "X-Cache-Status": "BYPASS_FAST",
          "X-Storefront-Build": "src-current",
        },
      },
    ));

    await expect(warmStorefrontPath(
      "https://storefront.example.test",
      "/health",
      {
        expectedBuildId: "src-current",
        maxAttempts: 1,
        fetchImpl,
      },
    )).resolves.toMatchObject({
      attempt: 1,
      cacheStatus: "BYPASS_FAST",
      servedBuildId: "src-current",
    });
  });

  it("fails verification when the old build persists", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () =>
      new Response("old", {
        status: 200,
        headers: { "X-Cache-Status": "HIT; v=4; build=src-old" },
      }),
    );

    await expect(warmStorefrontPath(
      "https://storefront.example.test",
      "/search",
      {
        expectedBuildId: "src-current",
        maxAttempts: 2,
        retryDelayMs: 0,
        fetchImpl,
      },
    )).rejects.toThrow(
      "Verify the custom-domain target and Worker propagation, then rerun deployment verification",
    );
  });
});

describe("post-deploy verification URLs", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes origins and rejects paths, credentials, and wildcards", () => {
    expect(normalizeDeploymentOrigin(" https://shop.example.test/ ", "x")).toBe("https://shop.example.test");
    expect(normalizeDeploymentOrigin("http://localhost:4322", "x")).toBe("http://localhost:4322");
    expect(normalizeDeploymentOrigin(undefined, "x")).toBeNull();
    expect(normalizeDeploymentOrigin("", "x")).toBeNull();
    expect(() => normalizeDeploymentOrigin("https://api.example.test/api/v1", "--api-url"))
      .toThrow("--api-url must be an origin without a path");
    expect(() => normalizeDeploymentOrigin("https://user:pw@example.test", "x")).toThrow("credentials");
    expect(() => normalizeDeploymentOrigin("https://*.example.test", "x")).toThrow("wildcard");
    expect(() => normalizeDeploymentOrigin("ftp://example.test", "x")).toThrow("http or https");
    expect(() => normalizeDeploymentOrigin("not a url", "x")).toThrow("absolute http(s) origin");
  });

  it("derives the storefront origin from the Wrangler custom-domain route", () => {
    expect(getStorefrontCustomDomainUrl({
      routes: [
        { pattern: "*.example.test/*", zone_name: "example.test" },
        { pattern: "shop.example.test", custom_domain: true },
      ],
    })).toBe("https://shop.example.test");
    expect(getStorefrontCustomDomainUrl({
      routes: [{ pattern: "shop.example.test/*", custom_domain: true }],
    })).toBe("https://shop.example.test");
    expect(getStorefrontCustomDomainUrl({ routes: [{ pattern: "shop.example.test" }] })).toBeNull();
    expect(getStorefrontCustomDomainUrl({ routes: [{ pattern: "*.example.test", custom_domain: true }] })).toBeNull();
    expect(getStorefrontCustomDomainUrl({})).toBeNull();
    expect(getStorefrontCustomDomainUrl(null)).toBeNull();
  });

  it("reads the repository storefront custom domain", () => {
    const config = parseJsoncText(
      readFileSync(new URL("../apps/storefront/wrangler.jsonc", import.meta.url), "utf8"),
    );
    expect(config.vars).toBeUndefined();
    expect(getStorefrontCustomDomainUrl(config)).toBe("https://storefront.scalius.com");
  });

  it("prefers CLI flags, then environment, then the custom domain; the API has no config fallback", () => {
    const storefrontConfig = { routes: [{ pattern: "shop.example.test", custom_domain: true }] };

    expect(resolveDeploymentUrls({ args: [], env: {}, storefrontConfig })).toEqual({
      storefrontUrl: "https://shop.example.test",
      apiUrl: null,
    });
    expect(resolveDeploymentUrls({
      args: [],
      env: { SCALIUS_STOREFRONT_URL: "https://env.example.test/", SCALIUS_API_URL: "https://api-env.example.test" },
      storefrontConfig,
    })).toEqual({
      storefrontUrl: "https://env.example.test",
      apiUrl: "https://api-env.example.test",
    });
    expect(resolveDeploymentUrls({
      args: ["--only", "storefront", "--storefront-url", "https://flag.example.test", "--api-url=https://api-flag.example.test"],
      env: { SCALIUS_STOREFRONT_URL: "https://env.example.test", SCALIUS_API_URL: "https://api-env.example.test" },
      storefrontConfig,
    })).toEqual({
      storefrontUrl: "https://flag.example.test",
      apiUrl: "https://api-flag.example.test",
    });
    expect(resolveDeploymentUrls({ args: [], env: {}, storefrontConfig: null })).toEqual({
      storefrontUrl: null,
      apiUrl: null,
    });
    expect(() => resolveDeploymentUrls({ args: ["--api-url"], env: {} })).toThrow(/requires a value/);
    expect(() => resolveDeploymentUrls({ args: [], env: { SCALIUS_API_URL: "https://api.example.test/api/v1" } }))
      .toThrow("--api-url / SCALIUS_API_URL must be an origin without a path");
  });

  it("reads the public platform envelope and rejects failures", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(platformResponse({
      storefrontUrl: "https://shop.example.test",
      apiUrl: "https://api.example.test",
      dashboardUrl: "https://dashboard.example.test",
      mediaUrl: "https://cdn.example.test",
    }));

    await expect(fetchPlatformConfig("https://api.example.test", { fetchImpl })).resolves.toEqual({
      storefrontUrl: "https://shop.example.test",
      apiUrl: "https://api.example.test",
      dashboardUrl: "https://dashboard.example.test",
      mediaUrl: "https://cdn.example.test",
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.example.test/api/v1/platform");

    await expect(fetchPlatformConfig("https://api.example.test", {
      fetchImpl: vi.fn().mockResolvedValue(new Response("nope", { status: 503 })),
    })).rejects.toThrow("returned 503");
    await expect(fetchPlatformConfig("https://api.example.test", {
      fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false }), { status: 200 })),
    })).rejects.toThrow("successful platform envelope");
    await expect(fetchPlatformConfig("https://api.example.test", {
      fetchImpl: vi.fn().mockResolvedValue(new Response("<html>", { status: 200 })),
    })).rejects.toThrow("did not return JSON");
  });

  it("uses the known storefront origin without the API and fails clearly when nothing is known", async () => {
    const fetchPlatformConfigImpl = vi.fn();

    await expect(resolveStorefrontVerificationUrl(
      { storefrontUrl: "https://shop.example.test", apiUrl: null },
      { fetchPlatformConfigImpl },
    )).resolves.toBe("https://shop.example.test");
    expect(fetchPlatformConfigImpl).not.toHaveBeenCalled();

    await expect(resolveStorefrontVerificationUrl(
      { storefrontUrl: null, apiUrl: null },
      { fetchPlatformConfigImpl },
    )).rejects.toThrow(/custom_domain route .* --storefront-url .* --api-url/);
  });

  it("falls back to the dashboard Platform storefrontUrl when only the API origin is known", async () => {
    const fetchPlatformConfigImpl = vi.fn().mockResolvedValue({
      storefrontUrl: "https://shop.example.test",
      apiUrl: "https://api.example.test",
      dashboardUrl: null,
      mediaUrl: null,
    });

    await expect(resolveStorefrontVerificationUrl(
      { storefrontUrl: null, apiUrl: "https://api.example.test" },
      { fetchPlatformConfigImpl },
    )).resolves.toBe("https://shop.example.test");
    expect(fetchPlatformConfigImpl).toHaveBeenCalledWith("https://api.example.test");

    await expect(resolveStorefrontVerificationUrl(
      { storefrontUrl: null, apiUrl: "https://api.example.test" },
      { fetchPlatformConfigImpl: vi.fn().mockResolvedValue({ storefrontUrl: null }) },
    )).rejects.toThrow("storefrontUrl is empty");

    await expect(resolveStorefrontVerificationUrl(
      { storefrontUrl: null, apiUrl: "https://api.example.test" },
      { fetchPlatformConfigImpl: vi.fn().mockRejectedValue(new Error("HTTP 503")) },
    )).rejects.toThrow(/reading https:\/\/api\.example\.test\/api\/v1\/platform failed \(HTTP 503\)/);
  });

  it("warns, but keeps the deploy target, when the Platform setting disagrees", async () => {
    await expect(resolveStorefrontVerificationUrl(
      { storefrontUrl: "https://shop.example.test", apiUrl: "https://api.example.test" },
      {
        fetchPlatformConfigImpl: vi.fn().mockResolvedValue({ storefrontUrl: "https://old.example.test" }),
      },
    )).resolves.toBe("https://shop.example.test");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("differs from the deploy target"));

    await expect(resolveStorefrontVerificationUrl(
      { storefrontUrl: "https://shop.example.test", apiUrl: "https://api.example.test" },
      { fetchPlatformConfigImpl: vi.fn().mockRejectedValue(new Error("timeout")) },
    )).resolves.toBe("https://shop.example.test");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Could not read dashboard Platform settings"));
  });

  it("skips API-driven warm paths with a notice when the API origin is unknown", async () => {
    const collectDynamicWarmPathsImpl = vi.fn().mockResolvedValue(new Set(["/products/a"]));

    await expect(collectStorefrontWarmPaths(null, { collectDynamicWarmPathsImpl }))
      .resolves.toEqual([...storefrontStaticPostDeployWarmPaths]);
    expect(collectDynamicWarmPathsImpl).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("--api-url"));

    await expect(collectStorefrontWarmPaths("https://api.example.test", { collectDynamicWarmPathsImpl }))
      .resolves.toEqual([...storefrontStaticPostDeployWarmPaths, "/products/a"]);
    expect(collectDynamicWarmPathsImpl).toHaveBeenCalledWith("https://api.example.test");
  });

  it("threads deployment URLs into the target verifiers", async () => {
    const deploymentUrls = { storefrontUrl: "https://shop.example.test", apiUrl: "https://api.example.test" };
    const verifyApiDeployImpl = vi.fn();
    const verifyStorefrontDeployImpl = vi.fn();
    const options = { deploymentUrls, verifyApiDeployImpl, verifyStorefrontDeployImpl };

    await verifyPostDeployTarget("api", { name: "scalius-api" }, null, options);
    expect(verifyApiDeployImpl).toHaveBeenCalledWith({ name: "scalius-api" }, null, options);

    await verifyPostDeployTarget("storefront", { name: "scalius-api" }, null, options);
    expect(verifyStorefrontDeployImpl).toHaveBeenCalledWith(options);
  });
});
