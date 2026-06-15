import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it, vi } from "vitest";

import { INVALIDATION_GROUPS } from "../utils/cache-invalidation";
import { errorResponseFromError } from "../utils/api-response";
import { cacheControlRoutes } from "./cache";

function createKvMock() {
  const store = new Map<string, string>([
    ["sc:api:products:one", JSON.stringify({ cached: true })],
    ["sc:_last_cleared:products", "1000"],
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

describe("cache control routes", () => {
  it("persists per-group last-cleared timestamps when clearing all cache", async () => {
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

      const groupNames = Object.keys(INVALIDATION_GROUPS);
      expect(kv.put).toHaveBeenCalledTimes(groupNames.length);
      for (const group of groupNames) {
        expect(kv.put).toHaveBeenCalledWith(
          `sc:_last_cleared:${group}`,
          String(Date.now()),
          { expirationTtl: 86400 * 30 },
        );
      }

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
    } finally {
      vi.useRealTimers();
    }
  });
});
