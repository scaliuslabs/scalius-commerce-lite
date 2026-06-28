import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it, vi } from "vitest";

import { readinessRoutes } from "./readiness";

function createKv() {
  return {
    get: vi.fn(async () => null),
  } as unknown as KVNamespace;
}

function createDb(options: { fail?: boolean } = {}) {
  return {
    prepare: vi.fn(() => ({
      first: vi.fn(async () => {
        if (options.fail) {
          throw new Error("D1 unavailable");
        }
        return { ok: 1 };
      }),
    })),
  } as unknown as D1Database;
}

function createBucket() {
  return {
    list: vi.fn(async () => ({
      objects: [],
      truncated: false,
      delimitedPrefixes: [],
    })),
  } as unknown as R2Bucket;
}

function createQueue() {
  return {
    send: vi.fn(async () => undefined),
    sendBatch: vi.fn(async () => undefined),
  } as unknown as Queue;
}

function createApp() {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.route("/", readinessRoutes);
  return app;
}

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: createDb(),
    CACHE: createKv(),
    SHARED_AUTH_CACHE: createKv(),
    BUCKET: createBucket(),
    WidgetDesignAgent: {} as DurableObjectNamespace,
    PAYMENT_EVENTS_QUEUE: createQueue(),
    ORDER_NOTIFICATIONS_QUEUE: createQueue(),
    AUTH_OTP_QUEUE: createQueue(),
    STOREFRONT_CACHE_QUEUE: createQueue(),
    BETTER_AUTH_SECRET: "test-secret",
    PUBLIC_API_BASE_URL: "https://api.example.test",
    STOREFRONT_URL: "https://storefront.example.test",
    BETTER_AUTH_URL: "https://dashboard.example.test",
    R2_PUBLIC_URL: "https://cloud.example.test",
    PURGE_URL: "https://storefront.example.test/api/purge-cache",
    PURGE_TOKEN: "purge-secret",
    ...overrides,
  } as Env;
}

describe("API readiness route", () => {
  it("returns ready when required platform bindings respond", async () => {
    const app = createApp();
    const env = createEnv();

    const response = await app.request("/api/v1/readyz", {}, env);
    const json = await response.json() as {
      success?: boolean;
      status?: string;
      checks?: Record<string, { status?: string }>;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(json.success).toBe(true);
    expect(json.status).toBe("ready");
    expect(json.checks).toMatchObject({
      d1: { status: "ok" },
      api_cache_kv: { status: "ok" },
      shared_auth_kv: { status: "ok" },
      r2: { status: "ok" },
      payment_events_queue: { status: "ok" },
      order_notifications_queue: { status: "ok" },
      auth_otp_queue: { status: "ok" },
      storefront_cache_queue: { status: "ok" },
      runtime_config: { status: "ok" },
    });
  });

  it("returns degraded with per-check details when a required probe fails", async () => {
    const app = createApp();
    const env = createEnv({
      DB: createDb({ fail: true }),
      PAYMENT_EVENTS_QUEUE: undefined as unknown as Queue,
      STOREFRONT_CACHE_QUEUE: undefined as unknown as Queue,
      STOREFRONT_URL: "",
      PURGE_TOKEN: "",
    });

    const response = await app.request("/api/v1/readyz", {}, env);
    const json = await response.json() as {
      success?: boolean;
      status?: string;
      checks?: Record<string, { status?: string; detail?: string }>;
    };

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(json.success).toBe(false);
    expect(json.status).toBe("degraded");
    expect(json.checks?.d1).toMatchObject({
      status: "error",
      detail: "D1 unavailable",
    });
    expect(json.checks?.payment_events_queue).toMatchObject({
      status: "missing",
      detail: "queue binding is not configured",
    });
    expect(json.checks?.storefront_cache_queue).toMatchObject({
      status: "missing",
      detail: "queue binding is not configured",
    });
    expect(json.checks?.runtime_config).toMatchObject({
      status: "missing",
      detail: "missing STOREFRONT_URL, PURGE_TOKEN",
    });
  });
});
