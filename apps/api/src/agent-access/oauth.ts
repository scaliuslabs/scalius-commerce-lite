import OAuthProvider, {
  AuthorizationError,
  getOAuthApi,
  OAuthError,
  type AuthRequest,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import { loadAgentAccessBackend } from "./backend";
import {
  DASHBOARD_MCP_PATH,
  OAUTH_AUTHORIZE_PATH,
  OAUTH_REGISTER_PATH,
  OAUTH_TOKEN_PATH,
  STOREFRONT_MCP_PATH,
} from "./paths";
export { getOAuthCompletionUrl } from "./paths";
import { DashboardMcpHandler } from "./mcp/dashboard";
import { StorefrontMcpHandler } from "./mcp/storefront";
import type {
  AgentResource,
  ValidatedAuthorizationRequest,
} from "./types";

const AGENT_SCOPE = "agent:access";
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const CLIENT_REGISTRATION_TTL_SECONDS = 90 * 24 * 60 * 60;

function requireCanonicalApiOrigin(env: Env): string {
  const configured = env.PUBLIC_API_BASE_URL?.trim();
  if (!configured) throw new Error("PUBLIC_API_BASE_URL is required for OAuth");
  const parsed = new URL(configured);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
    throw new Error("PUBLIC_API_BASE_URL must be HTTPS outside localhost");
  }
  return parsed.origin;
}

export function getCanonicalMcpResource(env: Env, resource: AgentResource): string {
  const path = resource === "dashboard" ? DASHBOARD_MCP_PATH : STOREFRONT_MCP_PATH;
  return `${requireCanonicalApiOrigin(env)}${path}`;
}

function validateRequestedResource(
  resource: AuthRequest["resource"],
  env: Env,
  request: AuthRequest,
): string {
  if (typeof resource !== "string") {
    throw new AuthorizationError("invalid_target", {
      description: "Exactly one protected resource is required",
      redirectUri: request.redirectUri,
      state: request.state,
      issuer: request.issuer,
    });
  }
  const allowed = new Set([
    getCanonicalMcpResource(env, "dashboard"),
    getCanonicalMcpResource(env, "storefront"),
  ]);
  if (!allowed.has(resource)) {
    throw new AuthorizationError("invalid_target", {
      description: "The protected resource is not supported",
      redirectUri: request.redirectUri,
      state: request.state,
      issuer: request.issuer,
    });
  }
  return resource;
}

export function validateAuthorizationRequest(
  request: AuthRequest,
  clientName: string | undefined,
  env: Env,
): ValidatedAuthorizationRequest {
  if (request.responseType !== "code") {
    throw new AuthorizationError("unsupported_response_type", {
      description: "Only the authorization code flow is supported",
      redirectUri: request.redirectUri,
      state: request.state,
      issuer: request.issuer,
    });
  }
  if (request.codeChallengeMethod !== "S256" || !request.codeChallenge) {
    throw new AuthorizationError("invalid_request", {
      description: "PKCE with S256 is required",
      redirectUri: request.redirectUri,
      state: request.state,
      issuer: request.issuer,
    });
  }
  if (request.scope.length !== 1 || request.scope[0] !== AGENT_SCOPE) {
    throw new AuthorizationError("invalid_scope", {
      description: `The requested scope must be ${AGENT_SCOPE}`,
      redirectUri: request.redirectUri,
      state: request.state,
      issuer: request.issuer,
    });
  }
  return {
    responseType: "code",
    resource: validateRequestedResource(request.resource, env, request),
    clientId: request.clientId,
    ...(clientName ? { clientName: clientName.slice(0, 160) } : {}),
    redirectUri: request.redirectUri,
    scope: [AGENT_SCOPE],
    state: request.state,
    codeChallenge: request.codeChallenge,
    codeChallengeMethod: "S256",
    ...(request.issuer ? { issuer: request.issuer } : {}),
  };
}

function authorizationErrorResponse(error: AuthorizationError): Response {
  if (error.redirectUri) {
    const redirect = new URL(error.redirectUri);
    redirect.searchParams.set("error", error.code);
    redirect.searchParams.set("error_description", error.description);
    if (error.state) redirect.searchParams.set("state", error.state);
    if (error.issuer) redirect.searchParams.set("iss", error.issuer);
    return Response.redirect(redirect, 302);
  }
  return Response.json(
    { error: error.code, error_description: error.description },
    { status: 400 },
  );
}

const oauthDefaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== OAUTH_AUTHORIZE_PATH || request.method !== "GET") {
      return new Response("Not Found", { status: 404 });
    }

    try {
      const helpers = getOAuthApi(createOAuthProviderOptions(env), env);
      const parsed = await helpers.parseAuthRequest(request);
      const client = await helpers.lookupClient(parsed.clientId);
      if (!client) {
        throw new AuthorizationError("unauthorized_client", {
          description: "OAuth client is not registered",
        });
      }
      const validated = validateAuthorizationRequest(parsed, client.clientName, env);
      const backend = await loadAgentAccessBackend();
      const pending = await backend.beginAuthorization(validated, env);
      return Response.redirect(pending.dashboardUrl, 302);
    } catch (error) {
      if (error instanceof AuthorizationError) return authorizationErrorResponse(error);
      return Response.json(
        { error: "server_error", error_description: "Authorization could not be started" },
        { status: 500 },
      );
    }
  },
};

export function createOAuthProviderOptions(envForTokenExchange: Env): OAuthProviderOptions<Env> {
  return {
    apiHandlers: {
      [DASHBOARD_MCP_PATH]: DashboardMcpHandler,
      [STOREFRONT_MCP_PATH]: StorefrontMcpHandler,
    },
    defaultHandler: oauthDefaultHandler,
    authorizeEndpoint: OAUTH_AUTHORIZE_PATH,
    tokenEndpoint: OAUTH_TOKEN_PATH,
    clientRegistrationEndpoint: OAUTH_REGISTER_PATH,
    accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
    clientRegistrationTTL: CLIENT_REGISTRATION_TTL_SECONDS,
    scopesSupported: [AGENT_SCOPE],
    allowImplicitFlow: false,
    allowPlainPKCE: false,
    allowTokenExchangeGrant: false,
    clientIdMetadataDocumentEnabled: true,
    resourceMatchOriginOnly: false,
    // There are two path-isolated resources on one origin, so a provider-wide
    // resource pin would be incorrect. Authorization requires one exact URI and
    // RFC 9728 metadata derives the exact resource from its path.
    resourceMetadata: {
      scopes_supported: [AGENT_SCOPE],
      bearer_methods_supported: ["header"],
    },
    async resolveExternalToken({ token, request, env }) {
      const backend = await loadAgentAccessBackend();
      return backend.resolveExternalToken(token, request, env);
    },
    async tokenExchangeCallback({ props, grantType }) {
      const backend = await loadAgentAccessBackend();
      const fresh = await backend.refreshOAuthGrant(props, envForTokenExchange);
      if (!fresh) {
        throw new OAuthError("invalid_grant", {
          description: "The agent authorization grant is inactive",
        });
      }
      const principal = await backend.resolvePrincipal(
        {
          grantId: fresh.grantId,
          credentialId: fresh.credentialId,
          resource: fresh.resource,
        },
        envForTokenExchange,
      );
      if (!principal) {
        throw new OAuthError("invalid_grant", {
          description: "The agent authorization grant is inactive",
        });
      }
      const remainingTtl = Math.floor((principal.expiresAt.getTime() - Date.now()) / 1000);
      if (remainingTtl <= 60) {
        throw new OAuthError("invalid_grant", {
          description: "The agent authorization grant is inactive",
        });
      }
      return {
        newProps: fresh,
        accessTokenProps: fresh,
        accessTokenTTL: Math.min(ACCESS_TOKEN_TTL_SECONDS, remainingTtl),
        ...(grantType === "authorization_code"
          ? { refreshTokenTTL: Math.min(REFRESH_TOKEN_TTL_SECONDS, remainingTtl) }
          : {}),
      };
    },
  };
}

export function createOAuthProvider(env: Env): OAuthProvider<Env> {
  return new OAuthProvider<Env>(createOAuthProviderOptions(env));
}

export async function purgeExpiredOAuthData(env: Env): Promise<void> {
  await createOAuthProvider(env).purgeExpiredData(env);
}

export async function completeOAuthAuthorization(
  requestId: string,
  env: Env,
): Promise<Response> {
  const backend = await loadAgentAccessBackend();
  const claimed = await backend.claimAuthorizationCompletion(requestId, env);
  let irreversibleProviderCompletion = false;
  try {
    let redirectTo: string;
    if (claimed.kind === "approved") {
      const helpers = getOAuthApi(createOAuthProviderOptions(env), env);
      const result = await helpers.completeAuthorization({
        ...claimed.authorization,
        request: claimed.authorization.request as AuthRequest,
      });
      redirectTo = result.redirectTo;
      irreversibleProviderCompletion = true;
    } else {
      const redirect = new URL(claimed.request.redirectUri);
      redirect.searchParams.set("error", "access_denied");
      redirect.searchParams.set("error_description", "Authorization was denied");
      redirect.searchParams.set("state", claimed.request.state);
      if (claimed.request.issuer) redirect.searchParams.set("iss", claimed.request.issuer);
      redirectTo = redirect.href;
    }
    await backend.finishAuthorizationCompletion(requestId, claimed.claimToken, env);
    return Response.redirect(redirectTo, 302);
  } catch (error) {
    // Never expose or log the claim token. Release only before the provider has
    // created an authorization code; after that point preserving the lease is
    // safer than allowing an immediate duplicate completion.
    if (!irreversibleProviderCompletion) {
      await backend.releaseAuthorizationCompletion(requestId, claimed.claimToken, env);
    }
    throw error;
  }
}
