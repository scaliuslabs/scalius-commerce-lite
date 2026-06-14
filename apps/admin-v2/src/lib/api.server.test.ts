import { beforeEach, describe, expect, it, vi } from "vitest";
import { splitSetCookieHeader } from "better-auth/cookies";

const mocks = vi.hoisted(() => ({
  cfEnv: {
    PUBLIC_API_BASE_URL: "https://api.test",
  },
  getRequestHeader: vi.fn(),
  getResponseHeaders: vi.fn(),
  responseHeaders: new Headers(),
}));

vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeader: mocks.getRequestHeader,
  getResponseHeaders: mocks.getResponseHeaders,
}));

vi.mock("cloudflare:workers", () => ({ env: mocks.cfEnv }));

describe("api.server cookie forwarding", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    mocks.getRequestHeader.mockReset();
    mocks.getResponseHeaders.mockReset();
    mocks.responseHeaders = new Headers();
    mocks.getResponseHeaders.mockReturnValue(mocks.responseHeaders);
  });

  it("forwards request auth headers and appends API Set-Cookie headers to the TanStack response", async () => {
    mocks.getRequestHeader.mockImplementation((name: string) => {
      if (name === "cookie") return "better-auth.session_token=old";
      if (name === "authorization") return "Bearer token";
      return undefined;
    });

    const apiHeaders = new Headers();
    apiHeaders.append(
      "Set-Cookie",
      "better-auth.session_token=new.signature; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/; HttpOnly",
    );
    apiHeaders.append(
      "Set-Cookie",
      "better-auth.session_data=cache.signature; Path=/; HttpOnly",
    );

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { ok: true } }), {
        status: 200,
        headers: apiHeaders,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { apiPost } = await import("./api.server");
    await expect(apiPost("/auth/change-password", {})).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test/api/v1/admin/auth/change-password",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer token",
          cookie: "better-auth.session_token=old",
        }),
      }),
    );

    expect(splitSetCookieHeader(mocks.responseHeaders.get("set-cookie") ?? "")).toEqual([
      "better-auth.session_token=new.signature; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/; HttpOnly",
      "better-auth.session_data=cache.signature; Path=/; HttpOnly",
    ]);
  });

  it("does not crash outside a TanStack request context", async () => {
    mocks.getRequestHeader.mockImplementation(() => {
      throw new Error("No request context");
    });
    mocks.getResponseHeaders.mockImplementation(() => {
      throw new Error("No response context");
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: { ok: true } }), {
          status: 200,
          headers: {
            "Set-Cookie": "better-auth.session_token=new.signature; Path=/; HttpOnly",
          },
        }),
      ),
    );

    const { apiPost } = await import("./api.server");
    await expect(apiPost("/auth/change-password", {})).resolves.toEqual({ ok: true });
  });
});
