import { beforeEach, describe, expect, it, vi } from "vitest";
import { splitSetCookieHeader } from "better-auth/cookies";
import { ADMIN_API_READ_TIMEOUT_MS } from "./admin-api-timeout";

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
    vi.useRealTimers();
    vi.resetModules();
    vi.unstubAllGlobals();
    delete (mocks.cfEnv as { API?: Fetcher }).API;
    mocks.cfEnv.PUBLIC_API_BASE_URL = "https://api.test";
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

    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal).toBeUndefined();
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

  it("bounds read-only API calls with a timeout signal", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn((_target: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new Error("aborted")),
          { once: true },
        );
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { apiGet } = await import("./api.server");
    const result = apiGet("/dashboard/summary");
    const expectation = expect(result).rejects.toThrow("Admin API read timed out");

    await vi.advanceTimersByTimeAsync(ADMIN_API_READ_TIMEOUT_MS);

    await expectation;
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test/api/v1/admin/dashboard/summary",
      expect.objectContaining({
        method: "GET",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("keeps the read timeout active while response JSON is being consumed", async () => {
    vi.useFakeTimers();

    const encoder = new TextEncoder();
    const fetchMock = vi.fn((_target: string, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"success":true,"data":'));
          init?.signal?.addEventListener(
            "abort",
            () => controller.error(init.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { apiGet } = await import("./api.server");
    const result = apiGet("/dashboard/summary");
    const expectation = expect(result).rejects.toThrow("Admin API read timed out");

    await vi.advanceTimersByTimeAsync(ADMIN_API_READ_TIMEOUT_MS);

    await expectation;
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test/api/v1/admin/dashboard/summary",
      expect.objectContaining({
        method: "GET",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("passes read timeout signals through service bindings", async () => {
    const apiFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { ok: true } }), {
        status: 200,
      }),
    );
    (mocks.cfEnv as { API?: { fetch: typeof apiFetch } }).API = {
      fetch: apiFetch,
    };

    const { apiBaseGet } = await import("./api.server");
    await expect(apiBaseGet("/cache/stats")).resolves.toEqual({ ok: true });

    expect(apiFetch).toHaveBeenCalledWith(
      "http://api.internal/api/v1/cache/stats",
      expect.objectContaining({
        method: "GET",
        signal: expect.any(AbortSignal),
      }),
    );
  });
});
