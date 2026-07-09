import {
  createAdminMcpServer,
  parseAdminPermissionContext,
  resolveAdminMcpRequestAuth,
} from "./mcp/admin";
import { blandNotFoundResponse, jsonResponse, withNoStore } from "./http";
import type { AdminAgentRuntimeEnv } from "./runtime-env";
import {
  ADMIN_CONVERSATION_POLICY,
} from "./conversation/contracts";
import {
  matchInternalConversationRoute,
  proxyInternalConversationRequest,
} from "./conversation/router";

export type { AdminAgentRuntimeEnv } from "./runtime-env";

export const ADMIN_AGENT_INTERNAL_ORIGIN = "http://admin-agent.internal";
export const ADMIN_AGENT_MCP_PATH = "/mcp";
export const ADMIN_AGENT_HEALTH_PATH = "/health";

function isExactInternalAdminUrl(url: URL, pathname: string): boolean {
  return (
    url.origin === ADMIN_AGENT_INTERNAL_ORIGIN &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === pathname &&
    url.search === "" &&
    url.hash === ""
  );
}

export function createAdminAgentWorker() {
  return {
    async fetch(
      request: Request,
      env: AdminAgentRuntimeEnv,
      ctx: ExecutionContext,
    ): Promise<Response> {
      const url = new URL(request.url);

      const conversationRoute = matchInternalConversationRoute(
        request,
        ADMIN_AGENT_INTERNAL_ORIGIN,
      );
      if (conversationRoute) {
        if (request.headers.has("Authorization")) {
          return jsonResponse({
            success: false,
            error: {
              code: "admin_conversation_bearer_forbidden",
              message: "Admin conversations require the dashboard cookie session.",
            },
          }, 400);
        }
        const auth = await resolveAdminMcpRequestAuth(request, env);
        if (auth instanceof Response) return auth;
        const userId = parseAdminPermissionContext(auth.permissionsBody).userId;
        if (!userId) {
          return jsonResponse({
            success: false,
            error: {
              code: "admin_conversation_identity_unavailable",
              message: "Admin conversation identity is temporarily unavailable.",
            },
          }, 503);
        }
        return proxyInternalConversationRequest({
          request,
          route: conversationRoute,
          namespace: env.ADMIN_CONVERSATIONS,
          policy: ADMIN_CONVERSATION_POLICY,
          subject: userId,
        });
      }

      if (
        request.method === "GET" &&
        isExactInternalAdminUrl(url, ADMIN_AGENT_HEALTH_PATH)
      ) {
        return jsonResponse({
          success: true,
          status: "ok",
          service: "scalius-admin-agent",
        });
      }

      if (!isExactInternalAdminUrl(url, ADMIN_AGENT_MCP_PATH)) {
        return blandNotFoundResponse();
      }

      const auth = await resolveAdminMcpRequestAuth(request, env);
      if (auth instanceof Response) return auth;

      const { createMcpHandler } = await import("agents/mcp");
      const server = createAdminMcpServer(env, {
        cookie: auth.cookie,
        userAgent: auth.userAgent,
        permissionsBody: auth.permissionsBody,
      });
      const response = await createMcpHandler(server, {
        route: ADMIN_AGENT_MCP_PATH,
      })(request, env, ctx);
      return withNoStore(response);
    },
  } satisfies ExportedHandler<AdminAgentRuntimeEnv>;
}
