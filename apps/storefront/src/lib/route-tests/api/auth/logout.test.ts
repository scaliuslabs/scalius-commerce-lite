import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rejectCrossOrigin: true,
  cfEnv: { BACKEND_API: undefined as Fetcher | undefined },
}));

vi.mock("cloudflare:workers", () => ({ env: mocks.cfEnv }));
vi.mock("@scalius/shared/request-origin-guard", () => ({
  shouldRejectCrossOriginCookieRequest: () => mocks.rejectCrossOrigin,
}));

import { POST } from "../../../../pages/api/auth/logout";

beforeEach(() => {
  mocks.rejectCrossOrigin = true;
  mocks.cfEnv.BACKEND_API = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("logout proxy Origin guard", () => {
  it("rejects cross-origin cookie logout requests before clearing cookies", async () => {
    const response = await POST({
      request: new Request("https://storefront.example.test/api/auth/logout", {
        method: "POST",
        headers: {
          Cookie: "cs_tok=session",
          Origin: "https://evil.example.test",
        },
      }),
    } as never);

    expect(response.status).toBe(403);
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });
});

describe("logout proxy backend revocation", () => {
  it("revokes through the service binding with the internal origin in production", async () => {
    vi.stubEnv("DEV", false);
    mocks.rejectCrossOrigin = false;
    const bindingFetch = vi.fn(async () => new Response(null, { status: 204 }));
    mocks.cfEnv.BACKEND_API = { fetch: bindingFetch } as unknown as Fetcher;
    const httpFetch = vi.fn();
    vi.stubGlobal("fetch", httpFetch);

    const response = await POST({
      request: new Request("https://storefront.example.test/api/auth/logout", {
        method: "POST",
        headers: { Cookie: "cs_tok=session", Origin: "https://storefront.example.test" },
      }),
    } as never);

    expect(response.status).toBe(200);
    expect(bindingFetch).toHaveBeenCalledWith(
      "https://api.internal/api/v1/customer-auth/logout",
      expect.objectContaining({ method: "POST", headers: { Cookie: "cs_tok=session" } }),
    );
    expect(httpFetch).not.toHaveBeenCalled();
    expect(response.headers.get("Set-Cookie")).toContain("cs_tok=; Max-Age=0");
  });

  it("still clears cookies when no backend target is available in production", async () => {
    vi.stubEnv("DEV", false);
    mocks.rejectCrossOrigin = false;
    const httpFetch = vi.fn();
    vi.stubGlobal("fetch", httpFetch);

    const response = await POST({
      request: new Request("https://storefront.example.test/api/auth/logout", {
        method: "POST",
        headers: { Cookie: "cs_tok=session", Origin: "https://storefront.example.test" },
      }),
    } as never);

    expect(response.status).toBe(200);
    expect(httpFetch).not.toHaveBeenCalled();
    expect(response.headers.get("Set-Cookie")).toContain("cs_tok=; Max-Age=0");
  });
});
