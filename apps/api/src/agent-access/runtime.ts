import {
  AgentPayloadTooLargeError,
  agentNoStoreResponse,
  bufferBoundedAgentRequest,
  checkAgentRateLimit,
  getAgentClientIp,
  withAgentNoStoreHeaders,
} from "./limits";
import { completeOAuthAuthorization, createOAuthProvider } from "./oauth";
import {
  DASHBOARD_MCP_PATH,
  DASHBOARD_OAUTH_PROTECTED_RESOURCE_METADATA_PATH,
  OAUTH_AUTHORIZE_PATH,
  OAUTH_AUTHORIZATION_SERVER_METADATA_PATH,
  OAUTH_REGISTER_PATH,
  OAUTH_TOKEN_PATH,
  STOREFRONT_MCP_PATH,
  STOREFRONT_OAUTH_PROTECTED_RESOURCE_METADATA_PATH,
  getOAuthCompletionRequestId,
  getMcpArtifactPath,
  isAgentAccessPath,
  isUnauthenticatedAgentEndpoint,
} from "./paths";

function configuredOrigin(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function canonicalApiOrigin(env: Env): string | null {
  const origin = configuredOrigin(env.PUBLIC_API_BASE_URL);
  if (!origin) return null;
  const url = new URL(origin);
  if (url.protocol !== "https:" && url.hostname !== "localhost") return null;
  return origin;
}

function validateHostAndOrigin(request: Request, env: Env): Response | null {
  const canonicalOrigin = canonicalApiOrigin(env);
  if (!canonicalOrigin || new URL(request.url).origin !== canonicalOrigin) {
    return agentNoStoreResponse("Misdirected Request", { status: 421 });
  }
  const browserOrigin = request.headers.get("Origin");
  if (!browserOrigin) return null;
  const allowedOrigins = new Set(
    [env.PUBLIC_API_BASE_URL, env.BETTER_AUTH_URL, env.STOREFRONT_URL]
      .map(configuredOrigin)
      .filter((origin): origin is string => origin !== null),
  );
  if (!allowedOrigins.has(browserOrigin)) {
    return agentNoStoreResponse("Origin is not allowed", { status: 403 });
  }
  return null;
}

function validateMethod(pathname: string, method: string): boolean {
  if (method === "OPTIONS") return true;
  if (pathname === DASHBOARD_MCP_PATH || pathname === STOREFRONT_MCP_PATH) {
    return method === "POST";
  }
  if (getMcpArtifactPath(pathname)) return method === "GET";
  if (
    pathname === OAUTH_AUTHORIZATION_SERVER_METADATA_PATH ||
    pathname === DASHBOARD_OAUTH_PROTECTED_RESOURCE_METADATA_PATH ||
    pathname === STOREFRONT_OAUTH_PROTECTED_RESOURCE_METADATA_PATH ||
    pathname === OAUTH_AUTHORIZE_PATH ||
    getOAuthCompletionRequestId(pathname) !== null
  ) {
    return method === "GET";
  }
  if (pathname === OAUTH_TOKEN_PATH || pathname === OAUTH_REGISTER_PATH) {
    return method === "POST";
  }
  return false;
}

function methodNotAllowed(pathname: string): Response {
  const allow = pathname === DASHBOARD_MCP_PATH || pathname === STOREFRONT_MCP_PATH
    ? "POST, OPTIONS"
    : pathname === OAUTH_TOKEN_PATH || pathname === OAUTH_REGISTER_PATH
      ? "POST, OPTIONS"
      : "GET, OPTIONS";
  return agentNoStoreResponse("Method Not Allowed", {
    status: 405,
    headers: { Allow: allow },
  });
}

function corsPreflightResponse(request: Request, pathname: string): Response {
  const allow = pathname === DASHBOARD_MCP_PATH || pathname === STOREFRONT_MCP_PATH
    ? "POST, OPTIONS"
    : pathname === OAUTH_TOKEN_PATH || pathname === OAUTH_REGISTER_PATH
      ? "POST, OPTIONS"
      : "GET, OPTIONS";
  const origin = request.headers.get("Origin");
  return agentNoStoreResponse(null, {
    status: 204,
    headers: {
      Allow: allow,
      "Access-Control-Allow-Origin": origin ?? "*",
      "Access-Control-Allow-Methods": allow,
      "Access-Control-Allow-Headers":
        "Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
      "Access-Control-Max-Age": "3600",
    },
  });
}

function preAuthRateLimitClass(pathname: string): string {
  const artifact = getMcpArtifactPath(pathname);
  if (artifact) return `artifact.${artifact.resource}`;
  if (pathname === DASHBOARD_MCP_PATH) return "mcp.dashboard";
  if (pathname === STOREFRONT_MCP_PATH) return "mcp.storefront";
  if (pathname === OAUTH_AUTHORIZE_PATH) return "oauth.authorize";
  if (pathname === OAUTH_TOKEN_PATH) return "oauth.token";
  if (pathname === OAUTH_REGISTER_PATH) return "oauth.register";
  if (getOAuthCompletionRequestId(pathname)) return "oauth.complete";
  return "agent.unknown";
}

export function shouldHandleAgentAccessRequest(request: Request): boolean {
  return isAgentAccessPath(new URL(request.url).pathname);
}

export async function handleAgentAccessRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  if (!isAgentAccessPath(url.pathname)) {
    return agentNoStoreResponse("Not Found", { status: 404 });
  }

  const rejected = validateHostAndOrigin(request, env);
  if (rejected) return rejected;
  if (!validateMethod(url.pathname, request.method.toUpperCase())) {
    return methodNotAllowed(url.pathname);
  }
  if (request.method.toUpperCase() === "OPTIONS") {
    return corsPreflightResponse(request, url.pathname);
  }

  if (isUnauthenticatedAgentEndpoint(url.pathname)) {
    const key = `unauth:${preAuthRateLimitClass(url.pathname)}:${getAgentClientIp(request)}`;
    let allowed: boolean;
    try {
      allowed = await checkAgentRateLimit(env, key);
    } catch {
      return agentNoStoreResponse("Agent access is temporarily unavailable", {
        status: 503,
      });
    }
    if (!allowed) {
      return agentNoStoreResponse("Too Many Requests", {
        status: 429,
        headers: { "Retry-After": "60" },
      });
    }
  }

  let boundedRequest = request;
  if (request.body !== null) {
    try {
      boundedRequest = await bufferBoundedAgentRequest(request);
    } catch (error) {
      if (error instanceof AgentPayloadTooLargeError) {
        return agentNoStoreResponse(error.message, { status: 413 });
      }
      return agentNoStoreResponse("Invalid request body", { status: 400 });
    }
  }

  try {
    const completionRequestId = getOAuthCompletionRequestId(url.pathname);
    const response = completionRequestId
      ? await completeOAuthAuthorization(completionRequestId, env)
      : await createOAuthProvider(env).fetch(boundedRequest, env, ctx);
    return withAgentNoStoreHeaders(response);
  } catch {
    return agentNoStoreResponse("Agent access request failed", { status: 409 });
  }
}
