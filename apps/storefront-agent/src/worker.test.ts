import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    protected ctx: DurableObjectState;
    protected env: unknown;

    constructor(ctx: DurableObjectState, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import worker from "./worker";

describe("Storefront Agent Worker entrypoint", () => {
  it("reports the dedicated public identity", async () => {
    const response = await worker.fetch(
      new Request("https://storefront-agent.example.test/health"),
      testEnv(),
      executionContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      success: true,
      status: "ok",
      service: "scalius-storefront-agent",
    });
  });

  it("owns no Admin route or Admin API preflight", async () => {
    const apiFetch = vi.fn<Fetcher["fetch"]>();
    const response = await worker.fetch(
      new Request("https://storefront-agent.example.test/mcp/admin", {
        method: "POST",
        headers: { Cookie: "better-auth.session_token=must-not-be-read" },
      }),
      testEnv(apiFetch),
      executionContext(),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      success: false,
      error: "not_found",
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("keeps private conversation routes off the public custom domain", async () => {
    const conversationFetch = vi.fn(async () => new Response("unexpected"));
    const response = await worker.fetch(
      new Request(
        "https://agent.scalius.com/internal/conversations/conv_abcdefghijklmnopqrstuv/events?after=0",
        {
          headers: {
            "X-Scalius-Conversation-Audience": "scalius-storefront-browser-v1",
            "X-Scalius-Conversation-Subject":
              "storefront_subject_abcdefghijklmnopqrstuvwxyzABCDEFGHijklmno12",
          },
        },
      ),
      testEnv(vi.fn(), conversationFetch),
      executionContext(),
    );

    expect(response.status).toBe(404);
    expect(conversationFetch).not.toHaveBeenCalled();
  });

  it("accepts only an internal API-verified opaque subject and strips facade headers", async () => {
    const conversationFetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/events");
      expect(request.headers.has("X-Scalius-Conversation-Subject")).toBe(false);
      expect(request.headers.has("X-Scalius-Conversation-Audience")).toBe(false);
      expect(request.headers.has("CF-Connecting-IP")).toBe(false);
      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    const response = await worker.fetch(
      new Request(
        "http://storefront-agent.internal/internal/conversations/conv_abcdefghijklmnopqrstuv/events?after=0",
        {
          headers: {
            "X-Scalius-Conversation-Audience": "scalius-storefront-browser-v1",
            "X-Scalius-Conversation-Subject":
              "storefront_subject_abcdefghijklmnopqrstuvwxyzABCDEFGHijklmno12",
            "CF-Connecting-IP": "203.0.113.8",
          },
        },
      ),
      testEnv(vi.fn(), conversationFetch),
      executionContext(),
    );

    expect(response.status).toBe(200);
    expect(conversationFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects weak or non-self-identifying internal subjects before object access", async () => {
    const conversationFetch = vi.fn(async () => new Response("unexpected"));
    const response = await worker.fetch(
      new Request(
        "http://storefront-agent.internal/internal/conversations/conv_abcdefghijklmnopqrstuv/events?after=0",
        {
          headers: {
            "X-Scalius-Conversation-Audience": "scalius-storefront-browser-v1",
            "X-Scalius-Conversation-Subject": "guest_subject_001",
          },
        },
      ),
      testEnv(vi.fn(), conversationFetch),
      executionContext(),
    );

    expect(response.status).toBe(401);
    expect(conversationFetch).not.toHaveBeenCalled();
  });
});

function testEnv(
  fetch: Fetcher["fetch"] = vi.fn(),
  conversationFetch: (request: Request) => Promise<Response> = async () =>
    new Response(null, { status: 503 }),
): Env {
  return {
    API: { fetch } as Fetcher,
    STOREFRONT: { fetch: vi.fn() } as unknown as Fetcher,
    STOREFRONT_CONVERSATIONS: {
      getByName: () => ({ fetch: conversationFetch }),
    } as unknown as Env["STOREFRONT_CONVERSATIONS"],
    STOREFRONT_URL: "https://storefront.scalius.com",
    AGENT_PROFILE_URL: "https://agent.scalius.com/.well-known/ucp",
    AGENT_NAME: "scalius-storefront-catalog-agent",
    AGENT_VERSION: "0.1.0",
  };
}

function executionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
    tracing: {
      enterSpan: (_name, callback, ...args) =>
        callback(
          {
            isTraced: false,
            setAttribute: () => undefined,
            end: () => undefined,
          },
          ...args,
        ),
      startActiveSpan: (_name, callback, ...args) =>
        callback(
          {
            isTraced: false,
            setAttribute: () => undefined,
            end: () => undefined,
          },
          ...args,
        ),
      Span: class {
        get isTraced() {
          return false;
        }

        setAttribute() {
          return undefined;
        }

        end() {
          return undefined;
        }
      },
    },
  };
}
