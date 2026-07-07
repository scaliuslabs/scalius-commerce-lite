import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { INVALIDATION_GROUPS } from "../utils/cache-invalidation";
import { errorResponseFromError } from "../utils/api-response";
import { cacheControlRoutes } from "./cache";

function createKvMock() {
  const store = new Map<string, string>([
    ["sc:api:products:one", JSON.stringify({ cached: true })],
    [
      "sc:_api_cache_fence:api%3Aproducts%3A",
      JSON.stringify({
        schema: 1,
        scope: "api:products:",
        version: "old",
        updatedAt: 1000,
      }),
    ],
  ]);

  const kv = {
    list: vi.fn(async ({ prefix }: { prefix?: string }) => ({
      keys: Array.from(store.keys())
        .filter((name) => !prefix || name.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
    })),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
  };

  return { kv, store };
}

function createTestApp() {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.route("/cache", cacheControlRoutes);
  return app;
}

function createExecutionContext() {
  const waitUntilPromises: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: vi.fn((promise: Promise<unknown>) => {
      waitUntilPromises.push(Promise.resolve(promise));
    }),
  };

  return { executionCtx, waitUntilPromises };
}

async function drainWaitUntil(promises: Promise<unknown>[]) {
  for (let index = 0; index < promises.length; index += 1) {
    await promises[index];
  }
}

function getAllStorefrontPrefixes() {
  return [
    ...new Set(
      Object.values(INVALIDATION_GROUPS).flatMap(
        (group) => group.storefrontPrefixes,
      ),
    ),
  ];
}

describe("cache control routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("bumps API cache fences and reports per-group timestamps when clearing all cache", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T10:00:00.000Z"));

    try {
      const app = createTestApp();
      const { kv, store } = createKvMock();

      const response = await app.request(
        "/api/v1/cache/clear",
        { method: "POST" },
        { CACHE: kv } as never,
      );
      const body = (await response.json()) as {
        success: boolean;
        data?: { message?: string };
      };

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(kv.list).toHaveBeenCalledWith({ prefix: "sc:api:" });
      expect(kv.delete).toHaveBeenCalledWith("sc:api:products:one");
      expect(store.has("sc:api:products:one")).toBe(false);

      expect(kv.put).toHaveBeenCalledWith(
        "sc:_api_cache_fence:api%3A",
        expect.stringContaining(`"updatedAt":${Date.now()}`),
        { expirationTtl: 86400 * 30 },
      );
      expect(kv.put).toHaveBeenCalledWith(
        "sc:_api_cache_fence:api%3Aproducts%3A",
        expect.stringContaining(`"updatedAt":${Date.now()}`),
        { expirationTtl: 86400 * 30 },
      );

      const lastClearedResponse = await app.request(
        "/api/v1/cache/last-cleared",
        {},
        { CACHE: kv } as never,
      );
      const lastCleared = (await lastClearedResponse.json()) as {
        success: boolean;
        data?: { timestamps?: Record<string, number | null> };
      };

      expect(lastClearedResponse.status).toBe(200);
      expect(lastCleared.success).toBe(true);
      expect(lastCleared.data?.timestamps?.products).toBe(Date.now());
      expect(Object.keys(lastCleared.data?.timestamps ?? {})).toEqual(
        Object.keys(INVALIDATION_GROUPS),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("enqueues a durable storefront purge for every cache group when clearing all cache", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T10:00:00.000Z"));

    try {
      const app = createTestApp();
      const { kv } = createKvMock();
      const queueSend = vi.fn(async (_message: unknown) => undefined);
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      const { executionCtx, waitUntilPromises } = createExecutionContext();

      vi.stubGlobal("fetch", fetchMock);

      const response = await app.request(
        "/api/v1/cache/clear",
        { method: "POST" },
        {
          CACHE: kv,
          PURGE_URL: "https://storefront.example.com/api/purge-cache?token=secret-token&mode=fast",
          PURGE_TOKEN: "secret-token",
          STOREFRONT_CACHE_QUEUE: { send: queueSend },
        } as never,
        executionCtx as never,
      );
      await drainWaitUntil(waitUntilPromises);

      expect(response.status).toBe(200);
      expect(queueSend).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);

      const message = queueSend.mock.calls[0]?.[0] as {
        type?: string;
        operationId?: string;
        groups?: string[];
        prefixes?: string[];
        bumpVersion?: boolean;
        source?: string;
        requestedAt?: number;
      };

      expect(message).toMatchObject({
        type: "storefront.cache_purge",
        operationId: expect.any(String),
        groups: Object.keys(INVALIDATION_GROUPS),
        prefixes: getAllStorefrontPrefixes(),
        bumpVersion: true,
        source: "groups",
        requestedAt: Date.now(),
      });
      expect(JSON.stringify(message)).not.toContain("secret-token");
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to a sanitized direct storefront purge when the durable queue is missing", async () => {
    const app = createTestApp();
    const { kv } = createKvMock();
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { executionCtx, waitUntilPromises } = createExecutionContext();

    vi.stubGlobal("fetch", fetchMock);

    const response = await app.request(
      "/api/v1/cache/clear",
      { method: "POST" },
      {
        CACHE: kv,
        PURGE_URL: "https://storefront.example.com/api/purge-cache?token=secret-token&mode=fast",
        PURGE_TOKEN: "secret-token",
      } as never,
      executionCtx as never,
    );
    await drainWaitUntil(waitUntilPromises);

    expect(response.status).toBe(200);
    expect(consoleWarn).toHaveBeenCalledWith(
      "[Cache] Durable storefront cache purge queue unavailable (missing-queue); falling back to direct purge.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://storefront.example.com/api/purge-cache?mode=fast",
    );
    expect(String(url)).not.toContain("secret-token");
    expect(new URL(String(url)).searchParams.has("token")).toBe(false);
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      groups: Object.keys(INVALIDATION_GROUPS),
      prefixes: getAllStorefrontPrefixes(),
      bumpVersion: true,
    });
  });
});
