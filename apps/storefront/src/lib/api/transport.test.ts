// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requestRuntime, type StorefrontRuntime } from "./runtime";
import {
  apiFetch,
  createApiUrl,
  resolveBackendTarget,
  withEdgeCache,
} from "./transport";

const apiBaseUrl = "https://api.example.test/api/v1";

function runWithBackend<T>(backend: Fetcher | undefined, task: () => T): T {
  const runtime: StorefrontRuntime = {
    PUBLIC_API_URL: apiBaseUrl,
    BACKEND_API: backend,
  };
  return requestRuntime.run(runtime, task);
}

function fetcher(fetch: (request: Request) => Promise<Response>): Fetcher {
  return { fetch } as unknown as Fetcher;
}

beforeEach(() => {
  vi.stubEnv("SSR", true);
  vi.stubEnv("DEV", false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("storefront API service-binding boundary", () => {
  it("pins public reads to the render's cache generation and never sends it on private calls", async () => {
    const seen: Request[] = [];
    const backend = fetcher(async (request) => {
      seen.push(request);
      return new Response("{}");
    });
    const runtime: StorefrontRuntime = {
      PUBLIC_API_URL: apiBaseUrl,
      BACKEND_API: backend,
      CACHE_GENERATION: "a1b2c3d4e5f60718",
    };

    await requestRuntime.run(runtime, async () => {
      await apiFetch(`${apiBaseUrl}/products`, {}, { auth: false });
      await apiFetch(`${apiBaseUrl}/checkout/config`, {}, { auth: false });
      await apiFetch(`${apiBaseUrl}/orders`, { method: "POST", body: "{}" }, { auth: false });
    });

    expect(seen.map((request) => request.headers.get("X-Scalius-Cache-Generation"))).toEqual([
      "a1b2c3d4e5f60718",
      null,
      null,
    ]);
  });

  it("uses one HTTPS fallback after a safe public binding read times out", async () => {
    const bindingFetch = vi.fn((request: Request) =>
      new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason));
      }));
    const httpFetch = vi.fn(async () => new Response("fallback ok"));
    vi.stubGlobal("fetch", httpFetch);

    const response = await runWithBackend(fetcher(bindingFetch), () =>
      apiFetch(`${apiBaseUrl}/seo`, {}, {
        retries: 3,
        timeout: 5,
        auth: false,
        logTerminalFailure: false,
      }),
    );

    expect(await response.text()).toBe("fallback ok");
    expect(bindingFetch).toHaveBeenCalledTimes(1);
    expect(httpFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a credentialed read", "/seo", { Cookie: "session=placeholder" }],
    ["a private-path read", "/checkout/config", {}],
  ])("does not fall back after %s times out on the binding", async (_label, path, headers) => {
    const bindingFetch = vi.fn((request: Request) =>
      new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason));
      }));
    const httpFetch = vi.fn();
    vi.stubGlobal("fetch", httpFetch);

    await expect(runWithBackend(fetcher(bindingFetch), () => apiFetch(
      `${apiBaseUrl}${path}`,
      { headers },
      { retries: 3, timeout: 5, auth: false, logTerminalFailure: false },
    ))).rejects.toThrow("Storefront API service binding timed out");

    expect(bindingFetch).toHaveBeenCalledTimes(1);
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it("bounds a single HTTPS fallback after an immediate binding failure", async () => {
    const bindingFetch = vi.fn(async () => {
      throw new Error("binding unavailable");
    });
    const httpFetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }));
    vi.stubGlobal("fetch", httpFetch);

    await expect(runWithBackend(fetcher(bindingFetch), () =>
      apiFetch(`${apiBaseUrl}/seo`, {}, {
        retries: 3,
        timeout: 5,
        auth: false,
        logTerminalFailure: false,
      }),
    )).rejects.toThrow("Storefront API HTTPS fallback timed out");

    expect(bindingFetch).toHaveBeenCalledTimes(1);
    expect(httpFetch).toHaveBeenCalledTimes(1);
  });

  it("uses HTTPS exactly once when no binding exists", async () => {
    const httpFetch = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", httpFetch);

    const response = await runWithBackend(undefined, () =>
      apiFetch(`${apiBaseUrl}/seo`, {}, { retries: 0, timeout: 50, auth: false }),
    );

    expect(await response.text()).toBe("ok");
    expect(httpFetch).toHaveBeenCalledTimes(1);
  });

  it("never falls back for authenticated writes", async () => {
    const bindingFetch = vi.fn(async () => {
      throw new Error("binding unavailable");
    });
    const httpFetch = vi.fn();
    vi.stubGlobal("fetch", httpFetch);

    await expect(requestRuntime.run({
      PUBLIC_API_URL: apiBaseUrl,
      BACKEND_API: fetcher(bindingFetch),
      apiJwt: {
        token: "header.payload.signature",
        expiresAt: Date.now() + 600_000,
        refresh: null,
      },
    }, () => apiFetch(
      `${apiBaseUrl}/orders`,
      { method: "POST", body: "{}" },
      { retries: 3, timeout: 50, auth: true, logTerminalFailure: false },
    ))).rejects.toThrow("binding unavailable");

    expect(bindingFetch).toHaveBeenCalledTimes(1);
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it("renders through the service binding when the public API URL is not saved yet", async () => {
    const bindingFetch = vi.fn(async (request: Request) => new Response(request.url));
    const httpFetch = vi.fn(async () => new Response("unexpected"));
    vi.stubGlobal("fetch", httpFetch);

    const runtime: StorefrontRuntime = { BACKEND_API: fetcher(bindingFetch) };
    const response = await requestRuntime.run(runtime, () =>
      apiFetch("/products", {}, {
        retries: 0,
        timeout: 5,
        auth: false,
        logTerminalFailure: false,
      }),
    );

    expect(await response.text()).toBe("https://api.internal/api/v1/products");
    expect(bindingFetch).toHaveBeenCalledTimes(1);
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it("fails closed without a binding when the public API URL is not saved yet", () => {
    const runtime: StorefrontRuntime = {};
    expect(() => requestRuntime.run(runtime, () => createApiUrl("/products"))).toThrow(
      "Settings -> System -> Platform",
    );
  });

  it("forwards an abort signal to the binding request", async () => {
    let signal: AbortSignal | undefined;
    const bindingFetch = vi.fn(async (request: Request) => {
      signal = request.signal;
      return new Response("ok");
    });
    vi.stubGlobal("fetch", vi.fn());

    await runWithBackend(fetcher(bindingFetch), () =>
      apiFetch(`${apiBaseUrl}/seo`, {}, { retries: 0, timeout: 50, auth: false }),
    );

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });
});

describe("resolveBackendTarget", () => {
  it("uses the service binding with the internal origin in production", async () => {
    vi.stubEnv("DEV", false);
    const bindingFetch = vi.fn(async () => new Response("ok"));
    const httpFetch = vi.fn();
    vi.stubGlobal("fetch", httpFetch);

    const target = resolveBackendTarget("/api/v1/customer-auth/logout", {
      fetch: bindingFetch,
    } as unknown as Fetcher);

    expect(target).toMatchObject({
      url: "https://api.internal/api/v1/customer-auth/logout",
      viaServiceBinding: true,
    });
    await target!.fetch(target!.url, { method: "POST" });
    expect(bindingFetch).toHaveBeenCalledWith(
      "https://api.internal/api/v1/customer-auth/logout",
      { method: "POST" },
    );
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it("fails closed in production without the binding", () => {
    vi.stubEnv("DEV", false);
    expect(resolveBackendTarget("/api/v1/customer-auth/logout", undefined)).toBeNull();
  });

  it("defaults to the current request's binding", () => {
    vi.stubEnv("DEV", false);
    const bindingFetch = vi.fn(async () => new Response("ok"));
    const backend = { fetch: bindingFetch } as unknown as Fetcher;

    expect(resolveBackendTarget("/api/v1/platform")).toBeNull();
    expect(
      requestRuntime.run({ BACKEND_API: backend }, () =>
        resolveBackendTarget("/api/v1/platform"),
      ),
    ).toMatchObject({
      url: "https://api.internal/api/v1/platform",
      viaServiceBinding: true,
    });
  });

  it("uses plain HTTP to the fixed local API port in astro dev, ignoring the binding", async () => {
    vi.stubEnv("DEV", true);
    const bindingFetch = vi.fn();
    const httpFetch = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", httpFetch);

    const target = resolveBackendTarget("api/v1/platform", {
      fetch: bindingFetch,
    } as unknown as Fetcher);

    expect(target).toMatchObject({
      url: "http://localhost:8787/api/v1/platform",
      viaServiceBinding: false,
    });
    await target!.fetch(target!.url);
    expect(httpFetch).toHaveBeenCalledWith("http://localhost:8787/api/v1/platform", undefined);
    expect(bindingFetch).not.toHaveBeenCalled();
  });
});

describe("withEdgeCache", () => {
  function runRequest<T>(callback: () => T): T {
    return requestRuntime.run({ inflightReads: new Map() }, callback);
  }

  it("deduplicates only concurrent identical reads", async () => {
    let resolveFetch: ((value: string) => void) | undefined;
    const fetcher = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const [first, duplicate] = runRequest(() => [
      withEdgeCache("layout", fetcher),
      withEdgeCache("layout", fetcher),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);

    resolveFetch?.("fresh");
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      "fresh",
      "fresh",
    ]);

    fetcher.mockResolvedValueOnce("new-read");
    await expect(withEdgeCache("layout", fetcher)).resolves.toBe("new-read");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("never shares an in-flight backend promise across requests", async () => {
    let resolveFirst: ((value: string) => void) | undefined;
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(
        () => new Promise<string>((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValueOnce("second-request");

    const first = runRequest(() => withEdgeCache("layout", fetcher));
    const second = runRequest(() => withEdgeCache("layout", fetcher));

    await expect(second).resolves.toBe("second-request");
    expect(fetcher).toHaveBeenCalledTimes(2);
    resolveFirst?.("first-request");
    await expect(first).resolves.toBe("first-request");
  });

  it("does not retain failures", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce("recovered");

    await expect(withEdgeCache("settings", fetcher)).resolves.toBeNull();
    await expect(withEdgeCache("settings", fetcher)).resolves.toBe("recovered");
    expect(fetcher).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
