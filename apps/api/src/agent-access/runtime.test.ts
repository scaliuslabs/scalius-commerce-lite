import { beforeEach, describe, expect, it, vi } from "vitest";

const oauthMocks = vi.hoisted(() => ({
  providerFetch: vi.fn(),
  complete: vi.fn(),
}));

vi.mock("./oauth", () => ({
  createOAuthProvider: () => ({ fetch: oauthMocks.providerFetch }),
  completeOAuthAuthorization: oauthMocks.complete,
}));

import { handleAgentAccessRequest } from "./runtime";

function runtimeEnv() {
  return {
    PUBLIC_API_BASE_URL: "https://api.example.test",
    BETTER_AUTH_URL: "https://dashboard.example.test",
    STOREFRONT_URL: "https://storefront.example.test",
    AGENT_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
  } as unknown as Env;
}

describe("agent runtime ingress", () => {
  beforeEach(() => {
    oauthMocks.providerFetch.mockReset().mockResolvedValue(new Response("provider"));
    oauthMocks.complete.mockReset();
  });

  it.each(["dashboard", "storefront"])(
    "answers %s MCP preflight before bearer authentication",
    async (surface) => {
      const response = await handleAgentAccessRequest(
        new Request(`https://api.example.test/api/v1/mcp/${surface}`, {
          method: "OPTIONS",
          headers: { Origin: "https://dashboard.example.test" },
        }),
        runtimeEnv(),
        {} as ExecutionContext,
      );
      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Origin"))
        .toBe("https://dashboard.example.test");
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(oauthMocks.providerFetch).not.toHaveBeenCalled();
    },
  );

  it("rejects wrong Host/Origin and exact-path lookalikes before provider work", async () => {
    const wrongHost = await handleAgentAccessRequest(
      new Request("https://evil.example.test/api/v1/mcp/dashboard", { method: "POST" }),
      runtimeEnv(),
      {} as ExecutionContext,
    );
    expect(wrongHost.status).toBe(421);

    const wrongOrigin = await handleAgentAccessRequest(
      new Request("https://api.example.test/api/v1/mcp/dashboard", {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example.test" },
      }),
      runtimeEnv(),
      {} as ExecutionContext,
    );
    expect(wrongOrigin.status).toBe(403);

    const lookalike = await handleAgentAccessRequest(
      new Request("https://api.example.test/api/v1/mcp/dashboard-evil", { method: "POST" }),
      runtimeEnv(),
      {} as ExecutionContext,
    );
    expect(lookalike.status).toBe(404);
    expect(oauthMocks.providerFetch).not.toHaveBeenCalled();
  });

  it("fails closed with no-store when the unauthenticated limiter is unavailable", async () => {
    const env = runtimeEnv();
    (env.AGENT_RATE_LIMITER.limit as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("binding unavailable"));
    const response = await handleAgentAccessRequest(
      new Request("https://api.example.test/oauth/authorize", { method: "GET" }),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(oauthMocks.providerFetch).not.toHaveBeenCalled();
  });

  it("IP-limits MCP before OAuth parsing and does not misreport binding failure as quota", async () => {
    const denied = runtimeEnv();
    (denied.AGENT_RATE_LIMITER.limit as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ success: false });
    const limited = await handleAgentAccessRequest(
      new Request("https://api.example.test/api/v1/mcp/dashboard", { method: "POST" }),
      denied,
      {} as ExecutionContext,
    );
    expect(limited.status).toBe(429);
    expect(oauthMocks.providerFetch).not.toHaveBeenCalled();

    const unavailable = runtimeEnv();
    (unavailable.AGENT_RATE_LIMITER.limit as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("binding unavailable"));
    const failedClosed = await handleAgentAccessRequest(
      new Request("https://api.example.test/api/v1/mcp/storefront", { method: "POST" }),
      unavailable,
      {} as ExecutionContext,
    );
    expect(failedClosed.status).toBe(503);
    expect(failedClosed.headers.get("Cache-Control")).toBe("private, no-store");
    expect(oauthMocks.providerFetch).not.toHaveBeenCalled();
  });

  it("normalizes random artifact and completion IDs into bounded per-IP buckets", async () => {
    const env = runtimeEnv();
    const limiter = env.AGENT_RATE_LIMITER.limit as ReturnType<typeof vi.fn>;
    limiter
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false });
    const artifact = (suffix: string) => handleAgentAccessRequest(
      new Request(`https://api.example.test/api/v1/mcp/dashboard/artifacts/aah_${suffix}`, {
        method: "GET",
      }),
      env,
      {} as ExecutionContext,
    );
    await artifact("0123456789abcdefghij");
    await artifact("jihgfedcba9876543210");
    const complete = (suffix: string) => handleAgentAccessRequest(
      new Request(`https://api.example.test/oauth/complete/aar_${suffix}`, { method: "GET" }),
      env,
      {} as ExecutionContext,
    );
    await complete("0123456789abcdefghij");
    await complete("jihgfedcba9876543210");
    expect(limiter.mock.calls.map(([input]) => input.key)).toEqual([
      "unauth:artifact.dashboard:unknown",
      "unauth:artifact.dashboard:unknown",
      "unauth:oauth.complete:unknown",
      "unauth:oauth.complete:unknown",
    ]);
    expect(oauthMocks.providerFetch).toHaveBeenCalledTimes(1);
    expect(oauthMocks.complete).toHaveBeenCalledTimes(1);
  });
});
