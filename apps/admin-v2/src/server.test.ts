import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveRuntimeSecret } from "@scalius/shared/runtime-secrets";

const mocks = vi.hoisted(() => ({
  handlerFetch: vi.fn(),
  withPublicMediaUrl: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));

vi.mock("@tanstack/react-start/server-entry", () => ({
  default: { fetch: mocks.handlerFetch },
}));

vi.mock("@scalius/core/integrations/storage", () => ({
  withPublicMediaUrl: mocks.withPublicMediaUrl,
}));

const MASTER_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";

function platformResponse(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function workerEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    SCALIUS_SECRET: MASTER_SECRET,
    CREDENTIAL_ENCRYPTION_KEY: "credential-key",
    CACHE: {},
    API: {
      fetch: vi.fn().mockResolvedValue(
        platformResponse({
          storefrontUrl: "https://shop.example.com",
          apiUrl: "https://api.example.com",
          dashboardUrl: "https://dashboard.example.com",
          mediaUrl: "https://cdn.example.com",
        }),
      ),
    },
    ...overrides,
  } as unknown as Env;
}

describe("admin Worker entry", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("DEV", false);
    mocks.handlerFetch.mockReset();
    mocks.withPublicMediaUrl.mockReset();
    mocks.withPublicMediaUrl.mockImplementation(
      (_url: string, callback: () => Promise<Response>) => callback(),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the TanStack handler inside the composed request env", async () => {
    let seenEnv: Env | undefined;
    mocks.handlerFetch.mockImplementation(async () => {
      const { getRuntimeEnv } = await import("./lib/runtime-env.server");
      await Promise.resolve();
      seenEnv = getRuntimeEnv();
      return new Response("<html></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });
    const env = workerEnv();
    const { default: worker } = await import("./server");

    const response = await worker.fetch(
      new Request("https://admin.test/admin", { headers: { accept: "text/html" } }),
      env,
    );

    expect(response.status).toBe(200);
    expect(env.API.fetch).toHaveBeenCalledWith(
      "https://api.internal/api/v1/platform",
      expect.objectContaining({ method: "GET" }),
    );
    expect(seenEnv).toBeDefined();
    expect(seenEnv).not.toBe(env);
    expect(seenEnv?.BETTER_AUTH_SECRET).toBe(
      await deriveRuntimeSecret(MASTER_SECRET, "better-auth-session"),
    );
    expect(seenEnv).toMatchObject({
      CREDENTIAL_ENCRYPTION_KEY: "credential-key",
      BETTER_AUTH_URL: "https://dashboard.example.com",
      PUBLIC_API_BASE_URL: "https://api.example.com",
      STOREFRONT_URL: "https://shop.example.com",
      R2_PUBLIC_URL: "https://cdn.example.com",
      PLATFORM_CONFIG: { dashboardUrl: "https://dashboard.example.com" },
    });
    expect(seenEnv?.CACHE).toBe(env.CACHE);
    // The public media base for withPublicMediaUrl is the resolved media URL.
    expect(mocks.withPublicMediaUrl).toHaveBeenCalledWith(
      "https://cdn.example.com",
      expect.any(Function),
    );
    // Dashboard documents keep the no-store policy and security headers.
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("falls back to the request origin for BETTER_AUTH_URL when no dashboard URL is saved", async () => {
    let seenEnv: Env | undefined;
    mocks.handlerFetch.mockImplementation(async () => {
      const { getRuntimeEnv } = await import("./lib/runtime-env.server");
      seenEnv = getRuntimeEnv();
      return new Response("ok");
    });
    const env = workerEnv({
      API: {
        fetch: vi.fn().mockResolvedValue(
          platformResponse({ storefrontUrl: "", apiUrl: "", dashboardUrl: "", mediaUrl: "" }),
        ),
      },
    });
    const { default: worker } = await import("./server");

    await worker.fetch(new Request("https://admin.test/auth/login"), env);

    expect(seenEnv?.BETTER_AUTH_URL).toBe("https://admin.test");
    expect(seenEnv?.PUBLIC_API_BASE_URL).toBeUndefined();
    expect(seenEnv?.R2_PUBLIC_URL).toBeUndefined();
    expect(mocks.withPublicMediaUrl).toHaveBeenCalledWith("", expect.any(Function));
  });

  it("fails closed with 503 when SCALIUS_SECRET is missing", async () => {
    const env = workerEnv({ SCALIUS_SECRET: undefined });
    const { default: worker } = await import("./server");

    const response = await worker.fetch(new Request("https://admin.test/admin"), env);

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: "RUNTIME_SECRET_MISSING",
      error: expect.stringContaining("SCALIUS_SECRET"),
    });
    expect(mocks.handlerFetch).not.toHaveBeenCalled();
    expect(env.API.fetch).not.toHaveBeenCalled();
  });

  it("keeps the health probe working without the master secret", async () => {
    mocks.handlerFetch.mockResolvedValue(
      Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } }),
    );
    const env = workerEnv({ SCALIUS_SECRET: undefined });
    const { default: worker } = await import("./server");

    const response = await worker.fetch(new Request("https://admin.test/health"), env);

    expect(response.status).toBe(200);
    expect(mocks.handlerFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the migration freeze ahead of runtime composition", async () => {
    const env = workerEnv({ DATABASE_MIGRATION_FREEZE: "1" });
    const { default: worker } = await import("./server");

    const response = await worker.fetch(new Request("https://admin.test/admin"), env);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "DATABASE_MIGRATION_IN_PROGRESS",
    });
    expect(mocks.handlerFetch).not.toHaveBeenCalled();
    expect(env.API.fetch).not.toHaveBeenCalled();
  });
});
