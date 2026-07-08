import { createFileRoute } from "@tanstack/react-router";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";

const AGENT_ADMIN_MCP_URL = "http://agent.internal/mcp/admin";

const noStoreHeaders = {
  "Cache-Control": "no-store",
};

function jsonError(status: number, code: string, message: string): Response {
  return Response.json(
    { success: false, error: { code, message } },
    { status, headers: noStoreHeaders },
  );
}

function createAgentMcpHeaders(headers: Headers): Headers {
  const forwarded = new Headers();

  for (const [name, value] of headers) {
    const lowerName = name.toLowerCase();
    if (
      lowerName === "accept" ||
      lowerName === "content-type" ||
      lowerName === "cookie" ||
      lowerName === "last-event-id" ||
      lowerName.startsWith("mcp-")
    ) {
      forwarded.set(name, value);
    }
  }

  return forwarded;
}

function buildAgentMcpUrl(request: Request): string {
  const sourceUrl = new URL(request.url);
  const targetUrl = new URL(AGENT_ADMIN_MCP_URL);
  targetUrl.search = sourceUrl.search;
  return targetUrl.toString();
}

function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function proxyToAgentAdminMcp(request: Request): Promise<Response> {
  if (shouldRejectCrossOriginCookieRequest(request)) {
    return jsonError(
      403,
      "CROSS_ORIGIN_COOKIE_REQUEST",
      "Cross-origin cookie request denied",
    );
  }

  const { env } = await import("cloudflare:workers");
  const agent = env.AGENT;
  if (!agent) {
    return jsonError(
      503,
      "AGENT_BINDING_UNAVAILABLE",
      "Assistant service is unavailable",
    );
  }

  const init: RequestInit = {
    method: request.method,
    headers: createAgentMcpHeaders(request.headers),
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    // @ts-expect-error -- Cloudflare Workers support duplex streaming
    init.duplex = "half";
  }

  try {
    return withNoStore(await agent.fetch(buildAgentMcpUrl(request), init));
  } catch {
    return jsonError(
      502,
      "AGENT_MCP_PROXY_FAILED",
      "Assistant service request failed",
    );
  }
}

export const Route = createFileRoute("/api/assistant/mcp")({
  server: {
    handlers: {
      GET: async ({ request }) => proxyToAgentAdminMcp(request),
      POST: async ({ request }) => proxyToAgentAdminMcp(request),
      DELETE: async ({ request }) => proxyToAgentAdminMcp(request),
    },
  },
});
