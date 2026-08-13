import { WorkerEntrypoint } from "cloudflare:workers";
import { createMcpHandler } from "agents/mcp/server";
import type { AgentOAuthProps, AgentResource } from "../types";
import { getMcpPath } from "../paths";
import { isAgentOAuthPropsForResource } from "./auth";
import { createAgentMcpServer } from "./server";
import { loadAgentAccessBackend } from "../backend";
import { withAgentDispatchPrincipal } from "../dispatch-context";

const ARTIFACT_CHILD_PATTERN = /^\/api\/v1\/mcp\/(dashboard|storefront)\/artifacts\/(aah_[A-Za-z0-9_-]{20})$/;

export abstract class AgentMcpHandler extends WorkerEntrypoint<Env, AgentOAuthProps> {
  abstract readonly surface: AgentResource;

  async fetch(request: Request): Promise<Response> {
    const route = getMcpPath(this.surface);
    const configuredOrigin = this.env.PUBLIC_API_BASE_URL?.trim();
    if (!configuredOrigin) {
      return new Response("Agent access is not configured", {
        status: 503,
        headers: { "Cache-Control": "private, no-store" },
      });
    }
    let canonicalHostname: string;
    try {
      const canonical = new URL(configuredOrigin);
      if (canonical.protocol !== "https:" && canonical.hostname !== "localhost") throw new Error();
      canonicalHostname = canonical.hostname;
    } catch {
      return new Response("Agent access is not configured", {
        status: 503,
        headers: { "Cache-Control": "private, no-store" },
      });
    }
    if (
      !isAgentOAuthPropsForResource(this.ctx.props, this.surface, configuredOrigin)
    ) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "Cache-Control": "private, no-store" },
      });
    }
    const artifactMatch = new URL(request.url).pathname.match(ARTIFACT_CHILD_PATTERN);
    if (artifactMatch) {
      if (request.method !== "GET" || artifactMatch[1] !== this.surface) {
        return new Response("Not Found", {
          status: 404,
          headers: { "Cache-Control": "private, no-store" },
        });
      }
      const backend = await loadAgentAccessBackend();
      const principal = await backend.resolvePrincipal({
        grantId: this.ctx.props.grantId,
        credentialId: this.ctx.props.credentialId,
        resource: this.ctx.props.resource,
      }, this.env);
      if (!principal) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "Cache-Control": "private, no-store" },
        });
      }
      const canonical = new URL(configuredOrigin).origin;
      const internalRequest = new Request(
        `${canonical}/api/v1/agent-artifacts/${artifactMatch[2]}`,
        { method: "GET", headers: { "X-Request-ID": crypto.randomUUID() } },
      );
      const { default: app } = await import("../../app");
      return app.fetch(
        internalRequest,
        withAgentDispatchPrincipal(this.env, principal),
        this.ctx,
      );
    }
    if (new URL(request.url).pathname !== route) {
      return new Response("Not Found", {
        status: 404,
        headers: { "Cache-Control": "private, no-store" },
      });
    }
    // Constructing the wrapper per request keeps Env/ExecutionContext/principal
    // request-scoped. The SDK factory then creates a fresh McpServer instance.
    const handler = createMcpHandler(
      () => createAgentMcpServer({ surface: this.surface, env: this.env, ctx: this.ctx }),
      {
        route,
        legacy: "stateless",
        responseMode: "auto",
        allowedHostnames: [canonicalHostname],
        // Exact Origin validation runs in runtime.ts before OAuthProvider.
        allowedOriginHostnames: "*",
        authContext: { props: { ...this.ctx.props } },
        corsOptions: {
          origin: request.headers.get("Origin") ?? "*",
          methods: "POST, OPTIONS",
          headers: "Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
          maxAge: 3600,
        },
      },
    );
    return handler(request, this.env, this.ctx);
  }
}
