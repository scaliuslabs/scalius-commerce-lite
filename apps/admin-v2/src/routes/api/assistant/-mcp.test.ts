import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cfEnv: {} as { AGENT?: Fetcher },
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
}));

vi.mock("cloudflare:workers", () => ({ env: mocks.cfEnv }));

describe("assistant admin MCP proxy", () => {
  beforeEach(() => {
    vi.resetModules();
    delete mocks.cfEnv.AGENT;
  });

  it("proxies streamable MCP POST requests to the agent admin path without Authorization", async () => {
    const agentFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://agent.internal/mcp/admin?transport=stream");
      expect(init?.method).toBe("POST");

      const headers = new Headers(init?.headers);
      expect(headers.get("accept")).toBe("application/json, text/event-stream");
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("cookie")).toBe("better-auth.session_token=session.signature");
      expect(headers.get("mcp-session-id")).toBe("client-session");
      expect(headers.get("mcp-protocol-version")).toBe("2025-06-18");
      expect(headers.has("authorization")).toBe(false);
      expect(headers.has("x-extra-header")).toBe(false);

      await expect(new Response(init?.body).json()).resolves.toMatchObject({
        jsonrpc: "2.0",
        method: "tools/list",
      });

      return new Response(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } })}\n\n`,
        {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Mcp-Session-Id": "agent-session",
          },
        },
      );
    });
    mocks.cfEnv.AGENT = { fetch: agentFetch };

    const { proxyToAgentAdminMcp } = await import("./mcp");
    const response = await proxyToAgentAdminMcp(
      new Request("https://dashboard.test/api/assistant/mcp?transport=stream", {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          Authorization: "Bearer should-not-forward",
          "Content-Type": "application/json",
          Cookie: "better-auth.session_token=session.signature",
          "Mcp-Protocol-Version": "2025-06-18",
          "Mcp-Session-Id": "client-session",
          "X-Extra-Header": "drop-me",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("mcp-session-id")).toBe("agent-session");
    await expect(response.text()).resolves.toContain("event: message");
  });

  it("proxies GET requests for MCP streams without a request body", async () => {
    const agentFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://agent.internal/mcp/admin?session=abc");
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();

      const headers = new Headers(init?.headers);
      expect(headers.get("accept")).toBe("text/event-stream");
      expect(headers.get("cookie")).toBe("better-auth.session_token=session.signature");
      expect(headers.get("mcp-session-id")).toBe("client-session");

      return new Response("ok", { status: 200 });
    });
    mocks.cfEnv.AGENT = { fetch: agentFetch };

    const { proxyToAgentAdminMcp } = await import("./mcp");
    const response = await proxyToAgentAdminMcp(
      new Request("https://dashboard.test/api/assistant/mcp?session=abc", {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          Cookie: "better-auth.session_token=session.signature",
          "Mcp-Session-Id": "client-session",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(agentFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects cross-origin cookie writes before calling the agent", async () => {
    const agentFetch = vi.fn();
    mocks.cfEnv.AGENT = { fetch: agentFetch };

    const { proxyToAgentAdminMcp } = await import("./mcp");
    const response = await proxyToAgentAdminMcp(
      new Request("https://dashboard.test/api/assistant/mcp", {
        method: "POST",
        headers: {
          Cookie: "better-auth.session_token=session.signature",
          Origin: "https://evil.test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: "CROSS_ORIGIN_COOKIE_REQUEST" },
    });
    expect(agentFetch).not.toHaveBeenCalled();
  });

  it("fails closed with no-store JSON when the agent binding is missing", async () => {
    const { proxyToAgentAdminMcp } = await import("./mcp");
    const response = await proxyToAgentAdminMcp(
      new Request("https://dashboard.test/api/assistant/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: {
        code: "AGENT_BINDING_UNAVAILABLE",
        message: "Assistant service is unavailable",
      },
    });
  });

  it("fails closed with no-store JSON when the agent fetch throws", async () => {
    mocks.cfEnv.AGENT = {
      fetch: vi.fn(async () => {
        throw new Error("agent down");
      }),
    };

    const { proxyToAgentAdminMcp } = await import("./mcp");
    const response = await proxyToAgentAdminMcp(
      new Request("https://dashboard.test/api/assistant/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      }),
    );

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: { code: "AGENT_MCP_PROXY_FAILED" },
    });
  });
});
