import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_API_READ_TIMEOUT_CODE,
  ADMIN_API_READ_TIMEOUT_MS,
} from "../../../../lib/admin-api-timeout";

const mocks = vi.hoisted(() => ({
  cfEnv: {
    PUBLIC_API_BASE_URL: "https://api.test",
  },
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
}));

vi.mock("cloudflare:workers", () => ({ env: mocks.cfEnv }));

describe("admin API proxy", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.unstubAllGlobals();
    delete (mocks.cfEnv as { API?: Fetcher }).API;
  });

  it("returns a 504 envelope when a read-only proxy request times out", async () => {
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

    const { proxyToApi } = await import("./$");
    const responsePromise = proxyToApi(
      new Request("https://dashboard.test/api/v1/admin/products?page=1"),
    );

    await vi.advanceTimersByTimeAsync(ADMIN_API_READ_TIMEOUT_MS);

    const response = await responsePromise;
    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: {
        code: ADMIN_API_READ_TIMEOUT_CODE,
        message: "Admin API read timed out after 15s. Please retry.",
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test/api/v1/admin/products?page=1",
      expect.objectContaining({
        method: "GET",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("does not attach a read timeout signal to write proxy requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { ok: true } }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { proxyToApi } = await import("./$");
    const response = await proxyToApi(
      new Request("https://dashboard.test/api/v1/admin/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Fish" }),
      }),
    );

    expect(response.status).toBe(200);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).signal).toBeUndefined();
  });

  it("rejects cross-origin cookie write requests before forwarding", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { proxyToApi } = await import("./$");
    const response = await proxyToApi(
      new Request("https://dashboard.test/api/v1/admin/products", {
        method: "POST",
        headers: {
          Cookie: "better-auth.session_token=session.signature",
          Origin: "https://evil.test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Fish" }),
      }),
    );

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
