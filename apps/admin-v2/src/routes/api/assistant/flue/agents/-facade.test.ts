import { describe, expect, it, vi } from "vitest";

import {
  proxyAdminFlueAgentFacade,
  type AdminFlueAgentFacadeDependencies,
} from "./-facade";

const ORIGIN = "https://dashboard.test";
const COOKIE = "better-auth.session_token=session.signature";
const THREAD_ID = "conv_abcdefghijklmnopqrstuv";
const INSTANCE_ID = `v1.${"i".repeat(43)}`;
const TENANT_ID = `tenant_${"t".repeat(43)}`;
const PRINCIPAL_ID = `principal_${"p".repeat(43)}`;
const SERVICE_TOKEN = "admin-flue-service-token-at-least-32-characters";
const PUBLIC_PATH =
  `/api/assistant/flue/agents/admin-copilot/${THREAD_ID}`;
const PRIVATE_PATH =
  `http://admin-flue-agent.internal/agents/admin-copilot/${INSTANCE_ID}`;
const AGENT_INTERNAL_ORIGIN_FOR_TEST = "http://admin-flue-agent.internal";

const AUTHORITY = {
  surface: "admin" as const,
  tenantId: TENANT_ID,
  principalId: PRINCIPAL_ID,
  threadId: THREAD_ID,
  instanceId: INSTANCE_ID,
};

function browserRequest(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("cookie")) headers.set("Cookie", COOKIE);
  if (!headers.has("origin")) headers.set("Origin", ORIGIN);
  if (!headers.has("sec-fetch-site")) {
    headers.set("Sec-Fetch-Site", "same-origin");
  }
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

function promptRequest(
  body: unknown = { message: "Take me to products" },
  headers: Record<string, string> = {},
): Request {
  return browserRequest(PUBLIC_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function dependencies(
  agentFetch: ReturnType<typeof vi.fn>,
  overrides: Partial<AdminFlueAgentFacadeDependencies> = {},
): AdminFlueAgentFacadeDependencies {
  return {
    agent: {
      fetch: agentFetch as unknown as Pick<Fetcher, "fetch">["fetch"],
    },
    serviceToken: SERVICE_TOKEN,
    resolveAuthority: vi.fn(async () => ({
      ok: true as const,
      authority: AUTHORITY,
    })),
    ...overrides,
  };
}

function sendAdmission(): Response {
  return Response.json(
    {
      streamUrl: `${PRIVATE_PATH}?must=not-leak`,
      offset: "12_34",
      submissionId: "1d5e9e9b-181f-44e2-9459-0a7e844785e4",
      internal: "discarded",
    },
    {
      status: 202,
      headers: {
        Location: PRIVATE_PATH,
        "Stream-Next-Offset": "12_34",
        "Set-Cookie": "internal=must-not-leak",
        "X-Internal-Instance": INSTANCE_ID,
      },
    },
  );
}

describe("Admin same-origin Flue agent facade", () => {
  it("admits a bounded text prompt with only server-resolved identity and rewrites the stream URL", async () => {
    const agentFetch = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      expect(String(input)).toBe(PRIVATE_PATH);
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
      expect([...new Headers(init?.headers).entries()]).toEqual([
        ["accept", "application/json"],
        ["authorization", `Bearer ${SERVICE_TOKEN}`],
        ["content-type", "application/json"],
        ["x-scalius-principal-id", PRINCIPAL_ID],
        ["x-scalius-tenant-id", TENANT_ID],
        ["x-scalius-thread-id", THREAD_ID],
      ]);
      await expect(new Response(init?.body).json()).resolves.toEqual({
        message: "Take me to products",
      });
      return sendAdmission();
    });
    const resolveAuthority = vi.fn(async (
      input: { request: Request; requestedThreadId: string },
    ) => {
      expect(input.request.headers.get("cookie")).toBe(COOKIE);
      expect(input.requestedThreadId).toBe(THREAD_ID);
      return { ok: true as const, authority: AUTHORITY };
    });

    const response = await proxyAdminFlueAgentFacade(
      promptRequest(),
      dependencies(agentFetch, { resolveAuthority }),
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("stream-next-offset")).toBe("12_34");
    expect(response.headers.has("location")).toBe(false);
    expect(response.headers.has("set-cookie")).toBe(false);
    const body = await response.json();
    expect(body).toEqual({
      streamUrl: `${ORIGIN}${PUBLIC_PATH}`,
      offset: "12_34",
      submissionId: "1d5e9e9b-181f-44e2-9459-0a7e844785e4",
    });
    expect(JSON.stringify(body)).not.toContain("internal");
    expect(JSON.stringify(body)).not.toContain(INSTANCE_ID);
    expect(resolveAuthority).toHaveBeenCalledOnce();
    expect(agentFetch).toHaveBeenCalledOnce();
  });

  it("streams history bytes and only the explicit Durable Streams response headers", async () => {
    const chunks = [
      '{"conversationId":"default","messages":[',
      '{"id":"m1","role":"assistant","parts":[]}],"offset":"7_8"}',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });
    const agentFetch = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      expect(String(input)).toBe(`${PRIVATE_PATH}?view=history`);
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      return new Response(body, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          ETag: '"safe-etag"',
          "Stream-Next-Offset": "7_8",
          "Stream-Up-To-Date": "true",
          "Stream-Cursor": "88",
          "Stream-Closed": "true",
          "Stream-SSE-Data-Encoding": "base64",
          Location: PRIVATE_PATH,
          "Set-Cookie": "private=must-not-leak",
          "X-Flue-Instance": INSTANCE_ID,
        },
      });
    });

    const response = await proxyAdminFlueAgentFacade(
      browserRequest(`${PUBLIC_PATH}?view=history`),
      dependencies(agentFetch),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(chunks.join(""));
    expect([...response.headers.entries()]).toEqual([
      ["cache-control", "no-store"],
      ["content-type", "application/json"],
      ["etag", '"safe-etag"'],
      ["stream-closed", "true"],
      ["stream-cursor", "88"],
      ["stream-next-offset", "7_8"],
      ["stream-sse-data-encoding", "base64"],
      ["stream-up-to-date", "true"],
    ]);
  });

  it("normalizes bounded updates queries and streams long-poll JSON", async () => {
    const agentFetch = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      expect(String(input)).toBe(
        `${PRIVATE_PATH}?view=updates&offset=opaque-v2%3A0007_0008&live=long-poll&cursor=cursor-v2%3Aabc`,
      );
      expect(new Headers(init?.headers).get("accept")).toBe("application/json");
      return new Response('[{"type":"message-completed"}]', {
        headers: {
          "Content-Type": "application/json",
          "Stream-Next-Offset": "9_10",
          "Stream-Up-To-Date": "true",
        },
      });
    });

    const response = await proxyAdminFlueAgentFacade(
      browserRequest(
        `${PUBLIC_PATH}?cursor=cursor-v2%3Aabc&live=long-poll&offset=opaque-v2%3A0007_0008&view=updates`,
      ),
      dependencies(agentFetch),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("stream-next-offset")).toBe("9_10");
    await expect(response.text()).resolves.toBe('[{"type":"message-completed"}]');
  });

  it("preserves an SSE body while keeping its connection cache policy", async () => {
    const sse = "event: control\ndata:{\"streamNextOffset\":\"9_10\"}\n\n";
    const agentFetch = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      expect(String(input)).toBe(
        `${PRIVATE_PATH}?view=updates&offset=9_10&live=sse`,
      );
      expect(new Headers(init?.headers).get("accept")).toBe("text/event-stream");
      return new Response(sse, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Set-Cookie": "never=forward",
        },
      });
    });

    const response = await proxyAdminFlueAgentFacade(
      browserRequest(`${PUBLIC_PATH}?view=updates&offset=9_10&live=sse`),
      dependencies(agentFetch),
    );

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.has("set-cookie")).toBe(false);
    await expect(response.text()).resolves.toBe(sse);
  });

  it("aborts the authorized opaque instance with no browser body or identity", async () => {
    const agentFetch = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      expect(String(input)).toBe(`${PRIVATE_PATH}/abort`);
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeUndefined();
      const headers = new Headers(init?.headers);
      expect(headers.get("content-type")).toBeNull();
      expect(headers.get("authorization")).toBe(`Bearer ${SERVICE_TOKEN}`);
      return Response.json(
        { aborted: true },
        { headers: { "Set-Cookie": "internal=never" } },
      );
    });

    const response = await proxyAdminFlueAgentFacade(
      browserRequest(`${PUBLIC_PATH}/abort`, { method: "POST" }),
      dependencies(agentFetch),
    );

    expect(response.status).toBe(200);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ aborted: true });
  });

  it.each([
    `${PUBLIC_PATH}`,
    `${PUBLIC_PATH}?view=updates`,
    `${PUBLIC_PATH}?view=updates&offset=1_2&tail=10`,
    `${PUBLIC_PATH}?view=updates&offset=1_2&offset=3_4`,
    `${PUBLIC_PATH}?view=updates&offset=1_2&live=forever`,
    `${PUBLIC_PATH}?view=updates&offset=1_2&cursor=has%20space`,
    `${PUBLIC_PATH}?view=history&offset=-1`,
    `${PUBLIC_PATH}?view=history&view=history`,
    `${PUBLIC_PATH}?view=unknown`,
  ])("rejects non-exact or unbounded read queries: %s", async (path) => {
    const agentFetch = vi.fn();
    const deps = dependencies(agentFetch);
    const response = await proxyAdminFlueAgentFacade(
      browserRequest(path),
      deps,
    );

    expect(response.status).toBe(404);
    expect(deps.resolveAuthority).not.toHaveBeenCalled();
    expect(agentFetch).not.toHaveBeenCalled();
  });

  it.each([
    "/api/assistant/flue/agents/shopping-assistant/conv_abcdefghijklmnopqrstuv?view=history",
    `/api/assistant/flue/agents/admin-copilot/conv_short?view=history`,
    `${PUBLIC_PATH}/attachments/file-1`,
    `${PUBLIC_PATH}/extra`,
    `/api/assistant/flue/agents/admin-copilot/${THREAD_ID}%2Fabort`,
  ])("rejects arbitrary agents and subpaths: %s", async (path) => {
    const agentFetch = vi.fn();
    const response = await proxyAdminFlueAgentFacade(
      browserRequest(path),
      dependencies(agentFetch),
    );
    expect(response.status).toBe(404);
    expect(agentFetch).not.toHaveBeenCalled();
  });

  it("rejects unsupported methods and bodies on bodyless endpoints", async () => {
    const agentFetch = vi.fn();
    const deps = dependencies(agentFetch);
    const methodResponse = await proxyAdminFlueAgentFacade(
      browserRequest(`${PUBLIC_PATH}?view=history`, { method: "PUT" }),
      deps,
    );
    const bodyResponse = await proxyAdminFlueAgentFacade(
      browserRequest(`${PUBLIC_PATH}/abort`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
      deps,
    );

    expect(methodResponse.status).toBe(405);
    expect(methodResponse.headers.get("allow")).toBe("GET, POST");
    expect(bodyResponse.status).toBe(400);
    expect(agentFetch).not.toHaveBeenCalled();
  });

  it.each([
    [{ message: "" }, undefined, 400],
    [{ message: "hello", images: [] }, undefined, 400],
    [{ message: "hello", attachments: [] }, undefined, 400],
    [{ message: "x".repeat(8_001) }, undefined, 400],
    ["{malformed", undefined, 400],
    [{ message: "hello" }, { "Content-Type": "text/plain" }, 415],
  ] as const)("rejects malformed prompt input %#", async (body, headers, status) => {
    const agentFetch = vi.fn();
    const deps = dependencies(agentFetch);
    const response = await proxyAdminFlueAgentFacade(
      promptRequest(body, headers ?? {}),
      deps,
    );

    expect(response.status).toBe(status);
    expect(deps.resolveAuthority).not.toHaveBeenCalled();
    expect(agentFetch).not.toHaveBeenCalled();
  });

  it("reads and rejects an oversized chunked prompt before authority resolution", async () => {
    const agentFetch = vi.fn();
    const deps = dependencies(agentFetch);
    const response = await proxyAdminFlueAgentFacade(
      promptRequest({ message: "x".repeat(13_000) }),
      deps,
    );

    expect(response.status).toBe(413);
    expect(deps.resolveAuthority).not.toHaveBeenCalled();
    expect(agentFetch).not.toHaveBeenCalled();
  });

  it.each([
    { Origin: "https://evil.test", "Sec-Fetch-Site": "same-origin" },
    { Origin: ORIGIN, "Sec-Fetch-Site": "cross-site" },
    { Origin: "null", "Sec-Fetch-Site": "same-origin" },
  ])("rejects cross-origin cookie requests: %o", async (headers) => {
    const agentFetch = vi.fn();
    const deps = dependencies(agentFetch);
    const response = await proxyAdminFlueAgentFacade(
      browserRequest(`${PUBLIC_PATH}?view=history`, {
        headers: headers as unknown as Record<string, string>,
      }),
      deps,
    );

    expect(response.status).toBe(403);
    expect(deps.resolveAuthority).not.toHaveBeenCalled();
    expect(agentFetch).not.toHaveBeenCalled();
  });

  it.each([
    { Authorization: "Bearer browser-controlled" },
    { "Proxy-Authorization": "Basic browser-controlled" },
    { "X-Scalius-Tenant-Id": "forged" },
    { "X-Scalius-Principal-Id": "forged" },
    { "X-Scalius-Thread-Id": "forged" },
  ])("rejects client service/identity header injection: %o", async (headers) => {
    const agentFetch = vi.fn();
    const deps = dependencies(agentFetch);
    const response = await proxyAdminFlueAgentFacade(
      browserRequest(`${PUBLIC_PATH}?view=history`, {
        headers: headers as unknown as Record<string, string>,
      }),
      deps,
    );

    expect(response.status).toBe(400);
    expect(deps.resolveAuthority).not.toHaveBeenCalled();
    expect(agentFetch).not.toHaveBeenCalled();
  });

  it("requires a bounded dashboard cookie before authority resolution", async () => {
    const agentFetch = vi.fn();
    const deps = dependencies(agentFetch);
    const missingCookie = await proxyAdminFlueAgentFacade(
      new Request(`${ORIGIN}${PUBLIC_PATH}?view=history`, {
        headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
      }),
      deps,
    );
    const oversizedCookie = await proxyAdminFlueAgentFacade(
      browserRequest(`${PUBLIC_PATH}?view=history`, {
        headers: { Cookie: `session=${"x".repeat(8_193)}` },
      }),
      deps,
    );

    expect(missingCookie.status).toBe(401);
    expect(oversizedCookie.status).toBe(431);
    expect(deps.resolveAuthority).not.toHaveBeenCalled();
    expect(agentFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["unauthenticated", 401, "ADMIN_SESSION_REQUIRED"],
    ["forbidden", 403, "ADMIN_FLUE_THREAD_FORBIDDEN"],
    ["unavailable", 503, "ADMIN_FLUE_AUTHORITY_UNAVAILABLE"],
  ] as const)("maps %s authority failures without contacting Flue", async (
    reason,
    status,
    code,
  ) => {
    const agentFetch = vi.fn();
    const response = await proxyAdminFlueAgentFacade(
      browserRequest(`${PUBLIC_PATH}?view=history`),
      dependencies(agentFetch, {
        resolveAuthority: vi.fn(async () => ({ ok: false as const, reason })),
      }),
    );

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(agentFetch).not.toHaveBeenCalled();
  });

  it("fails closed for absent authority, invalid authority, binding, or token", async () => {
    const agentFetch = vi.fn();
    const request = () => browserRequest(`${PUBLIC_PATH}?view=history`);
    const noAuthority = await proxyAdminFlueAgentFacade(request(), {
      agent: { fetch: agentFetch },
      serviceToken: SERVICE_TOKEN,
    });
    const invalidAuthority = await proxyAdminFlueAgentFacade(
      request(),
      dependencies(agentFetch, {
        resolveAuthority: vi.fn(async () => ({
          ok: true as const,
          authority: { ...AUTHORITY, instanceId: "browser-thread-id" },
        })),
      }),
    );
    const noBinding = await proxyAdminFlueAgentFacade(request(), {
      serviceToken: SERVICE_TOKEN,
      resolveAuthority: vi.fn(async () => ({
        ok: true as const,
        authority: AUTHORITY,
      })),
    });
    const shortToken = await proxyAdminFlueAgentFacade(
      request(),
      dependencies(agentFetch, { serviceToken: "short" }),
    );

    expect(noAuthority.status).toBe(503);
    expect(invalidAuthority.status).toBe(503);
    expect(noBinding.status).toBe(503);
    expect(shortToken.status).toBe(503);
    expect(agentFetch).not.toHaveBeenCalled();
  });

  it("rejects redirects, invalid admissions, and sanitized upstream errors", async () => {
    const redirect = await proxyAdminFlueAgentFacade(
      browserRequest(`${PUBLIC_PATH}?view=history`),
      dependencies(vi.fn(async () => new Response(null, {
        status: 302,
        headers: { Location: PRIVATE_PATH },
      }))),
    );
    const invalidAdmission = await proxyAdminFlueAgentFacade(
      promptRequest(),
      dependencies(vi.fn(async () => Response.json({
        streamUrl: PRIVATE_PATH,
        offset: "12_34",
        submissionId: "valid-id",
      }, {
        status: 202,
        headers: { "Stream-Next-Offset": "99_99" },
      }))),
    );
    const rejected = await proxyAdminFlueAgentFacade(
      browserRequest(`${PUBLIC_PATH}?view=history`),
      dependencies(vi.fn(async () => Response.json({
        error: `instance ${INSTANCE_ID} at ${AGENT_INTERNAL_ORIGIN_FOR_TEST}`,
      }, {
        status: 503,
        headers: { "Set-Cookie": "internal=never" },
      }))),
    );

    expect(redirect.status).toBe(502);
    expect(redirect.headers.has("location")).toBe(false);
    expect(invalidAdmission.status).toBe(502);
    expect(rejected.status).toBe(503);
    expect(rejected.headers.has("set-cookie")).toBe(false);
    const rejectedText = await rejected.text();
    expect(rejectedText).not.toContain(INSTANCE_ID);
    expect(rejectedText).not.toContain("admin-flue-agent.internal");
  });

  it("returns a sanitized proxy error when the service binding throws", async () => {
    const response = await proxyAdminFlueAgentFacade(
      browserRequest(`${PUBLIC_PATH}?view=history`),
      dependencies(vi.fn(async () => {
        throw new Error(`private ${INSTANCE_ID}`);
      })),
    );

    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain(INSTANCE_ID);
  });
});
