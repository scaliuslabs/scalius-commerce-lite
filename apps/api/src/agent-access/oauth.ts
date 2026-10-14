import {
  AuthorizationError,
  OAuthAuthorizationServer,
  OAuthError,
  OAuthResourceServer,
  type AuthRequest,
  type OAuthAuthorizationServerOptions,
} from "@cloudflare/workers-oauth-provider";
import { getDb } from "@scalius/database/client";
import {
  deleteSystemKv,
  getSystemKv,
  listSystemKv,
  purgeExpiredSystemKv,
  putSystemKv,
} from "@scalius/core/utils/system-kv";
import { loadAgentAccessBackend } from "./backend";
import {
  getMcpPath,
  getMcpResourceForPath,
  OAUTH_AUTHORIZE_PATH,
  OAUTH_REGISTER_PATH,
  OAUTH_TOKEN_PATH,
} from "./paths";
export { getOAuthCompletionUrl } from "./paths";
import { DashboardMcpHandler } from "./mcp/dashboard";
import { StorefrontMcpHandler } from "./mcp/storefront";
import type {
  AgentOAuthProps,
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
  return `${requireCanonicalApiOrigin(env)}${getMcpPath(resource)}`;
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

/** The authorization endpoint: parse and validate the request, then hand the buyer to the dashboard to approve. */
async function handleAuthorizeRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return new Response("Not Found", { status: 404 });
  try {
    const helpers = createAuthorizationServer(env).getOAuthApi(withOAuthKv(env));
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
}

/**
 * One authorization server for both path-isolated MCP resources on this origin.
 * Every grant and token is bound to exactly one of the two canonical resources.
 */
export function createAuthorizationServer(envForTokenExchange: Env): OAuthAuthorizationServer<Env> {
  const options: OAuthAuthorizationServerOptions<Env> = {
    issuer: requireCanonicalApiOrigin(envForTokenExchange),
    resources: [
      getCanonicalMcpResource(envForTokenExchange, "dashboard"),
      getCanonicalMcpResource(envForTokenExchange, "storefront"),
    ],
    authorizeEndpoint: OAUTH_AUTHORIZE_PATH,
    tokenEndpoint: OAUTH_TOKEN_PATH,
    clientRegistrationEndpoint: OAUTH_REGISTER_PATH,
    accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
    clientRegistrationTTL: CLIENT_REGISTRATION_TTL_SECONDS,
    scopesSupported: [AGENT_SCOPE],
    allowTokenExchangeGrant: false,
    clientIdMetadataDocumentEnabled: true,
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
  return new OAuthAuthorizationServer<Env>(options);
}

/**
 * One MCP resource. It accepts a bearer token from this authorization server
 * or a personal access token (`sc_pat_`, `sc_cli_`), and only for its own audience.
 */
function createResourceServer(
  env: Env,
  authorizationServer: OAuthAuthorizationServer<Env>,
  surface: AgentResource,
): OAuthResourceServer<Env, AgentOAuthProps> {
  return new OAuthResourceServer<Env, AgentOAuthProps>({
    resourceMetadata: {
      resource: getCanonicalMcpResource(env, surface),
      authorization_servers: [requireCanonicalApiOrigin(env)],
      bearer_methods_supported: ["header"],
    },
    requiredScopes: [AGENT_SCOPE],
    validateToken: (validatorEnv, request) => async (resource, token) => {
      const backend = await loadAgentAccessBackend();
      const external = await backend.resolveExternalToken(token, request, validatorEnv);
      if (external) return external;
      return authorizationServer.validateToken<AgentOAuthProps>(resource, token, validatorEnv);
    },
    handler: surface === "dashboard" ? DashboardMcpHandler : StorefrontMcpHandler,
  });
}

const OAUTH_KV_PREFIX = "oauth:";

type OAuthKvPutOptions = { expiration?: number; expirationTtl?: number };

/**
 * The OAuth provider library hard-codes a KV-shaped `env.OAUTH_KV`. Back it
 * with `system_kv` rows under a fixed key prefix in the store's relational
 * database, so a grant or a revocation holds the moment it is written. The
 * library keys tokens by hash and encrypts grant props: no bearer secret is
 * stored in clear. `list()` strips the prefix again because the library reads
 * each listed `key.name` back.
 */
export function withOAuthKv(env: Env): Env {
  let database: ReturnType<typeof getDb> | undefined;
  const db = () => (database ??= getDb(env));
  const OAUTH_KV = {
    async get(key: string, options?: { type?: string } | string) {
      const raw = await getSystemKv(db(), OAUTH_KV_PREFIX + key);
      const type = typeof options === "string" ? options : options?.type;
      return raw !== null && type === "json" ? JSON.parse(raw) as unknown : raw;
    },
    async put(key: string, value: string, options: OAuthKvPutOptions = {}) {
      const expiresAt = options.expiration
        ?? (options.expirationTtl ? Math.floor(Date.now() / 1000) + options.expirationTtl : null);
      await putSystemKv(db(), OAUTH_KV_PREFIX + key, value, expiresAt);
    },
    delete: (key: string) => deleteSystemKv(db(), OAUTH_KV_PREFIX + key),
    async list(options: { prefix?: string; limit?: number; cursor?: string } = {}) {
      const page = await listSystemKv(db(), OAUTH_KV_PREFIX + (options.prefix ?? ""), {
        limit: options.limit,
        cursor: options.cursor ? OAUTH_KV_PREFIX + options.cursor : undefined,
      });
      const keys = page.keys.map((name) => ({ name: name.slice(OAUTH_KV_PREFIX.length) }));
      return page.cursor
        ? { keys, list_complete: false, cursor: page.cursor.slice(OAUTH_KV_PREFIX.length) }
        : { keys, list_complete: true };
    },
  };
  return { ...env, OAUTH_KV } as Env;
}

export function handleOAuthRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === OAUTH_AUTHORIZE_PATH) return handleAuthorizeRequest(request, env);
  const providerEnv = withOAuthKv(env);
  const authorizationServer = createAuthorizationServer(env);
  const surface = getMcpResourceForPath(pathname);
  return surface
    ? createResourceServer(env, authorizationServer, surface).fetch(request, providerEnv, ctx)
    : authorizationServer.fetch(request, providerEnv, ctx);
}

/** Expired grants, tokens and clients (and other `system_kv` rows) are rows past `expires_at`. */
export async function purgeExpiredOAuthData(env: Env): Promise<void> {
  await purgeExpiredSystemKv(getDb(env));
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
      const helpers = createAuthorizationServer(env).getOAuthApi(withOAuthKv(env));
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
