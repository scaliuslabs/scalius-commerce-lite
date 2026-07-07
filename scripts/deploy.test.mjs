import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getBuildCommandForTarget,
  getDeployCommandForTarget,
  parseOnlyTarget,
  sampleApiReadiness,
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
  it("accepts non-commerce worker deploy targets", () => {
    expect(parseOnlyTarget(["--only", "ops-monitor"])).toEqual({
      ok: true,
      target: "ops-monitor",
    });
    expect(parseOnlyTarget(["--only", "agent"])).toEqual({
      ok: true,
      target: "agent",
    });

    expect(parseOnlyTarget(["--only", "unknown"])).toMatchObject({
      ok: false,
      message: expect.stringContaining("api, admin, storefront, ops-monitor, agent"),
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

  it("builds and deploys agent from its app workspace", () => {
    expect(getBuildCommandForTarget("agent")).toContain(
      "--filter @scalius/agent build",
    );

    const command = getDeployCommandForTarget("agent");
    expect(command.cmd).toContain("exec wrangler deploy");
    expect(command.label).toBe("Deploy Agent Worker");
    expect(command.cwd).toMatch(/apps\/agent$/);
  });
});
