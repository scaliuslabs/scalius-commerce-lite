import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_API_READ_TIMEOUT_CODE,
  ADMIN_API_READ_TIMEOUT_MS,
} from "../../../../lib/admin-api-timeout";

// The raw module env carries only bindings. `vite dev` (import.meta.env.DEV,
// vitest's default) talks to the fixed local API port; production always uses
// the API service binding.
const mocks = vi.hoisted(() => ({
  cfEnv: {} as { API?: Fetcher },
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
    vi.unstubAllEnvs();
    delete mocks.cfEnv.API;
  });

  it("returns a 504 envelope when a read-only proxy request times out", async () => {
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
    // The route loads the runtime env module lazily; warm it before faking
    // timers so the module load does not race the timer advance.
    await import("../../../../lib/runtime-env.server");
    vi.useFakeTimers();

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
      "http://localhost:8787/api/v1/admin/products?page=1",
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

  it("uses the internal service origin for production service-binding requests", async () => {
    vi.stubEnv("DEV", false);
    const apiFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { ok: true } }), {
        status: 200,
      }),
    );
    mocks.cfEnv.API = { fetch: apiFetch };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { proxyToApi } = await import("./$");
    const response = await proxyToApi(
      new Request("https://dashboard.test/api/v1/admin/media/uploads?kind=image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: "test.png" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(apiFetch).toHaveBeenCalledWith(
      "https://api.internal/api/v1/admin/media/uploads?kind=image",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the API binding from the request-scoped composed env in production", async () => {
    vi.stubEnv("DEV", false);
    const apiFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { ok: true } }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", vi.fn());

    const { runWithRuntimeEnv } = await import("../../../../lib/runtime-env.server");
    const { proxyToApi } = await import("./$");
    const response = await runWithRuntimeEnv(
      { API: { fetch: apiFetch } } as unknown as Env,
      () => proxyToApi(new Request("https://dashboard.test/api/v1/admin/products")),
    );

    expect(response.status).toBe(200);
    expect(apiFetch).toHaveBeenCalledWith(
      "https://api.internal/api/v1/admin/products",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("ignores a stray API binding during vite dev and uses the local API port", async () => {
    const apiFetch = vi.fn();
    mocks.cfEnv.API = { fetch: apiFetch };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { ok: true } }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { proxyToApi } = await import("./$");
    const response = await proxyToApi(
      new Request("https://dashboard.test/api/v1/admin/products"),
    );

    expect(response.status).toBe(200);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8787/api/v1/admin/products",
      expect.objectContaining({ method: "GET" }),
    );
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
