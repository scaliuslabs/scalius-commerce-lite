import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cfEnv: {} as { ADMIN_AGENT?: Fetcher },
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
}));

vi.mock("cloudflare:workers", () => ({ env: mocks.cfEnv }));

const DASHBOARD_ORIGIN = "https://dashboard.test";
const CONVERSATION_ID = "conv_abcdefghijklmnopqrstuv";
const COOKIE = "better-auth.session_token=session.signature";
const FORBIDDEN_HEADER_CASES: Array<Record<string, string>> = [
  { Authorization: "Bearer must-not-be-accepted" },
  { "Proxy-Authorization": "Basic must-not-be-accepted" },
  { "X-Scalius-Conversation-Subject": "forged-admin" },
  { "X-Scalius-Conversation-Authorized-Until": "9999999999999" },
];

function dashboardRequest(
  path: string,
  init: RequestInit = {},
): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("Cookie")) headers.set("Cookie", COOKIE);
  if (!headers.has("Origin")) headers.set("Origin", DASHBOARD_ORIGIN);
  if (!headers.has("Sec-Fetch-Site")) headers.set("Sec-Fetch-Site", "same-origin");
  return new Request(`${DASHBOARD_ORIGIN}${path}`, { ...init, headers });
}

describe("admin conversation facade", () => {
  beforeEach(() => {
    vi.resetModules();
    delete mocks.cfEnv.ADMIN_AGENT;
  });

  it("forwards an append body with only the dashboard cookie and canonical content headers", async () => {
    const agentFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        `http://admin-agent.internal/internal/conversations/${CONVERSATION_ID}/messages`,
      );
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");

      const headers = new Headers(init?.headers);
      expect([...headers.entries()]).toEqual([
        ["accept", "application/json"],
        ["content-type", "application/json"],
        ["cookie", COOKIE],
      ]);
      await expect(new Response(init?.body).json()).resolves.toEqual({
        clientMessageId: "message_request_1",
        role: "user",
        content: "Show me low-stock products",
        contextMarker: "admin:page",
      });

      return new Response(JSON.stringify({ success: true }), {
        status: 201,
        headers: {
          "Content-Type": "text/plain",
          "Set-Cookie": "internal=must-not-leak",
          "X-Agent-Internal": "must-not-leak",
        },
      });
    });
    mocks.cfEnv.ADMIN_AGENT = { fetch: agentFetch };

    const { proxyToAdminConversation } = await import("./$");
    const response = await proxyToAdminConversation(
      dashboardRequest(
        `/api/assistant/conversations/${CONVERSATION_ID}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "CF-Connecting-IP": "192.0.2.1",
            "User-Agent": "private-browser-agent",
            "X-Arbitrary": "drop-me",
          },
          body: JSON.stringify({
            clientMessageId: "message_request_1",
            role: "user",
            content: "Show me low-stock products",
            contextMarker: "admin:page",
          }),
        },
      ),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.has("x-agent-internal")).toBe(false);
    await expect(response.json()).resolves.toEqual({ success: true });
  });

  it("normalizes replay query parameters and strips arbitrary browser headers", async () => {
    const agentFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        `http://admin-agent.internal/internal/conversations/${CONVERSATION_ID}/events?after=7&limit=10`,
      );
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      const headers = new Headers(init?.headers);
      expect([...headers.entries()]).toEqual([
        ["accept", "application/json"],
        ["cookie", COOKIE],
      ]);
      return Response.json({ success: true });
    });
    mocks.cfEnv.ADMIN_AGENT = { fetch: agentFetch };

    const { proxyToAdminConversation } = await import("./$");
    const response = await proxyToAdminConversation(
      dashboardRequest(
        `/api/assistant/conversations/${CONVERSATION_ID}/events?limit=10&after=0007`,
        { headers: { "Last-Event-ID": "private", "X-Arbitrary": "drop-me" } },
      ),
    );

    expect(response.status).toBe(200);
    expect(agentFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "cancel",
      path: `/api/assistant/conversations/${CONVERSATION_ID}/cancel`,
      method: "POST",
      body: JSON.stringify({ clientRequestId: "cancel_1", runId: "run_1" }),
      target: `http://admin-agent.internal/internal/conversations/${CONVERSATION_ID}/cancel`,
    },
    {
      label: "delete",
      path: `/api/assistant/conversations/${CONVERSATION_ID}`,
      method: "DELETE",
      target: `http://admin-agent.internal/internal/conversations/${CONVERSATION_ID}`,
    },
  ])("forwards exact $label requests", async ({ path, method, body, target }) => {
    const agentFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(target);
      expect(init?.method).toBe(method);
      return Response.json({ success: true });
    });
    mocks.cfEnv.ADMIN_AGENT = { fetch: agentFetch };
    const { proxyToAdminConversation } = await import("./$");

    const response = await proxyToAdminConversation(
      dashboardRequest(path, {
        method,
        ...(body
          ? { headers: { "Content-Type": "application/json" }, body }
          : {}),
      }),
    );

    expect(response.status).toBe(200);
    expect(agentFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    `/api/assistant/conversations/conv_short/events`,
    `/api/assistant/conversations/${CONVERSATION_ID}/events/extra`,
    `/api/assistant/conversations/${CONVERSATION_ID}%2Fevents`,
    `/api/assistant/conversations/${CONVERSATION_ID}/events?unknown=1`,
    `/api/assistant/conversations/${CONVERSATION_ID}/events?after=1&after=2`,
    `/api/assistant/conversations/${CONVERSATION_ID}/events?after=-1`,
    `/api/assistant/conversations/${CONVERSATION_ID}/events?limit=101`,
    `/api/assistant/conversations/${CONVERSATION_ID}/messages?after=0`,
  ])("rejects non-exact route or query input: %s", async (path) => {
    const agentFetch = vi.fn();
    mocks.cfEnv.ADMIN_AGENT = { fetch: agentFetch };
    const { proxyToAdminConversation } = await import("./$");

    const response = await proxyToAdminConversation(
      dashboardRequest(path, {
        method: path.includes("/messages?") ? "POST" : "GET",
        ...(path.includes("/messages?")
          ? { headers: { "Content-Type": "application/json" }, body: "{}" }
          : {}),
      }),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(agentFetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "mismatched Origin",
      headers: { Origin: "https://evil.test", "Sec-Fetch-Site": "same-origin" },
    },
    {
      label: "cross-site browser metadata",
      headers: { Origin: DASHBOARD_ORIGIN, "Sec-Fetch-Site": "cross-site" },
    },
    {
      label: "opaque Origin",
      headers: { Origin: "null", "Sec-Fetch-Site": "same-origin" },
    },
  ])("rejects $label on conversation reads", async ({ headers }) => {
    const agentFetch = vi.fn();
    mocks.cfEnv.ADMIN_AGENT = { fetch: agentFetch };
    const { proxyToAdminConversation } = await import("./$");
    const response = await proxyToAdminConversation(
      dashboardRequest(
        `/api/assistant/conversations/${CONVERSATION_ID}/events`,
        { headers },
      ),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "CROSS_ORIGIN_CONVERSATION_REQUEST" },
    });
    expect(agentFetch).not.toHaveBeenCalled();
  });

  it.each(FORBIDDEN_HEADER_CASES)(
    "rejects identity and internal header injection",
    async (headers) => {
      const agentFetch = vi.fn();
      mocks.cfEnv.ADMIN_AGENT = { fetch: agentFetch };
      const { proxyToAdminConversation } = await import("./$");
      const response = await proxyToAdminConversation(
        dashboardRequest(
          `/api/assistant/conversations/${CONVERSATION_ID}/events`,
          { headers },
        ),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "CONVERSATION_HEADER_FORBIDDEN" },
      });
      expect(agentFetch).not.toHaveBeenCalled();
    },
  );

  it("advertises polling truthfully instead of attempting an unproven WebSocket upgrade", async () => {
    const agentFetch = vi.fn();
    mocks.cfEnv.ADMIN_AGENT = { fetch: agentFetch };
    const { proxyToAdminConversation } = await import("./$");
    const response = await proxyToAdminConversation(
      dashboardRequest(
        `/api/assistant/conversations/${CONVERSATION_ID}/stream`,
      ),
    );

    expect(response.status).toBe(501);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "CONVERSATION_STREAM_UNAVAILABLE" },
    });
    expect(agentFetch).not.toHaveBeenCalled();
  });

  it("requires a bounded dashboard cookie before contacting the Agent", async () => {
    const agentFetch = vi.fn();
    mocks.cfEnv.ADMIN_AGENT = { fetch: agentFetch };
    const { proxyToAdminConversation } = await import("./$");
    const response = await proxyToAdminConversation(
      new Request(
        `${DASHBOARD_ORIGIN}/api/assistant/conversations/${CONVERSATION_ID}/events`,
        { headers: { Origin: DASHBOARD_ORIGIN, "Sec-Fetch-Site": "same-origin" } },
      ),
    );

    expect(response.status).toBe(401);
    expect(agentFetch).not.toHaveBeenCalled();
  });

  it("rejects invalid write metadata before contacting the Agent", async () => {
    const agentFetch = vi.fn();
    mocks.cfEnv.ADMIN_AGENT = { fetch: agentFetch };
    const { proxyToAdminConversation } = await import("./$");
    const contentTypeResponse = await proxyToAdminConversation(
      dashboardRequest(
        `/api/assistant/conversations/${CONVERSATION_ID}/messages`,
        { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" },
      ),
    );
    const oversizedResponse = await proxyToAdminConversation(
      dashboardRequest(
        `/api/assistant/conversations/${CONVERSATION_ID}/cancel`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": "20000",
          },
          body: "{}",
        },
      ),
    );

    expect(contentTypeResponse.status).toBe(415);
    expect(oversizedResponse.status).toBe(413);
    expect(agentFetch).not.toHaveBeenCalled();
  });

  it("fails closed when the Agent binding is unavailable", async () => {
    const { proxyToAdminConversation } = await import("./$");
    const response = await proxyToAdminConversation(
      dashboardRequest(
        `/api/assistant/conversations/${CONVERSATION_ID}/events`,
      ),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "AGENT_BINDING_UNAVAILABLE" },
    });
  });

  it("fails closed when the Agent binding throws", async () => {
    mocks.cfEnv.ADMIN_AGENT = {
      fetch: vi.fn(async () => {
        throw new Error("agent unavailable");
      }),
    };
    const { proxyToAdminConversation } = await import("./$");
    const response = await proxyToAdminConversation(
      dashboardRequest(
        `/api/assistant/conversations/${CONVERSATION_ID}/events`,
      ),
    );

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "AGENT_CONVERSATION_PROXY_FAILED" },
    });
  });
});
