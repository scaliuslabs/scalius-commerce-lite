import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveRuntimeSecret } from "@scalius/shared/runtime-secrets";

const mocks = vi.hoisted(() => ({
  cfEnv: { CACHE: { marker: "module-cache" } } as Record<string, unknown>,
}));

vi.mock("cloudflare:workers", () => ({ env: mocks.cfEnv }));

const MASTER_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";

function platformResponse(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("runtime env store", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefers the request-scoped env and propagates it across awaits", async () => {
    const { getRuntimeEnv, runWithRuntimeEnv } = await import("./runtime-env.server");
    const composed = { CACHE: { marker: "request-cache" } } as unknown as Env;

    const seen = await runWithRuntimeEnv(composed, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return getRuntimeEnv();
    });

    expect(seen).toBe(composed);
  });

  it("isolates concurrent requests from each other", async () => {
    const { getRuntimeEnv, runWithRuntimeEnv } = await import("./runtime-env.server");
    const first = { marker: "first" } as unknown as Env;
    const second = { marker: "second" } as unknown as Env;

    const [seenFirst, seenSecond] = await Promise.all([
      runWithRuntimeEnv(first, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return getRuntimeEnv();
      }),
      runWithRuntimeEnv(second, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return getRuntimeEnv();
      }),
    ]);

    expect(seenFirst).toBe(first);
    expect(seenSecond).toBe(second);
  });

  it("falls back to the raw module env only outside a request", async () => {
    const { getRuntimeEnv } = await import("./runtime-env.server");
    expect(getRuntimeEnv()).toBe(mocks.cfEnv);
  });
});

describe("fetchApi", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("uses the API service binding with the internal origin in production", async () => {
    vi.stubEnv("DEV", false);
    const apiFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { fetchApi } = await import("./runtime-env.server");
    await fetchApi({ API: { fetch: apiFetch } }, "/api/v1/platform", { method: "GET" });

    expect(apiFetch).toHaveBeenCalledWith(
      "https://api.internal/api/v1/platform",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the fixed local API port during vite dev even when a binding exists", async () => {
    const apiFetch = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    const { fetchApi } = await import("./runtime-env.server");
    await fetchApi({ API: { fetch: apiFetch } }, "/api/v1/platform");

    expect(fetchMock).toHaveBeenCalledWith("http://localhost:8787/api/v1/platform", undefined);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("fails closed without a binding in production", async () => {
    vi.stubEnv("DEV", false);
    vi.stubGlobal("fetch", vi.fn());

    const { fetchApi } = await import("./runtime-env.server");
    await expect(fetchApi({} as Pick<Env, "API">, "/api/v1/platform")).rejects.toThrow(
      "API service binding is not configured",
    );
  });
});

describe("composeAdminRuntimeEnv", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.stubEnv("DEV", false);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function baseEnv(apiFetch: ReturnType<typeof vi.fn>): Env {
    return {
      SCALIUS_SECRET: MASTER_SECRET,
      CREDENTIAL_ENCRYPTION_KEY: "credential-key",
      CACHE: { marker: "cache" },
      API: { fetch: apiFetch },
    } as unknown as Env;
  }

  it("derives BETTER_AUTH_SECRET and resolves every platform origin from the API", async () => {
    const apiFetch = vi.fn().mockResolvedValue(
      platformResponse({
        storefrontUrl: "https://shop.example.com",
        apiUrl: "https://api.example.com",
        dashboardUrl: "https://dashboard.example.com",
        mediaUrl: "https://cdn.example.com",
      }),
    );
    const { composeAdminRuntimeEnv } = await import("./runtime-env.server");
    const env = baseEnv(apiFetch);

    const runtime = await composeAdminRuntimeEnv(env, new Request("https://admin.test/admin"));

    expect(runtime.hasMasterSecret).toBe(true);
    expect(apiFetch).toHaveBeenCalledWith(
      "https://api.internal/api/v1/platform",
      expect.objectContaining({ method: "GET" }),
    );
    expect(runtime.env.BETTER_AUTH_SECRET).toBe(
      await deriveRuntimeSecret(MASTER_SECRET, "better-auth-session"),
    );
    expect(runtime.env.BETTER_AUTH_SECRET).not.toBe(MASTER_SECRET);
    expect(runtime.env).toMatchObject({
      CREDENTIAL_ENCRYPTION_KEY: "credential-key",
      BETTER_AUTH_URL: "https://dashboard.example.com",
      PUBLIC_API_BASE_URL: "https://api.example.com",
      STOREFRONT_URL: "https://shop.example.com",
      R2_PUBLIC_URL: "https://cdn.example.com",
      PLATFORM_CONFIG: {
        storefrontUrl: "https://shop.example.com",
        apiUrl: "https://api.example.com",
        dashboardUrl: "https://dashboard.example.com",
        mediaUrl: "https://cdn.example.com",
      },
    });
    // Bindings pass through by reference; the raw env is never mutated.
    expect(runtime.env.CACHE).toBe(env.CACHE);
    expect(runtime.env.API).toBe(env.API);
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(env.BETTER_AUTH_URL).toBeUndefined();
  });

  it("falls back to the request origin for BETTER_AUTH_URL when no dashboard URL is configured", async () => {
    const apiFetch = vi.fn().mockResolvedValue(
      platformResponse({
        storefrontUrl: "https://shop.example.com",
        apiUrl: "",
        dashboardUrl: "",
        mediaUrl: "",
      }),
    );
    const { composeAdminRuntimeEnv } = await import("./runtime-env.server");

    const runtime = await composeAdminRuntimeEnv(
      baseEnv(apiFetch),
      new Request("https://admin.test/auth/login?next=%2Fadmin"),
    );

    expect(runtime.env.BETTER_AUTH_URL).toBe("https://admin.test");
    expect(runtime.env.PUBLIC_API_BASE_URL).toBeUndefined();
    expect(runtime.env.R2_PUBLIC_URL).toBeUndefined();
    expect(runtime.env.STOREFRONT_URL).toBe("https://shop.example.com");
  });

  it("does not guess origins when the platform read fails in production", async () => {
    const apiFetch = vi.fn().mockRejectedValue(new Error("binding down"));
    const { composeAdminRuntimeEnv } = await import("./runtime-env.server");

    const runtime = await composeAdminRuntimeEnv(
      baseEnv(apiFetch),
      new Request("https://admin.test/admin"),
    );

    expect(runtime.hasMasterSecret).toBe(true);
    expect(runtime.env.BETTER_AUTH_URL).toBe("https://admin.test");
    expect(runtime.env.PUBLIC_API_BASE_URL).toBeUndefined();
    expect(runtime.env.STOREFRONT_URL).toBeUndefined();
    expect(runtime.env.R2_PUBLIC_URL).toBeUndefined();
    expect(runtime.env.PLATFORM_CONFIG).toMatchObject({ storefrontUrl: "", apiUrl: "", dashboardUrl: "", mediaUrl: "" });
  });

  it("rejects invalid origins served by the API instead of trusting them", async () => {
    const apiFetch = vi.fn().mockResolvedValue(
      platformResponse({
        storefrontUrl: "http://shop.example.com",
        apiUrl: "https://api.example.com/v1",
        dashboardUrl: "https://dashboard.example.com",
        mediaUrl: "https://cdn.example.com/media/",
      }),
    );
    const { composeAdminRuntimeEnv } = await import("./runtime-env.server");

    const runtime = await composeAdminRuntimeEnv(
      baseEnv(apiFetch),
      new Request("https://admin.test/admin"),
    );

    expect(runtime.env.STOREFRONT_URL).toBeUndefined();
    expect(runtime.env.PUBLIC_API_BASE_URL).toBeUndefined();
    expect(runtime.env.BETTER_AUTH_URL).toBe("https://dashboard.example.com");
    expect(runtime.env.R2_PUBLIC_URL).toBe("https://cdn.example.com/media");
  });

  it("fills loopback development defaults from the fixed local ports", async () => {
    vi.stubEnv("DEV", true);
    const fetchMock = vi.fn().mockResolvedValue(
      platformResponse({ storefrontUrl: "", apiUrl: "", dashboardUrl: "", mediaUrl: "" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { composeAdminRuntimeEnv } = await import("./runtime-env.server");

    const runtime = await composeAdminRuntimeEnv(
      baseEnv(vi.fn()),
      new Request("http://localhost:4323/admin"),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8787/api/v1/platform",
      expect.objectContaining({ method: "GET" }),
    );
    expect(runtime.env).toMatchObject({
      BETTER_AUTH_URL: "http://localhost:4323",
      PUBLIC_API_BASE_URL: "http://localhost:8787",
      STOREFRONT_URL: "http://localhost:4322",
      R2_PUBLIC_URL: "http://localhost:8787/api/v1/media",
    });
  });

  it("reports a missing or short master secret without deriving anything", async () => {
    const apiFetch = vi.fn().mockResolvedValue(
      platformResponse({ storefrontUrl: "", apiUrl: "", dashboardUrl: "", mediaUrl: "" }),
    );
    const { composeAdminRuntimeEnv, hasMasterSecret } = await import("./runtime-env.server");

    for (const secret of [undefined, "", "too-short"]) {
      const env = baseEnv(apiFetch);
      if (secret === undefined) delete env.SCALIUS_SECRET;
      else env.SCALIUS_SECRET = secret;
      expect(hasMasterSecret(env)).toBe(false);
      const runtime = await composeAdminRuntimeEnv(env, new Request("https://admin.test/admin"));
      expect(runtime.hasMasterSecret).toBe(false);
      expect(runtime.env.BETTER_AUTH_SECRET).toBe("");
    }
  });
});
