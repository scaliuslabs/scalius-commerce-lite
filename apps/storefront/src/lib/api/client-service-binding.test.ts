import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiContext, type ApiContext } from "./context";
import { fetchWithRetry } from "./client";

const contextMock = vi.hoisted(() => {
  let current: ApiContext | undefined;
  return {
    apiContext: {
      getStore: () => current,
      run: <R>(store: ApiContext, task: () => R): R => {
        const previous = current;
        current = store;
        try {
          const result = task();
          if (result instanceof Promise) {
            return result.finally(() => {
              current = previous;
            }) as R;
          }
          current = previous;
          return result;
        } catch (error) {
          current = previous;
          throw error;
        }
      },
    },
  };
});

vi.mock("./context", () => ({ apiContext: contextMock.apiContext }));

const apiBaseUrl = "https://api.example.test/api/v1";

function runWithBackend<T>(backend: Fetcher | undefined, task: () => T): T {
  const context: ApiContext = {
    PUBLIC_API_URL: apiBaseUrl,
    BACKEND_API: backend,
  };
  return apiContext.run(context, task);
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
  it("does not retry or start HTTPS fallback after a binding timeout", async () => {
    const bindingFetch = vi.fn((request: Request) =>
      new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason));
      }));
    const httpFetch = vi.fn();
    vi.stubGlobal("fetch", httpFetch);

    await expect(runWithBackend(fetcher(bindingFetch), () =>
      fetchWithRetry(`${apiBaseUrl}/seo`, {}, 3, 5, false, false),
    )).rejects.toThrow("Storefront API service binding timed out");

    expect(bindingFetch).toHaveBeenCalledTimes(1);
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it("uses at most one terminal HTTPS fallback after an immediate binding failure", async () => {
    const bindingFetch = vi.fn(async () => {
      throw new Error("binding unavailable");
    });
    const httpFetch = vi.fn(async () => {
      throw new Error("origin unavailable");
    });
    vi.stubGlobal("fetch", httpFetch);

    await expect(runWithBackend(fetcher(bindingFetch), () =>
      fetchWithRetry(`${apiBaseUrl}/seo`, {}, 3, 50, false, false),
    )).rejects.toThrow("origin unavailable");

    expect(bindingFetch).toHaveBeenCalledTimes(1);
    expect(httpFetch).toHaveBeenCalledTimes(1);
  });

  it("uses HTTPS exactly once when no binding exists", async () => {
    const httpFetch = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", httpFetch);

    const response = await runWithBackend(undefined, () =>
      fetchWithRetry(`${apiBaseUrl}/seo`, {}, 0, 50, false),
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

    await expect(apiContext.run({
      PUBLIC_API_URL: apiBaseUrl,
      BACKEND_API: fetcher(bindingFetch),
      apiJwt: {
        token: "header.payload.signature",
        expiresAt: Date.now() + 600_000,
        refresh: null,
      },
    }, () => fetchWithRetry(
      `${apiBaseUrl}/orders`,
      { method: "POST", body: "{}" },
      3,
      50,
      true,
      false,
    ))).rejects.toThrow("binding unavailable");

    expect(bindingFetch).toHaveBeenCalledTimes(1);
    expect(httpFetch).not.toHaveBeenCalled();
  });

  it("forwards an abort signal to the binding request", async () => {
    let signal: AbortSignal | undefined;
    const bindingFetch = vi.fn(async (request: Request) => {
      signal = request.signal;
      return new Response("ok");
    });
    vi.stubGlobal("fetch", vi.fn());

    await runWithBackend(fetcher(bindingFetch), () =>
      fetchWithRetry(`${apiBaseUrl}/seo`, {}, 0, 50, false),
    );

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });
});
