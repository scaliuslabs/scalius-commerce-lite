import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CURRENT_DATABASE_SCHEMA_MIGRATIONS,
} from "@scalius/database/schema-contract";

import { readinessRoutes } from "./readiness";
import { requestCorrelationMiddleware } from "../utils/http-correlation";

function createKv(options: { delayMs?: number } = {}) {
  return {
    get: vi.fn(async () => {
      if (options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }

      return null;
    }),
  } as unknown as KVNamespace;
}

function createDb(options: {
  delayMs?: number;
  fail?: boolean;
  transientFailures?: number;
  schemaVersion?: number;
  schemaName?: string;
  schemaSha256?: string;
  schemaRows?: readonly {
    version: number;
    name: string;
    sourceSha256: string;
  }[];
} = {}) {
  let attempts = 0;
  return {
    prepare: vi.fn(() => {
      const statement = {
        bind: vi.fn(() => statement),
        all: vi.fn(async () => {
          if (options.delayMs) {
            await new Promise((resolve) => setTimeout(resolve, options.delayMs));
          }
          attempts += 1;
          if (options.transientFailures && attempts <= options.transientFailures) {
            throw new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long.");
          }
          if (options.fail) {
            throw new Error("D1 unavailable");
          }
          return {
            success: true,
            meta: {},
            results: options.schemaRows ?? [{
              version: options.schemaVersion ?? 50,
              name: options.schemaName ?? "0050_schema_release_contract",
              sourceSha256: options.schemaSha256
                ?? CURRENT_DATABASE_SCHEMA_MIGRATIONS[0].sourceSha256,
            }],
          };
        }),
      };
      return statement;
    }),
  } as unknown as D1Database;
}

function createBucket(options: { delayMs?: number } = {}) {
  return {
    list: vi.fn(async () => {
      if (options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }

      return {
        objects: [],
        truncated: false,
        delimitedPrefixes: [],
      };
    }),
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
  app.use("*", requestCorrelationMiddleware);
  app.route("/", readinessRoutes);
  return app;
}

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: createDb(),
    CACHE: createKv(),
    SHARED_AUTH_CACHE: createKv(),
    BUCKET: createBucket(),
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

afterEach(() => {
  vi.restoreAllMocks();
});

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
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = createEnv({
      DB: createDb({ fail: true }),
      PAYMENT_EVENTS_QUEUE: undefined as unknown as Queue,
      STOREFRONT_CACHE_QUEUE: undefined as unknown as Queue,
      STOREFRONT_URL: "",
      PURGE_TOKEN: "",
    });

    const response = await app.request("/api/v1/readyz", {
      headers: {
        "X-Request-Id": "req_readyz_1234",
        "CF-Ray": "readyz123-DAC",
      },
    }, env);
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
    expect(response.headers.get("X-Request-Id")).toBe("req_readyz_1234");

    const readinessLog = warn.mock.calls.find((call) => {
      if (call[0] !== "[api-ops]" || typeof call[1] !== "string") return false;
      return (JSON.parse(call[1]) as { event?: string }).event === "api.readyz.degraded";
    });
    expect(readinessLog).toBeTruthy();
    expect(JSON.parse(readinessLog?.[1] as string)).toMatchObject({
      event: "api.readyz.degraded",
      requestId: "req_readyz_1234",
      cfRay: "readyz123-DAC",
      degradedChecks: [
        "d1:error",
        "payment_events_queue:missing",
        "storefront_cache_queue:missing",
        "runtime_config:missing",
      ],
    });
  });

  it("retries transient D1 overloads before marking readiness degraded", async () => {
    vi.useFakeTimers();
    const app = createApp();
    const db = createDb({ transientFailures: 2 });
    const env = createEnv({ DB: db });

    try {
      const responsePromise = app.request("/api/v1/readyz", {}, env);
      await vi.advanceTimersByTimeAsync(75);
      await vi.advanceTimersByTimeAsync(200);
      const response = await responsePromise;
      const json = await response.json() as {
        success?: boolean;
        status?: string;
        checks?: Record<string, { status?: string; detail?: string }>;
      };

      expect(response.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.status).toBe("ready");
      expect(json.checks?.d1).toMatchObject({
        status: "ok",
        detail: "schema 50/0050_schema_release_contract",
      });
      expect(db.prepare).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows remote D1 variance within the remote-storage readiness budget", async () => {
    vi.useFakeTimers();
    const app = createApp();
    const env = createEnv({ DB: createDb({ delayMs: 4000 }) });

    try {
      const responsePromise = app.request("/api/v1/readyz", {}, env);
      await vi.advanceTimersByTimeAsync(4000);
      const response = await responsePromise;
      const json = await response.json() as {
        success?: boolean;
        status?: string;
        checks?: Record<string, { status?: string; detail?: string }>;
      };

      expect(response.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.status).toBe("ready");
      expect(json.checks?.d1).toMatchObject({
        status: "ok",
        detail: "schema 50/0050_schema_release_contract",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when the reachable database schema is outdated", async () => {
    const app = createApp();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = createEnv({
      DB: createDb({
        schemaVersion: 49,
        schemaName: "0049_checkout_side_effect_authority_fence",
      }),
    });

    const response = await app.request("/api/v1/readyz", {}, env);
    const json = await response.json() as {
      success?: boolean;
      checks?: Record<string, { status?: string; detail?: string }>;
    };

    expect(response.status).toBe(503);
    expect(json.success).toBe(false);
    expect(json.checks?.d1).toMatchObject({
      status: "error",
      detail: expect.stringContaining("diverges at version 50"),
    });
  });

  it.each([
    ["missing", []],
    ["extra lower", [
      { version: 49, name: "0049_legacy", sourceSha256: "a".repeat(64) },
      ...CURRENT_DATABASE_SCHEMA_MIGRATIONS,
    ]],
    ["future", [
      ...CURRENT_DATABASE_SCHEMA_MIGRATIONS,
      { version: 51, name: "0051_future", sourceSha256: "b".repeat(64) },
    ]],
    ["bad digest", [{
      ...CURRENT_DATABASE_SCHEMA_MIGRATIONS[0],
      sourceSha256: "c".repeat(64),
    }]],
  ])("fails closed for a %s D1 schema ledger", async (_label, schemaRows) => {
    const app = createApp();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await app.request("/api/v1/readyz", {}, createEnv({
      DB: createDb({ schemaRows }),
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      success: false,
      checks: { d1: { status: "error" } },
    });
  });

  it("allows remote KV variance within the remote-storage readiness budget", async () => {
    vi.useFakeTimers();
    const app = createApp();
    const env = createEnv({ SHARED_AUTH_CACHE: createKv({ delayMs: 4000 }) });

    try {
      const responsePromise = app.request("/api/v1/readyz", {}, env);
      await vi.advanceTimersByTimeAsync(4000);
      const response = await responsePromise;
      const json = await response.json() as {
        success?: boolean;
        status?: string;
        checks?: Record<string, { status?: string; detail?: string }>;
      };

      expect(response.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.status).toBe("ready");
      expect(json.checks?.shared_auth_kv).toMatchObject({
        status: "ok",
        detail: "read probe",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows remote R2 variance within the remote-storage readiness budget", async () => {
    vi.useFakeTimers();
    const app = createApp();
    const env = createEnv({ BUCKET: createBucket({ delayMs: 4000 }) });

    try {
      const responsePromise = app.request("/api/v1/readyz", {}, env);
      await vi.advanceTimersByTimeAsync(4000);
      const response = await responsePromise;
      const json = await response.json() as {
        success?: boolean;
        status?: string;
        checks?: Record<string, { status?: string; detail?: string }>;
      };

      expect(response.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.status).toBe("ready");
      expect(json.checks?.r2).toMatchObject({
        status: "ok",
        detail: "list limit 1",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
