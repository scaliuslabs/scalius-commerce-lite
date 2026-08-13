import type { AgentResource } from "./types";

export const DASHBOARD_MCP_PATH = "/api/v1/mcp/dashboard";
export const STOREFRONT_MCP_PATH = "/api/v1/mcp/storefront";
export const OAUTH_AUTHORIZE_PATH = "/oauth/authorize";
export const OAUTH_TOKEN_PATH = "/oauth/token";
export const OAUTH_REGISTER_PATH = "/oauth/register";
export const OAUTH_AUTHORIZATION_SERVER_METADATA_PATH =
  "/.well-known/oauth-authorization-server";
export const OAUTH_PROTECTED_RESOURCE_METADATA_PREFIX =
  "/.well-known/oauth-protected-resource";
export const DASHBOARD_OAUTH_PROTECTED_RESOURCE_METADATA_PATH =
  `${OAUTH_PROTECTED_RESOURCE_METADATA_PREFIX}${DASHBOARD_MCP_PATH}`;
export const STOREFRONT_OAUTH_PROTECTED_RESOURCE_METADATA_PATH =
  `${OAUTH_PROTECTED_RESOURCE_METADATA_PREFIX}${STOREFRONT_MCP_PATH}`;
export const OAUTH_COMPLETION_PREFIX = "/oauth/complete/";

const AUTHORIZATION_REQUEST_ID_PATTERN = /^aar_[A-Za-z0-9_-]{20}$/;
const MCP_ARTIFACT_PATH_PATTERN = /^\/api\/v1\/mcp\/(dashboard|storefront)\/artifacts\/(aah_[A-Za-z0-9_-]{20})$/;

const EXACT_AGENT_ACCESS_PATHS = new Set([
  DASHBOARD_MCP_PATH,
  STOREFRONT_MCP_PATH,
  OAUTH_AUTHORIZE_PATH,
  OAUTH_TOKEN_PATH,
  OAUTH_REGISTER_PATH,
  OAUTH_AUTHORIZATION_SERVER_METADATA_PATH,
  DASHBOARD_OAUTH_PROTECTED_RESOURCE_METADATA_PATH,
  STOREFRONT_OAUTH_PROTECTED_RESOURCE_METADATA_PATH,
]);

export function getMcpPath(resource: AgentResource): string {
  return resource === "dashboard" ? DASHBOARD_MCP_PATH : STOREFRONT_MCP_PATH;
}

export function getResourceForMcpPath(pathname: string): AgentResource | null {
  if (pathname === DASHBOARD_MCP_PATH) return "dashboard";
  if (pathname === STOREFRONT_MCP_PATH) return "storefront";
  return null;
}

export function getOAuthCompletionRequestId(pathname: string): string | null {
  if (!pathname.startsWith(OAUTH_COMPLETION_PREFIX)) return null;
  const requestId = pathname.slice(OAUTH_COMPLETION_PREFIX.length);
  return AUTHORIZATION_REQUEST_ID_PATTERN.test(requestId) ? requestId : null;
}

export function getOAuthCompletionUrl(requestId: string, env: Env): string {
  if (!AUTHORIZATION_REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error("OAuth authorization request ID is invalid");
  }
  const configured = env.PUBLIC_API_BASE_URL?.trim();
  if (!configured) throw new Error("PUBLIC_API_BASE_URL is required for OAuth");
  const parsed = new URL(configured);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
    throw new Error("PUBLIC_API_BASE_URL must be HTTPS outside localhost");
  }
  return `${parsed.origin}${OAUTH_COMPLETION_PREFIX}${requestId}`;
}

export function getMcpArtifactPath(
  pathname: string,
): { resource: AgentResource; artifactId: string } | null {
  const match = pathname.match(MCP_ARTIFACT_PATH_PATTERN);
  if (!match) return null;
  return { resource: match[1] as AgentResource, artifactId: match[2]! };
}

export function isAgentAccessPath(pathname: string): boolean {
  return (
    EXACT_AGENT_ACCESS_PATHS.has(pathname) ||
    getMcpArtifactPath(pathname) !== null ||
    getOAuthCompletionRequestId(pathname) !== null
  );
}

export function isUnauthenticatedAgentEndpoint(pathname: string): boolean {
  return (
    pathname === DASHBOARD_MCP_PATH ||
    pathname === STOREFRONT_MCP_PATH ||
    getMcpArtifactPath(pathname) !== null ||
    pathname === OAUTH_AUTHORIZE_PATH ||
    pathname === OAUTH_TOKEN_PATH ||
    pathname === OAUTH_REGISTER_PATH ||
    getOAuthCompletionRequestId(pathname) !== null
  );
}
