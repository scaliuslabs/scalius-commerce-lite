import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveRuntimeSecret } from "@scalius/shared/runtime-secrets";

const mocks = vi.hoisted(() => ({
  handlerFetch: vi.fn(),
  withPublicMediaUrl: vi.fn(),
  handlerOptions: [] as unknown[],
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));

vi.mock("@tanstack/react-start/server", () => ({
  defaultStreamHandler: { id: "default-stream-handler" },
  createStartHandler: (options: unknown) => {
    mocks.handlerOptions.push(options);
    return (request: Request, requestOptions?: unknown) => mocks.handlerFetch(request, requestOptions);
  },
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
      fetch: vi.fn().mockImplementation(async () =>
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

describe("admin Worker entry below a runtime base path", () => {
  const BASE_PATH_PLATFORM = {
    storefrontUrl: "https://shop.example.com",
    apiUrl: "https://api.example.com",
    dashboardUrl: "https://shop.example.com/dashboard",
    mediaUrl: "https://cdn.example.com",
  };

  function basePathEnv(overrides: Record<string, unknown> = {}): Env {
    return workerEnv({
      // A fresh Response per call: one env serves several requests in a test.
      API: { fetch: vi.fn().mockImplementation(async () => platformResponse(BASE_PATH_PLATFORM)) },
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("DEV", false);
    mocks.handlerFetch.mockReset();
    mocks.handlerFetch.mockResolvedValue(new Response("<html></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    }));
    mocks.withPublicMediaUrl.mockReset();
    mocks.withPublicMediaUrl.mockImplementation(
      (_url: string, callback: () => Promise<Response>) => callback(),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes prefixed page routes through untouched and strips the prefix for server functions", async () => {
    const { default: worker } = await import("./server");
    const env = basePathEnv();

    await worker.fetch(new Request("https://shop.example.com/dashboard/admin/orders?page=2"), env);
    expect(mocks.handlerFetch.mock.calls[0]?.[0].url).toBe("https://shop.example.com/dashboard/admin/orders?page=2");

    await worker.fetch(new Request("https://shop.example.com/dashboard/_serverFn/abc123", { method: "POST" }), env);
    const serverFnRequest = mocks.handlerFetch.mock.calls[1]?.[0] as Request;
    expect(serverFnRequest.url).toBe("https://shop.example.com/_serverFn/abc123");
    expect(serverFnRequest.method).toBe("POST");
  });

  it("serves build assets below the prefix through the assets binding and falls through on 404", async () => {
    const assetFetch = vi.fn(async (request: Request) =>
      new URL(request.url).pathname === "/assets/immutable/app.js"
        ? new Response("console.log(1)", { headers: { "content-type": "text/javascript" } })
        : new Response("missing", { status: 404 }),
    );
    const { default: worker } = await import("./server");
    const env = basePathEnv({ ASSETS: { fetch: assetFetch } });

    const asset = await worker.fetch(new Request("https://shop.example.com/dashboard/assets/immutable/app.js"), env);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe("console.log(1)");
    expect(assetFetch.mock.calls[0]?.[0].url).toBe("https://shop.example.com/assets/immutable/app.js");
    expect(mocks.handlerFetch).not.toHaveBeenCalled();

    // A router-owned file route (the messaging service worker) is not an asset.
    const routed = await worker.fetch(new Request("https://shop.example.com/dashboard/firebase-messaging-sw.js"), env);
    expect(routed.status).toBe(200);
    expect(mocks.handlerFetch.mock.calls[0]?.[0].url).toBe("https://shop.example.com/dashboard/firebase-messaging-sw.js");
  });

  it("redirects reads outside the prefix and refuses writes, but keeps the health probe", async () => {
    const { default: worker } = await import("./server");
    const env = basePathEnv();

    const redirect = await worker.fetch(new Request("https://shop.example.com/admin/orders?page=2"), env);
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe("https://shop.example.com/dashboard/admin/orders?page=2");

    const refused = await worker.fetch(new Request("https://shop.example.com/api/auth/sign-in/email", { method: "POST" }), env);
    expect(refused.status).toBe(404);
    await expect(refused.json()).resolves.toMatchObject({ code: "DASHBOARD_BASE_PATH" });

    await worker.fetch(new Request("https://shop.example.com/health"), env);
    expect(mocks.handlerFetch.mock.calls.at(-1)?.[0].url).toBe("https://shop.example.com/health");
  });

  it("prefixes manifest asset URLs per request through the Start transform hook", async () => {
    const { default: worker } = await import("./server");
    const options = mocks.handlerOptions.at(-1) as {
      transformAssets: { cache: boolean; transform: (input: { url: string; kind: string }) => string };
    };
    expect(options.transformAssets.cache).toBe(false);

    let transformed = "";
    mocks.handlerFetch.mockImplementation(async () => {
      transformed = options.transformAssets.transform({ url: "/assets/immutable/app.js", kind: "script" });
      return new Response("ok");
    });
    await worker.fetch(new Request("https://shop.example.com/dashboard/admin"), basePathEnv());
    expect(transformed).toBe("/dashboard/assets/immutable/app.js");

    mocks.handlerFetch.mockImplementation(async () => {
      transformed = options.transformAssets.transform({ url: "/assets/immutable/app.js", kind: "script" });
      return new Response("ok");
    });
    await worker.fetch(new Request("https://admin.test/admin"), workerEnv());
    expect(transformed).toBe("/assets/immutable/app.js");
  });

  it("honours a signed front proxy before composing the runtime env", async () => {
    const { RUNTIME_SECRET_PURPOSES } = await import("@scalius/shared/runtime-secrets");
    const { signFrontProxyRequest, FRONT_PROXY_SIGNATURE_HEADER } = await import("@scalius/shared/trusted-front-proxy");
    const secret = await deriveRuntimeSecret(MASTER_SECRET, RUNTIME_SECRET_PURPOSES.FRONT_PROXY_SECRET);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await signFrontProxyRequest(secret, {
      timestamp,
      proto: "https",
      host: "dashboard.example.com",
      pathname: "/admin",
      clientIp: null,
    });
    const { default: worker } = await import("./server");
    let seenOrigin = "";
    mocks.handlerFetch.mockImplementation(async (request: Request) => {
      const { getRuntimeEnv } = await import("./lib/runtime-env.server");
      seenOrigin = getRuntimeEnv().BETTER_AUTH_URL ?? "";
      return new Response(request.url);
    });
    const env = workerEnv({
      API: {
        fetch: vi.fn().mockResolvedValue(
          platformResponse({ storefrontUrl: "", apiUrl: "", dashboardUrl: "", mediaUrl: "" }),
        ),
      },
    });

    const response = await worker.fetch(new Request("https://internal.workers.dev/admin", {
      headers: {
        "X-Forwarded-Host": "dashboard.example.com",
        "X-Forwarded-Proto": "https",
        [FRONT_PROXY_SIGNATURE_HEADER]: signature,
      },
    }), env);

    expect(await response.text()).toBe("https://dashboard.example.com/admin");
    // Without a saved dashboard URL the forwarded origin becomes BETTER_AUTH_URL.
    expect(seenOrigin).toBe("https://dashboard.example.com");
  });
});
