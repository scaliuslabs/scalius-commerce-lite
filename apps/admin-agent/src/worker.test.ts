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

describe("Admin Agent Worker entrypoint", () => {
  it("reports the dedicated identity only on its internal health endpoint", async () => {
    const response = await worker.fetch(
      new Request("http://admin-agent.internal/health"),
      testEnv(),
      executionContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      success: true,
      status: "ok",
      service: "scalius-admin-agent",
    });
  });

  it("returns a bland no-store 404 on public hosts", async () => {
    const apiFetch = vi.fn<Fetcher["fetch"]>();
    const response = await worker.fetch(
      new Request("https://admin-agent.example.test/mcp", {
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

  it("revalidates the dashboard cookie and strips request identity before the conversation object", async () => {
    const apiFetch = vi.fn<Fetcher["fetch"]>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Cookie")).toBe("better-auth.session_token=private");
      return new Response(JSON.stringify({
        success: true,
        data: {
          userId: "admin_actor_001",
          isSuperAdmin: false,
          roles: [],
          permissions: [],
          overrides: { grants: [], denials: [] },
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const conversationFetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/events");
      expect(request.headers.has("Cookie")).toBe(false);
      expect(request.headers.has("Authorization")).toBe(false);
      expect(request.headers.has("User-Agent")).toBe(false);
      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    const response = await worker.fetch(
      new Request(
        "http://admin-agent.internal/internal/conversations/conv_abcdefghijklmnopqrstuv/events?after=0",
        {
          headers: {
            Cookie: "better-auth.session_token=private",
            "User-Agent": "private-browser-agent",
          },
        },
      ),
      testEnv(apiFetch, conversationFetch),
      executionContext(),
    );

    expect(response.status).toBe(200);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(conversationFetch).toHaveBeenCalledTimes(1);
  });
});

function testEnv(
  fetch: Fetcher["fetch"] = vi.fn(),
  conversationFetch: (request: Request) => Promise<Response> = async () =>
    new Response(null, { status: 503 }),
): Env {
  return {
    API: { fetch } as Fetcher,
    ADMIN_CONVERSATIONS: {
      getByName: () => ({ fetch: conversationFetch }),
    } as unknown as Env["ADMIN_CONVERSATIONS"],
    AGENT_NAME: "scalius-admin-agent",
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
