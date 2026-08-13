import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimAuthorizationCompletion: vi.fn(),
  finishAuthorizationCompletion: vi.fn(),
  releaseAuthorizationCompletion: vi.fn(),
  providerComplete: vi.fn(),
}));

vi.mock("./backend", () => ({
  loadAgentAccessBackend: vi.fn(async () => ({
    claimAuthorizationCompletion: mocks.claimAuthorizationCompletion,
    finishAuthorizationCompletion: mocks.finishAuthorizationCompletion,
    releaseAuthorizationCompletion: mocks.releaseAuthorizationCompletion,
  })),
}));
vi.mock("./mcp/dashboard", () => ({ DashboardMcpHandler: class {} }));
vi.mock("./mcp/storefront", () => ({ StorefrontMcpHandler: class {} }));
vi.mock("@cloudflare/workers-oauth-provider", () => {
  class AuthorizationError extends Error {
    code = "invalid_request";
    description = "invalid";
  }
  class OAuthError extends Error {}
  return {
    default: class {},
    AuthorizationError,
    OAuthError,
    getOAuthApi: vi.fn(() => ({ completeAuthorization: mocks.providerComplete })),
  };
});

import {
  completeOAuthAuthorization,
  validateAuthorizationRequest,
} from "./oauth";

const request = {
  responseType: "code" as const,
  resource: "https://api.scalius.test/api/v1/mcp/dashboard",
  clientId: "client-1",
  redirectUri: "https://agent.example/callback?existing=safe",
  scope: ["agent:access"],
  state: "state-123",
  codeChallenge: "challenge",
  codeChallengeMethod: "S256" as const,
  issuer: "https://api.scalius.test",
};

describe("OAuth denial completion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimAuthorizationCompletion.mockResolvedValue({
      kind: "denied",
      claimToken: "server-only-claim",
      request,
    });
    mocks.finishAuthorizationCompletion.mockResolvedValue(undefined);
    mocks.releaseAuthorizationCompletion.mockResolvedValue(undefined);
  });

  it("redirects only to the persisted validated callback and terminalizes", async () => {
    const response = await completeOAuthAuthorization(
      "aar_0123456789abcdefghij",
      { PUBLIC_API_BASE_URL: "https://api.scalius.test" } as Env,
    );
    const redirect = new URL(response.headers.get("location")!);
    expect(response.status).toBe(302);
    expect(redirect.origin + redirect.pathname).toBe("https://agent.example/callback");
    expect(redirect.searchParams.get("existing")).toBe("safe");
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("error_description")).toBe("Authorization was denied");
    expect(redirect.searchParams.get("state")).toBe("state-123");
    expect(redirect.searchParams.get("iss")).toBe("https://api.scalius.test");
    expect(mocks.finishAuthorizationCompletion).toHaveBeenCalledWith(
      "aar_0123456789abcdefghij",
      "server-only-claim",
      expect.anything(),
    );
    expect(mocks.releaseAuthorizationCompletion).not.toHaveBeenCalled();
  });

  it("releases a denied claim when terminal persistence fails so retry is immediate", async () => {
    mocks.finishAuthorizationCompletion.mockRejectedValueOnce(new Error("D1 unavailable"));
    await expect(completeOAuthAuthorization(
      "aar_0123456789abcdefghij",
      { PUBLIC_API_BASE_URL: "https://api.scalius.test" } as Env,
    )).rejects.toThrow("D1 unavailable");
    expect(mocks.releaseAuthorizationCompletion).toHaveBeenCalledWith(
      "aar_0123456789abcdefghij",
      "server-only-claim",
      expect.anything(),
    );
  });
});

describe("OAuth approved completion", () => {
  it("explicitly preserves concurrent named grants for one client", async () => {
    mocks.claimAuthorizationCompletion.mockResolvedValueOnce({
      kind: "approved",
      claimToken: "server-only-approved-claim",
      authorization: {
        request,
        userId: "b2de2a7d-d990-4456-b69e-27d55710938c",
        metadata: {
          grantId: "agr_0123456789abcdefghij",
          resource: "dashboard",
          clientName: "Codex",
        },
        scope: ["agent:access"],
        props: {
          grantId: "agr_0123456789abcdefghij",
          ownerUserId: "b2de2a7d-d990-4456-b69e-27d55710938c",
          resource: "dashboard",
          permissions: ["products.view"],
          riskCeiling: "read",
          audience: [request.resource],
        },
        revokeExistingGrants: false,
      },
    });
    mocks.providerComplete.mockResolvedValueOnce({
      redirectTo: "https://agent.example/callback?code=opaque",
    });
    mocks.finishAuthorizationCompletion.mockResolvedValueOnce(undefined);
    await completeOAuthAuthorization(
      "aar_0123456789abcdefghij",
      { PUBLIC_API_BASE_URL: "https://api.scalius.test" } as Env,
    );
    expect(mocks.providerComplete).toHaveBeenCalledWith(expect.objectContaining({
      revokeExistingGrants: false,
    }));
  });
});

describe("OAuth authorization resource binding", () => {
  const env = { PUBLIC_API_BASE_URL: "https://api.scalius.test" } as Env;

  it("accepts exactly one canonical MCP resource with S256 and the sole scope", () => {
    expect(validateAuthorizationRequest(request, "Codex", env)).toMatchObject({
      resource: "https://api.scalius.test/api/v1/mcp/dashboard",
      scope: ["agent:access"],
      codeChallengeMethod: "S256",
      clientName: "Codex",
    });
  });

  it.each([
    ["missing", undefined],
    ["wrong", "https://api.scalius.test/api/v1/mcp/dashboard-evil"],
    ["cross-origin", "https://evil.example/api/v1/mcp/dashboard"],
    ["multiple", [
      "https://api.scalius.test/api/v1/mcp/dashboard",
      "https://api.scalius.test/api/v1/mcp/storefront",
    ]],
  ])("rejects a %s protected resource", (_label, resource) => {
    expect(() => validateAuthorizationRequest(
      { ...request, resource } as typeof request,
      undefined,
      env,
    )).toThrow();
  });
});
