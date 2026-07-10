import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  proxyAdminFlueComputerResult,
  type AdminFlueComputerAuthority,
  type AdminFlueComputerProxyDependencies,
} from "./-result-proxy";

const ORIGIN = "https://dashboard.test";
const COOKIE = "better-auth.session_token=session.signature";
const THREAD_ID = "admin-thread-1";
const REQUEST_ID = "abcdefghijklmnopqrstuv";
const TICKET = `${"a".repeat(80)}.${"b".repeat(43)}`;
const SERVICE_TOKEN = "admin-flue-service-token-at-least-32-characters";
const INSTANCE_ID = `v1.${"c".repeat(43)}`;
const RESULT = {
  ok: true,
  code: "OBSERVED",
  output: 'PAGE rev=r1 route="/admin/products"',
  revision: "r1",
  changed: false,
};
const AUTHORITY: AdminFlueComputerAuthority = {
  surface: "admin",
  tenantId: "tenant_1",
  principalId: "user_1",
  threadId: THREAD_ID,
  instanceId: INSTANCE_ID,
};
const FORBIDDEN_HEADER_CASES: Array<Record<string, string>> = [
  { Authorization: "Bearer browser-must-not-control-this" },
  { "Proxy-Authorization": "Basic forged" },
  { "X-Scalius-Tenant-Id": "forged-tenant" },
  { "X-Scalius-Principal-Id": "forged-principal" },
  { "X-Scalius-Thread-Id": "forged-thread" },
];
const CROSS_ORIGIN_CASES: Array<[string, Record<string, string>]> = [
  ["cross-origin", { Origin: "https://evil.test", "Sec-Fetch-Site": "same-origin" }],
  ["cross-site", { Origin: ORIGIN, "Sec-Fetch-Site": "cross-site" }],
  ["opaque-origin", { Origin: "null", "Sec-Fetch-Site": "same-origin" }],
];

function resultBody(overrides: Record<string, unknown> = {}) {
  return {
    surface: "admin",
    threadId: THREAD_ID,
    requestId: REQUEST_ID,
    ticket: TICKET,
    program: "observe",
    result: RESULT,
    ...overrides,
  };
}

function request(
  body: unknown = resultBody(),
  init: { headers?: Record<string, string>; method?: string; rawBody?: string } = {},
) {
  const headers = new Headers({
    Cookie: COOKIE,
    Origin: ORIGIN,
    "Sec-Fetch-Site": "same-origin",
    "Content-Type": "application/json",
    ...init.headers,
  });
  return new Request(`${ORIGIN}/api/assistant/flue/computer/results`, {
    method: init.method ?? "POST",
    headers,
    body: init.method === "GET" ? undefined : (init.rawBody ?? JSON.stringify(body)),
  });
}

function dependencies(
  overrides: Partial<AdminFlueComputerProxyDependencies> = {},
): AdminFlueComputerProxyDependencies {
  return {
    agent: {
      fetch: vi.fn(async () => Response.json({
        accepted: true,
        authoritative: false,
        status: "queued_for_agent_interpretation",
        requestId: REQUEST_ID,
        dispatchId: "private-dispatch-id",
      }, { status: 202 })),
    },
    serviceToken: SERVICE_TOKEN,
    resolveAuthority: vi.fn(async () => ({ ok: true as const, authority: AUTHORITY })),
    ...overrides,
  };
}

describe("Admin Flue computer result proxy", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fails closed while API-owned tenant/thread authority is absent", async () => {
    const agentFetch = vi.fn();
    const response = await proxyAdminFlueComputerResult(request(), {
      agent: { fetch: agentFetch },
      serviceToken: SERVICE_TOKEN,
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "ADMIN_FLUE_AUTHORITY_UNAVAILABLE" },
    });
    expect(agentFetch).not.toHaveBeenCalled();
  });

  it("forwards only the exact server-resolved identity, bearer, instance, and bounded result", async () => {
    const agentFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        `http://admin-flue-agent.internal/computer/results/${INSTANCE_ID}`,
      );
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
      expect([...new Headers(init?.headers).entries()]).toEqual([
        ["accept", "application/json"],
        ["authorization", `Bearer ${SERVICE_TOKEN}`],
        ["content-type", "application/json"],
        ["x-scalius-principal-id", "user_1"],
        ["x-scalius-tenant-id", "tenant_1"],
        ["x-scalius-thread-id", THREAD_ID],
      ]);
      await expect(new Response(init?.body).json()).resolves.toEqual({
        ticket: TICKET,
        program: "observe",
        result: RESULT,
      });
      return Response.json({
        accepted: true,
        authoritative: false,
        status: "queued_for_agent_interpretation",
        requestId: REQUEST_ID,
        dispatchId: "must-not-leak",
      }, { status: 202 });
    });
    const resolveAuthority = vi.fn(async ({ requestedThreadId }: { requestedThreadId: string }) => {
      expect(requestedThreadId).toBe(THREAD_ID);
      return { ok: true as const, authority: AUTHORITY };
    });
    const response = await proxyAdminFlueComputerResult(request(), dependencies({
      agent: { fetch: agentFetch },
      resolveAuthority,
    }));

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      accepted: true,
      authoritative: false,
      status: "queued_for_agent_interpretation",
      requestId: REQUEST_ID,
    });
    expect(resolveAuthority).toHaveBeenCalledOnce();
    expect(agentFetch).toHaveBeenCalledOnce();
  });

  it.each(CROSS_ORIGIN_CASES)("rejects %s requests before authority resolution", async (_label, headers) => {
    const deps = dependencies();
    const response = await proxyAdminFlueComputerResult(request(resultBody(), { headers }), deps);
    expect(response.status).toBe(403);
    expect(deps.resolveAuthority).not.toHaveBeenCalled();
    expect(deps.agent?.fetch).not.toHaveBeenCalled();
  });

  it.each(FORBIDDEN_HEADER_CASES)("rejects browser service/identity header injection: %o", async (headers) => {
    const deps = dependencies();
    const response = await proxyAdminFlueComputerResult(request(resultBody(), { headers }), deps);
    expect(response.status).toBe(400);
    expect(deps.resolveAuthority).not.toHaveBeenCalled();
    expect(deps.agent?.fetch).not.toHaveBeenCalled();
  });

  it("rejects cross-surface and authority/thread mismatches", async () => {
    const crossSurface = dependencies();
    const surfaceResponse = await proxyAdminFlueComputerResult(
      request(resultBody({ surface: "storefront" })),
      crossSurface,
    );
    expect(surfaceResponse.status).toBe(400);
    expect(crossSurface.resolveAuthority).not.toHaveBeenCalled();

    const crossThread = dependencies({
      resolveAuthority: vi.fn(async () => ({
        ok: true as const,
        authority: { ...AUTHORITY, threadId: "another-thread" },
      })),
    });
    const threadResponse = await proxyAdminFlueComputerResult(request(), crossThread);
    expect(threadResponse.status).toBe(503);
    await expect(threadResponse.json()).resolves.toMatchObject({
      error: { code: "ADMIN_FLUE_AUTHORITY_INVALID" },
    });
    expect(crossThread.agent?.fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed and oversized results before authority or service work", async () => {
    const malformed = dependencies();
    const malformedResponse = await proxyAdminFlueComputerResult(
      request(resultBody({ secret: "unexpected" })),
      malformed,
    );
    expect(malformedResponse.status).toBe(400);
    expect(malformed.resolveAuthority).not.toHaveBeenCalled();

    const oversized = dependencies();
    const oversizedResponse = await proxyAdminFlueComputerResult(
      request(undefined, { rawBody: JSON.stringify({ padding: "x".repeat(21_000) }) }),
      oversized,
    );
    expect(oversizedResponse.status).toBe(413);
    expect(oversized.resolveAuthority).not.toHaveBeenCalled();
    expect(oversized.agent?.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["unauthenticated", 401, "ADMIN_SESSION_REQUIRED"],
    ["forbidden", 403, "ADMIN_FLUE_THREAD_FORBIDDEN"],
    ["unavailable", 503, "ADMIN_FLUE_AUTHORITY_UNAVAILABLE"],
  ] as const)("maps %s authority admission without contacting Flue", async (reason, status, code) => {
    const deps = dependencies({
      resolveAuthority: vi.fn(async () => ({ ok: false as const, reason })),
    });
    const response = await proxyAdminFlueComputerResult(request(), deps);
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(deps.agent?.fetch).not.toHaveBeenCalled();
  });

  it("never reports acceptance when the Flue post fails or returns a mismatched request", async () => {
    const failed = await proxyAdminFlueComputerResult(request(), dependencies({
      agent: { fetch: vi.fn(async () => { throw new Error("network failure"); }) },
    }));
    expect(failed.status).toBe(502);
    await expect(failed.json()).resolves.toMatchObject({
      error: { code: "ADMIN_FLUE_RESULT_PROXY_FAILED" },
    });

    const mismatched = await proxyAdminFlueComputerResult(request(), dependencies({
      agent: {
        fetch: vi.fn(async () => Response.json({
          accepted: true,
          authoritative: false,
          status: "queued_for_agent_interpretation",
          requestId: "zyxwvutsrqponmlkjihgfe",
        }, { status: 202 })),
      },
    }));
    expect(mismatched.status).toBe(502);
    await expect(mismatched.json()).resolves.toMatchObject({
      error: { code: "ADMIN_FLUE_RESULT_REJECTED" },
    });
  });
});
