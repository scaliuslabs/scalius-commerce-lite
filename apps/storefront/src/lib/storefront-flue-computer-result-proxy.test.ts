// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  proxyStorefrontFlueComputerCancellation,
  proxyStorefrontFlueComputerResult,
  resolveStorefrontFlueComputerAuthority,
  type StorefrontFlueComputerAuthority,
  type StorefrontFlueComputerProxyDependencies,
} from "./storefront-flue-computer-result-proxy";

const NOW = 1_800_000_000_000;
const ORIGIN = "https://storefront.test";
const THREAD_ID = "conv_abcdefghijklmnopqrstuv";
const OTHER_THREAD_ID = "conv_zyxwvutsrqponmlkjihgfe";
const REQUEST_ID = "abcdefghijklmnopqrstuv";
const COOKIE_VALUE = `session_asst_${"s".repeat(43)}`;
const COOKIE = `scalius_storefront_assistant=${COOKIE_VALUE}`;
const TICKET = `${"a".repeat(80)}.${"b".repeat(43)}`;
const SERVICE_TOKEN = "storefront-flue-service-token-at-least-32-characters";
const INSTANCE_ID = `v1.${"c".repeat(43)}`;
const AUTHORITY: StorefrontFlueComputerAuthority = {
  surface: "storefront",
  tenantId: `tenant_${"t".repeat(43)}`,
  principalId: `principal_${"p".repeat(43)}`,
  threadId: THREAD_ID,
  instanceId: INSTANCE_ID,
  expiresAt: NOW + 60_000,
};
const RESULT = {
  ok: true,
  code: "OBSERVED",
  output: 'PAGE rev=r1 route="/products"',
  revision: "r1",
  changed: false,
};
const CROSS_ORIGIN_CASES: Array<[string, Record<string, string>]> = [
  ["cross-origin", { Origin: "https://evil.test" }],
  ["cross-site", { "Sec-Fetch-Site": "cross-site" }],
  ["opaque-origin", { Origin: "null" }],
];
const FORBIDDEN_HEADER_CASES: Array<Record<string, string>> = [
  { Authorization: "Bearer browser-must-not-control-this" },
  { "Proxy-Authorization": "Basic forged" },
  { "X-Scalius-Tenant-Id": "forged-tenant" },
  { "X-Scalius-Principal-Id": "forged-principal" },
  { "X-Scalius-Thread-Id": "forged-thread" },
];

function resultBody(overrides: Record<string, unknown> = {}) {
  return {
    surface: "storefront",
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
  init: {
    headers?: Record<string, string>;
    method?: string;
    rawBody?: string;
    routeThreadId?: string;
  } = {},
) {
  const headers = new Headers({
    Cookie: COOKIE,
    Origin: ORIGIN,
    "Sec-Fetch-Site": "same-origin",
    "Content-Type": "application/json",
    ...init.headers,
  });
  const threadId = init.routeThreadId ?? THREAD_ID;
  return new Request(
    `${ORIGIN}/api/assistant/conversations/${threadId}/computer/results`,
    {
      method: init.method ?? "POST",
      headers,
      body:
        init.method === "GET"
          ? undefined
          : (init.rawBody ?? JSON.stringify(body)),
    },
  );
}

function cancellationRequest() {
  const body = resultBody();
  return new Request(
    `${ORIGIN}/api/assistant/conversations/${THREAD_ID}/computer/cancel`,
    {
      method: "POST",
      headers: {
        Cookie: COOKIE,
        Origin: ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        surface: body.surface,
        threadId: body.threadId,
        requestId: body.requestId,
        ticket: body.ticket,
        program: body.program,
      }),
    },
  );
}

function dependencies(
  overrides: Partial<StorefrontFlueComputerProxyDependencies> = {},
): StorefrontFlueComputerProxyDependencies {
  return {
    agent: {
      fetch: vi.fn(async () =>
        Response.json(
          {
            accepted: true,
            authoritative: false,
            status: "queued_for_agent_interpretation",
            requestId: REQUEST_ID,
            dispatchId: "private-dispatch-id",
          },
          { status: 202 },
        ),
      ),
    },
    serviceToken: SERVICE_TOKEN,
    resolveAuthority: vi.fn(async () => ({
      ok: true as const,
      authority: AUTHORITY,
    })),
    now: () => NOW,
    ...overrides,
  };
}

function authorityEnvelope(
  authority: StorefrontFlueComputerAuthority = AUTHORITY,
) {
  return {
    success: true,
    data: {
      agent: authority,
    },
  };
}

describe("Storefront Flue computer result proxy", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards an exact signed cancellation and returns only first-winner acknowledgement", async () => {
    const agentFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        `http://storefront-flue-agent.internal/computer/cancel/${INSTANCE_ID}`,
      );
      await expect(new Response(init?.body).json()).resolves.toEqual({
        ticket: TICKET,
        program: "observe",
      });
      return Response.json({
        accepted: true,
        status: "cancelled",
        requestId: REQUEST_ID,
      }, { status: 202 });
    });
    const response = await proxyStorefrontFlueComputerCancellation(
      cancellationRequest(),
      dependencies({ agent: { fetch: agentFetch } }),
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      accepted: true,
      status: "cancelled",
      requestId: REQUEST_ID,
    });
  });

  it("fails closed while API authority or the Flue binding is absent", async () => {
    const noAuthority = await proxyStorefrontFlueComputerResult(request(), {
      agent: { fetch: vi.fn() },
      serviceToken: SERVICE_TOKEN,
      now: () => NOW,
    });
    expect(noAuthority.status).toBe(503);
    await expect(noAuthority.json()).resolves.toMatchObject({
      error: { code: "STOREFRONT_FLUE_AUTHORITY_UNAVAILABLE" },
    });

    const resolveAuthority = vi.fn(async () => ({
      ok: true as const,
      authority: AUTHORITY,
    }));
    const noAgent = await proxyStorefrontFlueComputerResult(request(), {
      resolveAuthority,
      serviceToken: SERVICE_TOKEN,
      now: () => NOW,
    });
    expect(noAgent.status).toBe(503);
    await expect(noAgent.json()).resolves.toMatchObject({
      error: { code: "STOREFRONT_FLUE_SERVICE_UNAVAILABLE" },
    });
    expect(resolveAuthority).toHaveBeenCalledOnce();
  });

  it("uses the API-owned admission envelope then forwards only server identity and bearer", async () => {
    const backendFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "http://api.internal/api/v1/internal/storefront-assistant/flue/admit",
        );
        expect(init?.method).toBe("POST");
        expect(init?.redirect).toBe("manual");
        expect([...new Headers(init?.headers).entries()]).toEqual([
          ["accept", "application/json"],
          ["content-type", "application/json"],
          ["cookie", COOKIE],
        ]);
        await expect(new Response(init?.body).json()).resolves.toEqual({
          threadId: THREAD_ID,
        });
        return Response.json(authorityEnvelope());
      },
    );
    const agentFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          `http://storefront-flue-agent.internal/computer/results/${INSTANCE_ID}`,
        );
        expect(init?.method).toBe("POST");
        expect(init?.redirect).toBe("manual");
        expect([...new Headers(init?.headers).entries()]).toEqual([
          ["accept", "application/json"],
          ["authorization", `Bearer ${SERVICE_TOKEN}`],
          ["content-type", "application/json"],
          ["x-scalius-principal-id", AUTHORITY.principalId],
          ["x-scalius-tenant-id", AUTHORITY.tenantId],
          ["x-scalius-thread-id", THREAD_ID],
        ]);
        await expect(new Response(init?.body).json()).resolves.toEqual({
          ticket: TICKET,
          program: "observe",
          result: RESULT,
        });
        return Response.json(
          {
            accepted: true,
            authoritative: false,
            status: "queued_for_agent_interpretation",
            requestId: REQUEST_ID,
            dispatchId: "must-not-leak",
          },
          { status: 202 },
        );
      },
    );

    const response = await proxyStorefrontFlueComputerResult(request(), {
      backend: { fetch: backendFetch },
      agent: { fetch: agentFetch },
      serviceToken: SERVICE_TOKEN,
      now: () => NOW,
    });

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      accepted: true,
      authoritative: false,
      status: "queued_for_agent_interpretation",
      requestId: REQUEST_ID,
    });
    expect(backendFetch).toHaveBeenCalledOnce();
    expect(agentFetch).toHaveBeenCalledOnce();
  });

  it("forwards the shared protocol's confirmation-required result instead of stranding the continuation", async () => {
    const agentFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      await expect(new Response(init?.body).json()).resolves.toMatchObject({
        result: {
          ok: false,
          code: "CONFIRMATION_REQUIRED",
          retryable: false,
        },
      });
      return Response.json(
        {
          accepted: true,
          authoritative: false,
          status: "queued_for_agent_interpretation",
          requestId: REQUEST_ID,
        },
        { status: 202 },
      );
    });

    const response = await proxyStorefrontFlueComputerResult(
      request(
        resultBody({
          result: {
            ok: false,
            code: "CONFIRMATION_REQUIRED",
            output: "Direct confirmation is required.",
            retryable: false,
          },
        }),
      ),
      dependencies({ agent: { fetch: agentFetch } }),
    );

    expect(response.status).toBe(202);
    expect(agentFetch).toHaveBeenCalledOnce();
  });

  it.each(CROSS_ORIGIN_CASES)(
    "rejects %s before authority resolution",
    async (_label, headers) => {
      const deps = dependencies();
      const response = await proxyStorefrontFlueComputerResult(
        request(resultBody(), { headers }),
        deps,
      );
      expect(response.status).toBe(403);
      expect(deps.resolveAuthority).not.toHaveBeenCalled();
      expect(deps.agent?.fetch).not.toHaveBeenCalled();
    },
  );

  it.each(FORBIDDEN_HEADER_CASES)(
    "rejects browser service or identity injection: %o",
    async (headers) => {
      const deps = dependencies();
      const response = await proxyStorefrontFlueComputerResult(
        request(resultBody(), { headers }),
        deps,
      );
      expect(response.status).toBe(400);
      expect(deps.resolveAuthority).not.toHaveBeenCalled();
      expect(deps.agent?.fetch).not.toHaveBeenCalled();
    },
  );

  it("requires the path-scoped HttpOnly session and exact thread/surface body", async () => {
    const missingCookie = dependencies();
    const missing = await proxyStorefrontFlueComputerResult(
      request(resultBody(), { headers: { Cookie: "" } }),
      missingCookie,
    );
    expect(missing.status).toBe(401);
    expect(missingCookie.resolveAuthority).not.toHaveBeenCalled();

    const crossThread = dependencies();
    const mismatched = await proxyStorefrontFlueComputerResult(
      request(resultBody(), { routeThreadId: OTHER_THREAD_ID }),
      crossThread,
    );
    expect(mismatched.status).toBe(400);
    expect(crossThread.resolveAuthority).not.toHaveBeenCalled();

    const crossSurface = dependencies();
    const surface = await proxyStorefrontFlueComputerResult(
      request(resultBody({ surface: "admin" })),
      crossSurface,
    );
    expect(surface.status).toBe(400);
    expect(crossSurface.resolveAuthority).not.toHaveBeenCalled();
  });

  it("rejects malformed, oversized, and stale-revision-shaped results before authority", async () => {
    const malformed = dependencies();
    const malformedResponse = await proxyStorefrontFlueComputerResult(
      request(resultBody({ secret: "unexpected" })),
      malformed,
    );
    expect(malformedResponse.status).toBe(400);
    expect(malformed.resolveAuthority).not.toHaveBeenCalled();

    const oversized = dependencies();
    const oversizedResponse = await proxyStorefrontFlueComputerResult(
      request(undefined, {
        rawBody: JSON.stringify({ padding: "x".repeat(50_000) }),
      }),
      oversized,
    );
    expect(oversizedResponse.status).toBe(413);
    expect(oversized.resolveAuthority).not.toHaveBeenCalled();

    const invalidRevision = dependencies();
    const revisionResponse = await proxyStorefrontFlueComputerResult(
      request(
        resultBody({
          result: { ...RESULT, revision: "r0" },
        }),
      ),
      invalidRevision,
    );
    expect(revisionResponse.status).toBe(400);
    expect(invalidRevision.resolveAuthority).not.toHaveBeenCalled();
  });

  it.each([
    ["unauthenticated", 401, "CONVERSATION_SESSION_REQUIRED"],
    ["forbidden", 403, "STOREFRONT_FLUE_THREAD_FORBIDDEN"],
    ["unavailable", 503, "STOREFRONT_FLUE_AUTHORITY_UNAVAILABLE"],
  ] as const)(
    "maps %s API admission without contacting Flue",
    async (reason, status, code) => {
      const deps = dependencies({
        resolveAuthority: vi.fn(async () => ({ ok: false as const, reason })),
      });
      const response = await proxyStorefrontFlueComputerResult(request(), deps);
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({
        error: { code },
      });
      expect(deps.agent?.fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects cross-thread and expired API authority without contacting Flue", async () => {
    const crossThread = dependencies({
      resolveAuthority: vi.fn(async () => ({
        ok: true as const,
        authority: { ...AUTHORITY, threadId: OTHER_THREAD_ID },
      })),
    });
    const crossResponse = await proxyStorefrontFlueComputerResult(
      request(),
      crossThread,
    );
    expect(crossResponse.status).toBe(503);
    expect(crossThread.agent?.fetch).not.toHaveBeenCalled();

    const expired = dependencies({
      resolveAuthority: vi.fn(async () => ({
        ok: true as const,
        authority: { ...AUTHORITY, expiresAt: NOW },
      })),
    });
    const expiredResponse = await proxyStorefrontFlueComputerResult(
      request(),
      expired,
    );
    expect(expiredResponse.status).toBe(503);
    expect(expired.agent?.fetch).not.toHaveBeenCalled();
  });

  it("never reports acceptance when Flue fails, returns 200, or mismatches the request", async () => {
    const failed = await proxyStorefrontFlueComputerResult(
      request(),
      dependencies({
        agent: {
          fetch: vi.fn(async () => {
            throw new Error("network failure");
          }),
        },
      }),
    );
    expect(failed.status).toBe(502);

    const wrongStatus = await proxyStorefrontFlueComputerResult(
      request(),
      dependencies({
        agent: {
          fetch: vi.fn(async () =>
            Response.json(
              {
                accepted: true,
                authoritative: false,
                status: "queued_for_agent_interpretation",
                requestId: REQUEST_ID,
              },
              { status: 200 },
            ),
          ),
        },
      }),
    );
    expect(wrongStatus.status).toBe(502);

    const mismatched = await proxyStorefrontFlueComputerResult(
      request(),
      dependencies({
        agent: {
          fetch: vi.fn(async () =>
            Response.json(
              {
                accepted: true,
                authoritative: false,
                status: "queued_for_agent_interpretation",
                requestId: "zyxwvutsrqponmlkjihgfe",
              },
              { status: 202 },
            ),
          ),
        },
      }),
    );
    expect(mismatched.status).toBe(502);
  });
});

describe("Storefront Flue API authority resolver", () => {
  it("maps invalid cookies and non-success API status without inventing identity", async () => {
    const backend = { fetch: vi.fn() };
    await expect(
      resolveStorefrontFlueComputerAuthority({
        backend,
        assistantCookie: "not-a-session",
        requestedThreadId: THREAD_ID,
        now: NOW,
      }),
    ).resolves.toEqual({ ok: false, reason: "unauthenticated" });
    expect(backend.fetch).not.toHaveBeenCalled();

    await expect(
      resolveStorefrontFlueComputerAuthority({
        backend: {
          fetch: vi.fn(async () =>
            Response.json(
              { success: false },
              {
                status: 401,
              },
            ),
          ),
        },
        assistantCookie: COOKIE,
        requestedThreadId: THREAD_ID,
        now: NOW,
      }),
    ).resolves.toEqual({ ok: false, reason: "unauthenticated" });
  });

  it("rejects authority envelopes that leak extra fields, rotate cookies, or are expired", async () => {
    const extraField = await resolveStorefrontFlueComputerAuthority({
      backend: {
        fetch: vi.fn(async () =>
          Response.json({
            ...authorityEnvelope(),
            subject: `storefront_subject_${"x".repeat(43)}`,
          }),
        ),
      },
      assistantCookie: COOKIE,
      requestedThreadId: THREAD_ID,
      now: NOW,
    });
    expect(extraField).toEqual({ ok: false, reason: "unavailable" });

    const rotatedCookie = await resolveStorefrontFlueComputerAuthority({
      backend: {
        fetch: vi.fn(async () =>
          Response.json(authorityEnvelope(), {
            headers: { "Set-Cookie": COOKIE },
          }),
        ),
      },
      assistantCookie: COOKIE,
      requestedThreadId: THREAD_ID,
      now: NOW,
    });
    expect(rotatedCookie).toEqual({ ok: false, reason: "unavailable" });

    const expired = await resolveStorefrontFlueComputerAuthority({
      backend: {
        fetch: vi.fn(async () =>
          Response.json(authorityEnvelope({ ...AUTHORITY, expiresAt: NOW })),
        ),
      },
      assistantCookie: COOKIE,
      requestedThreadId: THREAD_ID,
      now: NOW,
    });
    expect(expired).toEqual({ ok: false, reason: "unavailable" });
  });
});
