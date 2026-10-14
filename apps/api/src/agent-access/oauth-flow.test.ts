import { createHash, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

const backend = vi.hoisted(() => ({
  refreshOAuthGrant: vi.fn(),
  resolvePrincipal: vi.fn(),
  resolveExternalToken: vi.fn(),
  beginAuthorization: vi.fn(),
}));

vi.mock("./backend", () => ({ loadAgentAccessBackend: vi.fn(async () => backend) }));
// Handlers that report the props and auth the resource server verified. They extend the
// WorkerEntrypoint stub because the provider tells entrypoint classes from plain handlers.
async function reportingHandler(withAuth: boolean) {
  const { WorkerEntrypoint } = await import("cloudflare:workers");
  const Base = WorkerEntrypoint as unknown as new () => object;
  return class extends Base {
    constructor(private readonly ctx: { props: unknown; auth: unknown }) { super(); }
    fetch() { return Response.json(withAuth ? { props: this.ctx.props, auth: this.ctx.auth } : { props: this.ctx.props }); }
  };
}
vi.mock("./mcp/dashboard", async () => ({ DashboardMcpHandler: await reportingHandler(true) }));
vi.mock("./mcp/storefront", async () => ({ StorefrontMcpHandler: await reportingHandler(false) }));

import { createAuthorizationServer, handleOAuthRequest, withOAuthKv } from "./oauth";

const ORIGIN = "https://api.scalius.test";
const DASHBOARD = `${ORIGIN}/api/v1/mcp/dashboard`;
const STOREFRONT = `${ORIGIN}/api/v1/mcp/storefront`;
const REDIRECT_URI = "https://agent.example/callback";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const props = {
  grantId: "agg_1",
  ownerUserId: "user_1",
  resource: "dashboard" as const,
  permissions: ["orders.read"],
  riskCeiling: "read" as const,
  audience: [DASHBOARD],
};

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function call(env: Env, path: string, init?: RequestInit): Promise<Response> {
  return handleOAuthRequest(new Request(`${ORIGIN}${path}`, init), env, ctx);
}

async function token(env: Env, params: Record<string, string>): Promise<Response> {
  return call(env, "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
}

/** Registers a public client, approves a dashboard grant and exchanges the code for tokens. */
async function signIn(env: Env): Promise<{ clientId: string; access: string; refresh: string }> {
  const registered = await call(env, "/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Test agent",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(registered.status).toBe(201);
  const clientId = ((await registered.json()) as { client_id: string }).client_id;

  const verifier = randomBytes(32).toString("base64url");
  const helpers = createAuthorizationServer(env).getOAuthApi(withOAuthKv(env));
  const { redirectTo } = await helpers.completeAuthorization({
    request: {
      responseType: "code",
      clientId,
      redirectUri: REDIRECT_URI,
      scope: ["agent:access"],
      state: "state-1",
      codeChallenge: s256(verifier),
      codeChallengeMethod: "S256",
      resource: DASHBOARD,
    },
    userId: "user_1",
    metadata: {},
    scope: ["agent:access"],
    props,
    revokeExistingGrants: false,
  });
  const code = new URL(redirectTo).searchParams.get("code")!;
  const exchanged = await token(env, {
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
    resource: DASHBOARD,
  });
  expect(exchanged.status).toBe(200);
  const body = (await exchanged.json()) as { access_token: string; refresh_token: string };
  return { clientId, access: body.access_token, refresh: body.refresh_token };
}

describe("agent OAuth with the real provider, two resources on one origin", () => {
  let env: Env;

  beforeEach(() => {
    const { binding } = createSqliteD1Database();
    env = { DB: binding, PUBLIC_API_BASE_URL: ORIGIN } as unknown as Env;
    backend.refreshOAuthGrant.mockReset().mockImplementation(async (value: unknown) => value);
    backend.resolvePrincipal.mockReset().mockResolvedValue({ expiresAt: new Date(Date.now() + 86_400_000) });
    backend.resolveExternalToken.mockReset().mockResolvedValue(null);
  });

  it("advertises one issuer and each resource's own protected resource metadata", async () => {
    const server = (await (await call(env, "/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(server.issuer).toBe(ORIGIN);
    expect(server.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
    expect(server.authorization_endpoint).toBe(`${ORIGIN}/oauth/authorize`);
    expect(server.code_challenge_methods_supported).toEqual(["S256"]);

    for (const resource of [DASHBOARD, STOREFRONT]) {
      const metadata = (await (await call(env, `/.well-known/oauth-protected-resource${new URL(resource).pathname}`)).json()) as Record<string, unknown>;
      expect(metadata.resource).toBe(resource);
      expect(metadata.authorization_servers).toEqual([ORIGIN]);
      expect(metadata.scopes_supported).toEqual(["agent:access"]);
    }
  });

  it("answers an anonymous call to an MCP resource with a bearer challenge naming its metadata", async () => {
    const response = await call(env, "/api/v1/mcp/storefront", { method: "POST" });
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/v1/mcp/storefront"`,
    );
  });

  it("serves the bound resource only: a dashboard token is refused on the storefront", async () => {
    const { access } = await signIn(env);
    const ok = await call(env, "/api/v1/mcp/dashboard", { method: "POST", headers: { Authorization: `Bearer ${access}` } });
    expect(ok.status).toBe(200);
    const served = (await ok.json()) as { props: typeof props; auth: { audience: string; scope: string[] } };
    expect(served.props).toMatchObject({ grantId: "agg_1", resource: "dashboard" });
    expect(served.auth).toMatchObject({ audience: DASHBOARD, scope: ["agent:access"] });

    const wrong = await call(env, "/api/v1/mcp/storefront", { method: "POST", headers: { Authorization: `Bearer ${access}` } });
    expect(wrong.status).toBe(401);
  });

  it("accepts a personal access token for its own resource through the external resolver", async () => {
    backend.resolveExternalToken.mockResolvedValue({ props, audience: DASHBOARD });
    const ok = await call(env, "/api/v1/mcp/dashboard", { method: "POST", headers: { Authorization: "Bearer sc_pat_x_y" } });
    expect(ok.status).toBe(200);
    expect(backend.resolveExternalToken).toHaveBeenCalledWith("sc_pat_x_y", expect.any(Request), expect.anything());
    const wrong = await call(env, "/api/v1/mcp/storefront", { method: "POST", headers: { Authorization: "Bearer sc_pat_x_y" } });
    expect(wrong.status).toBe(401);
  });

  it("rotates the refresh token once: the previous token is refused (patches/@cloudflare__workers-oauth-provider)", async () => {
    const { clientId, refresh } = await signIn(env);

    const rotated = await token(env, { grant_type: "refresh_token", refresh_token: refresh, client_id: clientId, resource: DASHBOARD });
    expect(rotated.status).toBe(200);
    const next = (await rotated.json()) as { access_token: string; refresh_token: string };
    expect(next.refresh_token).not.toBe(refresh);

    const reused = await token(env, { grant_type: "refresh_token", refresh_token: refresh, client_id: clientId, resource: DASHBOARD });
    expect(reused.status).toBe(400);
    expect(((await reused.json()) as { error: string }).error).toBe("invalid_grant");

    const again = await token(env, { grant_type: "refresh_token", refresh_token: next.refresh_token, client_id: clientId, resource: DASHBOARD });
    expect(again.status).toBe(200);
  });

  it("does not revoke a grant through a refresh token that was already rotated", async () => {
    const { clientId, refresh } = await signIn(env);
    const rotated = await token(env, { grant_type: "refresh_token", refresh_token: refresh, client_id: clientId, resource: DASHBOARD });
    const next = (await rotated.json()) as { access_token: string; refresh_token: string };

    await call(env, "/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refresh, token_type_hint: "refresh_token", client_id: clientId }),
    }).catch(() => undefined);

    const still = await call(env, "/api/v1/mcp/dashboard", { method: "POST", headers: { Authorization: `Bearer ${next.access_token}` } });
    expect(still.status).toBe(200);
  });
});
