import { beforeEach, describe, expect, it, vi } from "vitest";
import { splitSetCookieHeader } from "better-auth/cookies";
import { ADMIN_API_READ_TIMEOUT_MS } from "./admin-api-timeout";

// The raw module env carries only bindings. `vite dev` (import.meta.env.DEV,
// vitest's default) talks to the fixed local API port; production always uses
// the API service binding.
const mocks = vi.hoisted(() => ({
  cfEnv: {} as { API?: Fetcher },
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
    vi.unstubAllEnvs();
    delete mocks.cfEnv.API;
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

    const { apiData } = await import("./api");
    const { postApiV1AdminAuthChangePassword } = await import("@scalius/api-client/sdk");
    await expect(
      apiData(postApiV1AdminAuthChangePassword({ body: { currentPassword: "a", newPassword: "b" } })),
    ).resolves.toEqual({ ok: true });

    const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(target).toBe("http://localhost:8787/api/v1/admin/auth/change-password");
    expect(init.method).toBe("POST");
    expect(init.signal).toBeUndefined();
    expect(init.body).toBe(JSON.stringify({ currentPassword: "a", newPassword: "b" }));
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer token");
    expect(headers.get("cookie")).toBe("better-auth.session_token=old");
    expect(headers.get("content-type")).toBe("application/json");

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

    const { apiData } = await import("./api");
    const { postApiV1AdminAuthChangePassword } = await import("@scalius/api-client/sdk");
    await expect(
      apiData(postApiV1AdminAuthChangePassword({ body: { currentPassword: "a", newPassword: "b" } })),
    ).resolves.toEqual({ ok: true });
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

    const { apiData } = await import("./api");
    const { getApiV1AdminDashboardSummary } = await import("@scalius/api-client/sdk");
    const result = apiData(getApiV1AdminDashboardSummary());
    const expectation = expect(result).rejects.toThrow("Admin API read timed out");

    await vi.advanceTimersByTimeAsync(ADMIN_API_READ_TIMEOUT_MS);

    await expectation;
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8787/api/v1/admin/dashboard/summary",
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

    const { apiData } = await import("./api");
    const { getApiV1AdminDashboardSummary } = await import("@scalius/api-client/sdk");
    const result = apiData(getApiV1AdminDashboardSummary());
    const expectation = expect(result).rejects.toThrow("Admin API read timed out");

    await vi.advanceTimersByTimeAsync(ADMIN_API_READ_TIMEOUT_MS);

    await expectation;
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8787/api/v1/admin/dashboard/summary",
      expect.objectContaining({
        method: "GET",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("passes read timeout signals through the production service binding", async () => {
    vi.stubEnv("DEV", false);
    const apiFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { ok: true } }), {
        status: 200,
      }),
    );
    mocks.cfEnv.API = { fetch: apiFetch };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { apiClient, apiData } = await import("./api");
    await expect(apiData(apiClient.get({ url: "/api/v1/admin/settings" }))).resolves.toEqual({ ok: true });

    expect(apiFetch).toHaveBeenCalledWith(
      "https://api.internal/api/v1/admin/settings",
      expect.objectContaining({
        method: "GET",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the API binding from the request-scoped composed env", async () => {
    vi.stubEnv("DEV", false);
    const apiFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { ok: true } }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", vi.fn());

    const { runWithRuntimeEnv } = await import("./runtime-env.server");
    const { apiData } = await import("./api");
    const { getApiV1AdminDashboardSummary } = await import("@scalius/api-client/sdk");
    await expect(
      runWithRuntimeEnv({ API: { fetch: apiFetch } } as unknown as Env, () =>
        apiData(getApiV1AdminDashboardSummary()),
      ),
    ).resolves.toEqual({ ok: true });

    expect(apiFetch).toHaveBeenCalledWith(
      "https://api.internal/api/v1/admin/dashboard/summary",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("fails closed in production when the API service binding is missing", async () => {
    vi.stubEnv("DEV", false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { apiData } = await import("./api");
    const { getApiV1AdminDashboardSummary } = await import("@scalius/api-client/sdk");
    await expect(apiData(getApiV1AdminDashboardSummary())).rejects.toThrow(
      "API service binding is not configured",
    );
    expect(fetchMock).not.toHaveBeenCalled();
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

    const { apiData } = await import("./api");
    const { getApiV1AdminDashboardSummary } = await import("@scalius/api-client/sdk");
    await expect(apiData(getApiV1AdminDashboardSummary())).resolves.toEqual({ ok: true });

    expect(apiFetch).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8787/api/v1/admin/dashboard/summary",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it.each([401, 403, 404, 409, 500, 503])(
    "preserves HTTP status %i on API response failures",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              success: false,
              error: { code: "CATALOG_FAILURE", message: "Catalog request failed" },
            }),
            { status },
          ),
        ),
      );

      const { apiData } = await import("./api");
      const { getApiV1AdminProductsById } = await import("@scalius/api-client/sdk");
      await expect(
        apiData(getApiV1AdminProductsById({ path: { id: "product_1" } })),
      ).rejects.toMatchObject({
        name: "AdminApiResponseError",
        message: "Catalog request failed",
        status,
        code: "CATALOG_FAILURE",
      });
    },
  );

  it("preserves typed conflict details for client recovery", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            error: {
              code: "PRODUCT_REVISION_CONFLICT",
              message: "This product changed while you were editing.",
              details: { expectedRevision: 7, currentRevision: 8 },
            },
          }),
          { status: 409 },
        ),
      ),
    );

    const { apiData, apiClient } = await import("./api");
    await expect(
      apiData(apiClient.put({ url: "/api/v1/admin/products/product_1", body: {} })),
    ).rejects.toMatchObject({
      status: 409,
      code: "PRODUCT_REVISION_CONFLICT",
      details: { expectedRevision: 7, currentRevision: 8 },
    });
  });
});
