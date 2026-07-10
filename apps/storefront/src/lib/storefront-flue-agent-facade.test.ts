// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { createStorefrontCanaryApp } from "../../../storefront-agent-flue/src/app";
import { createThreadInstanceId } from "../../../storefront-agent-flue/src/thread-identity";

import {
  proxyStorefrontFlueAgentFacade,
  type StorefrontFlueAgentFacadeDependencies,
} from "./storefront-flue-agent-facade";

const ORIGIN = "https://store.example.test";
const THREAD_ID = "conv_abcdefghijklmnopqrstuv";
const OTHER_THREAD_ID = "conv_zyxwvutsrqponmlkjihgfe";
const INSTANCE_ID = `v1.${"i".repeat(43)}`;
const TENANT_ID = `tenant_${"t".repeat(43)}`;
const PRINCIPAL_ID = `principal_${"p".repeat(43)}`;
const CREDENTIAL = `session_asst_${"c".repeat(43)}`;
const ASSISTANT_COOKIE = `scalius_storefront_assistant=${CREDENTIAL}`;
const SET_COOKIE = `${ASSISTANT_COOKIE}; Max-Age=28800; Path=/api/assistant/conversations/${THREAD_ID}; HttpOnly; SameSite=Lax; Secure`;
const SERVICE_TOKEN = "storefront-flue-service-token-at-least-32-characters";
const PUBLIC_PATH = `/api/assistant/conversations/${THREAD_ID}/flue/agents/shopping-assistant/${THREAD_ID}`;
const READINESS_PATH = `/api/assistant/conversations/${THREAD_ID}/flue/readyz`;
const PRIVATE_PATH = `http://storefront-flue-agent.internal/agents/shopping-assistant/${INSTANCE_ID}`;
const NOW = 1_800_000_000_000;

const AUTHORITY = {
  surface: "storefront" as const,
  tenantId: TENANT_ID,
  principalId: PRINCIPAL_ID,
  threadId: THREAD_ID,
  instanceId: INSTANCE_ID,
  expiresAt: NOW + 60_000,
};

function browserRequest(
  suffix = "?view=history",
  init: RequestInit = {},
  cookie: string | null = ASSISTANT_COOKIE,
): Request {
  const headers = new Headers(init.headers);
  if (cookie && headers.get("cookie") === null) headers.set("Cookie", cookie);
  if (headers.get("origin") === null) headers.set("Origin", ORIGIN);
  if (headers.get("sec-fetch-site") === null) {
    headers.set("Sec-Fetch-Site", "same-origin");
  }
  if (headers.get("cf-connecting-ip") === null) {
    headers.set("CF-Connecting-IP", "203.0.113.9");
  }
  return new Request(`${ORIGIN}${PUBLIC_PATH}${suffix}`, {
    ...init,
    headers,
  });
}

function readinessRequest(cookie: string | null = ASSISTANT_COOKIE): Request {
  const request = browserRequest("?view=history", {}, cookie);
  return new Request(`${ORIGIN}${READINESS_PATH}`, {
    headers: request.headers,
  });
}

function dependencies(
  overrides: Partial<StorefrontFlueAgentFacadeDependencies> = {},
): StorefrontFlueAgentFacadeDependencies {
  return {
    backend: {
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/admission/begin")) {
          return Response.json({
            success: true,
            data: {
              status: "started",
              admissionId: "a".repeat(22),
              admissionClaimToken: "c".repeat(43),
              generation: 1_800_000_000_001,
            },
          });
        }
        if (path.endsWith("/stop/begin") || path.endsWith("/stop/status")) {
          return Response.json({
            success: true,
            data: {
              status: "ready",
              stoppedThroughIssuedAtMs: 1_800_000_000_002,
              pendingAdmissions: 0,
              pendingDispatches: 0,
            },
          });
        }
        return Response.json({ success: true, data: { status: "finished" } });
      }),
    },
    agent: {
      fetch: vi.fn(async () =>
        Response.json({
          v: 1,
          conversationId: "default",
          offset: "offset-1",
          messages: [],
          settlements: [],
        }),
      ),
    },
    serviceToken: SERVICE_TOKEN,
    resolveAuthority: vi.fn(async () => ({
      ok: true as const,
      authority: AUTHORITY,
    })),
    ...overrides,
  };
}

describe("Storefront Flue agent facade", () => {
  it("proves the facade token and API-signed instance against Flue without model work", async () => {
    const threadKey = "facade-readiness-thread-key-at-least-32-bytes";
    const computerKey = "facade-readiness-computer-key-at-least-32-bytes";
    const readinessApp = createStorefrontCanaryApp({
      recordAuthorizationFailure: () => undefined,
    });
    const readinessEnv = {
      CANARY_AUTH_TOKEN: SERVICE_TOKEN,
      THREAD_ID_SIGNING_KEY: threadKey,
      COMPUTER_TICKET_SIGNING_KEY: computerKey,
      API: { fetch: async () => new Response(null, { status: 204 }) },
    };
    const signedInstance = await createThreadInstanceId(
      "storefront",
      {
        tenantId: TENANT_ID,
        principalId: PRINCIPAL_ID,
        threadId: THREAD_ID,
      },
      threadKey,
    );
    const agent = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
        readinessApp.request(new Request(input, init), undefined, readinessEnv),
    };
    const authority = { ...AUTHORITY, instanceId: signedInstance };

    const ready = await proxyStorefrontFlueAgentFacade(
      readinessRequest(),
      dependencies({
        agent,
        resolveAuthority: async () => ({ ok: true, authority }),
      }),
    );
    expect(ready.status).toBe(200);
    expect(ready.headers.get("cache-control")).toBe("no-store");
    await expect(ready.json()).resolves.toEqual({
      ok: true,
      endToEnd: true,
      readiness: "facade_authenticated",
    });

    const wrongToken = await proxyStorefrontFlueAgentFacade(
      readinessRequest(),
      dependencies({
        agent,
        serviceToken: "wrong-but-valid-length-storefront-service-token-value",
        resolveAuthority: async () => ({ ok: true, authority }),
      }),
    );
    expect(wrongToken.status).toBe(503);
    await expect(wrongToken.json()).resolves.toMatchObject({
      error: { code: "STOREFRONT_FLUE_NOT_READY" },
    });

    const wrongSignature = await createThreadInstanceId(
      "storefront",
      {
        tenantId: TENANT_ID,
        principalId: PRINCIPAL_ID,
        threadId: THREAD_ID,
      },
      "wrong-but-valid-length-api-signing-key-value",
    );
    const wrongInstance = await proxyStorefrontFlueAgentFacade(
      readinessRequest(),
      dependencies({
        agent,
        resolveAuthority: async () => ({
          ok: true,
          authority: { ...AUTHORITY, instanceId: wrongSignature },
        }),
      }),
    );
    expect(wrongInstance.status).toBe(503);
    await expect(wrongInstance.json()).resolves.toMatchObject({
      error: { code: "STOREFRONT_FLUE_NOT_READY" },
    });
  });

  it("bootstraps the HttpOnly session, admits through API authority, and forwards only server-owned identity", async () => {
    const backendFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/session/create")) {
          const headers = new Headers(init?.headers);
          expect(headers.get("accept")).toBe("application/json");
          expect(headers.get("content-type")).toBe("application/json");
          expect(headers.get("x-scalius-storefront-client-ip")).toBe(
            "203.0.113.9",
          );
          expect([...headers.keys()]).toHaveLength(3);
          await expect(new Response(init?.body).json()).resolves.toEqual({
            conversationId: THREAD_ID,
          });
          return Response.json(
            {
              success: true,
              data: {
                subject: `storefront_subject_${"s".repeat(43)}`,
                audience: "scalius-storefront-browser-v1",
                conversationId: THREAD_ID,
                session: {
                  status: "active",
                  expiresAt: NOW + 60_000,
                  lastSeenAt: NOW,
                },
                replayed: false,
              },
            },
            { headers: { "Set-Cookie": SET_COOKIE } },
          );
        }
        expect(String(input)).toBe(
          "http://api.internal/api/v1/internal/storefront-assistant/flue/admit",
        );
        const headers = new Headers(init?.headers);
        expect(headers.get("accept")).toBe("application/json");
        expect(headers.get("content-type")).toBe("application/json");
        expect(headers.get("cookie")).toBe(ASSISTANT_COOKIE);
        expect([...headers.keys()]).toHaveLength(3);
        await expect(new Response(init?.body).json()).resolves.toEqual({
          threadId: THREAD_ID,
        });
        return Response.json({
          success: true,
          data: { agent: AUTHORITY },
        });
      },
    );
    const agentFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(`${PRIVATE_PATH}?view=history`);
        expect(init?.method).toBe("GET");
        expect(init?.redirect).toBe("manual");
        const headers = new Headers(init?.headers);
        expect(headers.get("accept")).toBe("application/json");
        expect(headers.get("authorization")).toBe(`Bearer ${SERVICE_TOKEN}`);
        expect(headers.get("x-scalius-principal-id")).toBe(PRINCIPAL_ID);
        expect(headers.get("x-scalius-tenant-id")).toBe(TENANT_ID);
        expect(headers.get("x-scalius-thread-id")).toBe(THREAD_ID);
        expect([...headers.keys()]).toHaveLength(5);
        return Response.json({
          v: 1,
          conversationId: "default",
          offset: "offset-1",
          messages: [],
          settlements: [],
        });
      },
    );

    const response = await proxyStorefrontFlueAgentFacade(
      browserRequest("?view=history", {}, null),
      {
        backend: { fetch: backendFetch },
        agent: { fetch: agentFetch },
        serviceToken: SERVICE_TOKEN,
        now: () => NOW,
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBe(SET_COOKIE);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(backendFetch).toHaveBeenCalledTimes(2);
    expect(agentFetch).toHaveBeenCalledOnce();
  });

  it("rewrites send admission to the same-origin cookie-scoped SDK stream", async () => {
    const agentFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(PRIVATE_PATH);
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("content-type")).toBe(
          "application/json",
        );
        expect(
          new Headers(init?.headers).get("x-flue-admission-generation"),
        ).toBe("1800000000001");
        await expect(new Response(init?.body).json()).resolves.toEqual({
          message: "Show me shoes",
        });
        return Response.json(
          {
            streamUrl: `${PRIVATE_PATH}?private=true`,
            offset: "opaque.offset:1",
            submissionId: "submission_1",
          },
          {
            status: 202,
            headers: { "Stream-Next-Offset": "opaque.offset:1" },
          },
        );
      },
    );
    const request = browserRequest("", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Show me shoes" }),
    });
    expect(request.headers.get("cookie")).toBe(ASSISTANT_COOKIE);
    const response = await proxyStorefrontFlueAgentFacade(
      request,
      dependencies({ agent: { fetch: agentFetch } }),
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("stream-next-offset")).toBe("opaque.offset:1");
    await expect(response.json()).resolves.toEqual({
      streamUrl: `${ORIGIN}${PUBLIC_PATH}`,
      offset: "opaque.offset:1",
      submissionId: "submission_1",
    });
  });

  it("preserves opaque Durable Streams coordinates and strips private headers", async () => {
    const privateHeaders = new Headers({
      "Content-Type": "application/json",
      "Cache-Control": "private",
      "Stream-Next-Offset": "opaque:next.value",
      "Stream-Cursor": "opaque:cursor.value",
      "Set-Cookie": "private=leak",
      "X-Internal-Identity": "secret",
    });
    const agentFetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(
        `${PRIVATE_PATH}?view=updates&offset=opaque%3Astart.value&live=long-poll&cursor=opaque%3Acursor.value`,
      );
      return new Response("[]", { status: 200, headers: privateHeaders });
    });
    const response = await proxyStorefrontFlueAgentFacade(
      browserRequest(
        "?view=updates&offset=opaque%3Astart.value&live=long-poll&cursor=opaque%3Acursor.value",
      ),
      dependencies({ agent: { fetch: agentFetch } }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("stream-next-offset")).toBe(
      "opaque:next.value",
    );
    expect(response.headers.get("stream-cursor")).toBe("opaque:cursor.value");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.has("x-internal-identity")).toBe(false);
    await expect(response.text()).resolves.toBe("[]");
  });

  it("records abort intent without accepting a body or creating a missing session", async () => {
    const agentFetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`${PRIVATE_PATH}/abort`);
      return Response.json({ aborted: true });
    });
    const admitted = await proxyStorefrontFlueAgentFacade(
      browserRequest("/abort", { method: "POST" }),
      dependencies({ agent: { fetch: agentFetch } }),
    );
    expect(admitted.status).toBe(200);
    await expect(admitted.json()).resolves.toEqual({ aborted: true });

    const missing = await proxyStorefrontFlueAgentFacade(
      browserRequest("/abort", { method: "POST" }, null),
      dependencies({ agent: { fetch: agentFetch } }),
    );
    expect(missing.status).toBe(401);
    expect(agentFetch).toHaveBeenCalledOnce();
  });

  it("fences a delayed prompt before one abort, then reconciles and unlocks", async () => {
    const events: string[] = [];
    let releasePrompt: ((response: Response) => void) | undefined;
    const backend = {
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        events.push(path.split("/flue/")[1] ?? path);
        if (path.endsWith("/admission/begin")) {
          return Response.json({
            success: true,
            data: {
              status: "started",
              admissionId: "a".repeat(22),
              admissionClaimToken: "c".repeat(43),
              generation: 101,
            },
          });
        }
        if (path.endsWith("/stop/begin")) {
          return Response.json({
            success: true,
            data: {
              status: "pending",
              stoppedThroughIssuedAtMs: 102,
              pendingAdmissions: 1,
              pendingDispatches: 0,
            },
          });
        }
        if (path.endsWith("/stop/status")) {
          return Response.json({
            success: true,
            data: {
              status: "ready",
              stoppedThroughIssuedAtMs: 102,
              pendingAdmissions: 0,
              pendingDispatches: 0,
            },
          });
        }
        return Response.json({ success: true, data: { status: "finished" } });
      }),
    };
    const agent = {
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/abort")) {
          events.push("agent-abort");
          expect(
            new Headers(init?.headers).get("x-flue-abort-through-generation"),
          ).toBe("102");
          return Response.json({ aborted: true });
        }
        events.push("agent-prompt");
        expect(
          new Headers(init?.headers).get("x-flue-admission-generation"),
        ).toBe("101");
        return await new Promise<Response>((resolve) => {
          releasePrompt = resolve;
        });
      }),
    };
    const deps = dependencies({ backend, agent });
    const delayedPrompt = proxyStorefrontFlueAgentFacade(
      browserRequest("", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Show delayed products" }),
      }),
      deps,
    );
    await vi.waitFor(() => expect(releasePrompt).toBeTypeOf("function"));

    const stopped = await proxyStorefrontFlueAgentFacade(
      browserRequest("/abort", { method: "POST" }),
      deps,
    );
    expect(stopped.status).toBe(200);
    expect(events.indexOf("stop/begin")).toBeLessThan(
      events.indexOf("agent-abort"),
    );
    expect(events.indexOf("agent-abort")).toBeLessThan(
      events.indexOf("stop/reconcile"),
    );

    releasePrompt?.(Response.json({
      streamUrl: PRIVATE_PATH,
      offset: "late-offset",
      submissionId: "late-submission",
    }, { status: 202 }));
    const delayedResponse = await delayedPrompt;
    expect(delayedResponse.status).toBe(202);
    expect(events).toContain("admission/finish");
    expect(events.at(-1)).toBe("admission/finish");
  });

  it("retains a newly bootstrapped cookie when a new Flue instance is absent", async () => {
    const response = await proxyStorefrontFlueAgentFacade(
      browserRequest("?view=history", {}, null),
      dependencies({
        bootstrapSession: vi.fn(async () => ({
          assistantCookie: ASSISTANT_COOKIE,
          setCookie: SET_COOKIE,
        })),
        agent: {
          fetch: vi.fn(async () => new Response(null, { status: 404 })),
        },
      }),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("set-cookie")).toBe(SET_COOKIE);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "STOREFRONT_FLUE_SERVICE_REJECTED" },
    });
  });

  it("accepts the maximum UI prompt without an 8 KiB serialization regression", async () => {
    const message = "\\".repeat(2_000);
    const agentFetch = vi.fn(async () =>
      Response.json(
        {
          streamUrl: PRIVATE_PATH,
          offset: "next",
          submissionId: "submission_max",
        },
        { status: 202 },
      ),
    );
    const response = await proxyStorefrontFlueAgentFacade(
      browserRequest("", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      }),
      dependencies({ agent: { fetch: agentFetch } }),
    );
    expect(response.status).toBe(202);
    expect(agentFetch).toHaveBeenCalledOnce();
  });

  it.each([
    ["cross origin", { Origin: "https://evil.test" }, 403],
    ["cross site", { "Sec-Fetch-Site": "cross-site" }, 403],
    ["forged bearer", { Authorization: "Bearer browser" }, 400],
    ["forged tenant", { "X-Scalius-Tenant-Id": "tenant_browser" }, 400],
  ])(
    "rejects %s before authority or Agent work",
    async (_label, headers, status) => {
      const resolveAuthority = vi.fn();
      const agentFetch = vi.fn();
      const response = await proxyStorefrontFlueAgentFacade(
        browserRequest("?view=history", { headers }),
        dependencies({
          resolveAuthority,
          agent: { fetch: agentFetch },
        }),
      );
      expect(response.status).toBe(status);
      expect(resolveAuthority).not.toHaveBeenCalled();
      expect(agentFetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    `/api/assistant/conversations/${THREAD_ID}/flue/agents/shopping-assistant/${OTHER_THREAD_ID}?view=history`,
    `/api/assistant/conversations/${THREAD_ID}/flue/agents/admin-copilot/${THREAD_ID}?view=history`,
    `${PUBLIC_PATH}?view=history&offset=-1`,
    `${PUBLIC_PATH}?view=updates&offset=opaque&offset=duplicate`,
    `${PUBLIC_PATH}?view=updates&offset=opaque%26injected`,
  ])("rejects mismatched or expanded SDK route %s", async (path) => {
    const response = await proxyStorefrontFlueAgentFacade(
      new Request(`${ORIGIN}${path}`, {
        headers: {
          Cookie: ASSISTANT_COOKIE,
          Origin: ORIGIN,
          "Sec-Fetch-Site": "same-origin",
        },
      }),
      dependencies(),
    );
    expect(response.status).toBe(404);
  });

  it("fails closed on missing authority, service configuration, and malformed Agent admission", async () => {
    const noAuthority = await proxyStorefrontFlueAgentFacade(
      browserRequest(),
      {},
    );
    expect(noAuthority.status).toBe(503);

    const noAgent = await proxyStorefrontFlueAgentFacade(
      browserRequest(),
      dependencies({ agent: undefined }),
    );
    expect(noAgent.status).toBe(503);

    const malformed = await proxyStorefrontFlueAgentFacade(
      browserRequest("", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Hello" }),
      }),
      dependencies({
        agent: {
          fetch: vi.fn(async () =>
            Response.json(
              {
                streamUrl: "http://private.invalid",
                offset: "bad&offset",
                submissionId: "submission_1",
              },
              { status: 202 },
            ),
          ),
        },
      }),
    );
    expect(malformed.status).toBe(502);
  });
});
