import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheStatusBuildId,
  getExternalSchemaPreflightCommand,
  getBuildCommandForTarget,
  getDeployCommandForTarget,
  getSequentialWorkspaceCommand,
  getTypecheckCommandForTarget,
  parseJsoncText,
  parseOnlyTarget,
  parseStorefrontBuildId,
  sampleApiReadiness,
  resolveDeploymentDatabaseProvider,
  warmStorefrontPath,
} from "./deploy.mjs";

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
    for (const target of ["api", "admin", "storefront", "ops-monitor"]) {
      expect(parseOnlyTarget(["--only", target])).toEqual({ ok: true, target });
    }

    expect(parseOnlyTarget(["--only", "removed-worker"])).toMatchObject({
      ok: false,
      message: expect.stringContaining("api, admin, storefront, ops-monitor"),
    });
  });

  it("builds and deploys ops-monitor from its app workspace", () => {
    expect(getBuildCommandForTarget("ops-monitor")).toContain(
      "--filter @scalius/ops-monitor build",
    );

    const command = getDeployCommandForTarget("ops-monitor");
    expect(command.cmd).toContain("exec wrangler deploy");
    expect(command.label).toBe("Deploy Ops Monitor Worker");
    expect(command.cwd).toMatch(/apps\/ops-monitor$/);
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
    expect(getTypecheckCommandForTarget("api")).toContain("--filter @scalius/api typecheck");
    expect(getTypecheckCommandForTarget("admin")).toContain("--filter @scalius/admin-v2 typecheck");
    expect(getSequentialWorkspaceCommand("typecheck")).toContain("--concurrency=1");
    expect(getSequentialWorkspaceCommand("build")).toContain("--concurrency=1");
    expect(getBuildCommandForTarget("api")).toContain("--filter @scalius/api build");
    expect(getBuildCommandForTarget("admin")).toContain("--filter @scalius/admin-v2 build");
    expect(getBuildCommandForTarget("storefront")).toContain("--filter @scalius/storefront build");
    expect(() => getBuildCommandForTarget("removed-worker")).toThrow(
      "Unknown deploy target: removed-worker",
    );
    expect(() => getTypecheckCommandForTarget("removed-worker")).toThrow(
      "Unknown deploy target: removed-worker",
    );
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
      "Purge all public cache domains and rerun storefront deployment verification",
    );
  });
});
