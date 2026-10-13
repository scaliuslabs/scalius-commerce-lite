import { OpenAPIHono } from "@hono/zod-openapi";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "@scalius/database/schema";
import {
  createMigratedSqlite,
  createSqliteD1Binding,
  withSimulatedQueryCache,
} from "@scalius/database/testing/sqlite-d1";
import type { Database } from "@scalius/database/types";

const database = vi.hoisted(() => ({ current: undefined as unknown }));

// PostgreSQL is selected from the env; the reads and writes run on SQLite with
// the real schema so the probe's SQL executes for real.
vi.mock("@scalius/database/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@scalius/database/client")>(),
  getDb: () => database.current,
}));

const { readinessRoutes } = await import("./readiness");

function useDatabase(cached: boolean): void {
  const binding = createSqliteD1Binding(createMigratedSqlite());
  database.current = drizzle(
    cached ? withSimulatedQueryCache(binding) : binding,
    { schema },
  ) as unknown as Database;
}

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    POSTGRES_DATABASE_URL: "postgresql://hyperdrive.internal/scalius",
    BUCKET: { list: vi.fn(async () => ({ objects: [], truncated: false, delimitedPrefixes: [] })) },
    JOBS_QUEUE: { send: vi.fn(), sendBatch: vi.fn() },
    RL_STRICT: { limit: vi.fn() },
    RL_STANDARD: { limit: vi.fn() },
    SCALIUS_SECRET: "test-master-secret-with-at-least-thirty-two-characters",
    CREDENTIAL_ENCRYPTION_KEY: "test-credential-key",
    PLATFORM_CONFIG: {
      storefrontUrl: "https://storefront.example.test",
      apiUrl: "https://api.example.test",
      dashboardUrl: "https://dashboard.example.test",
      mediaUrl: "https://cloud.example.test",
      customerAuthCookieDomain: "",
      corsAllowedOrigins: [],
      setupTokenRequired: false,
      identityHandoff: {
        enabled: false,
        issuer: "",
        audience: "",
        jwksUrl: "",
        localLoginDisabled: false,
      },
    },
    ...overrides,
  } as unknown as Env;
}

async function readyz(env: Env) {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.route("/", readinessRoutes);
  const response = await app.request("/api/v1/readyz", {}, env);
  const json = await response.json() as {
    status?: string;
    checks?: Record<string, { status?: string; detail?: string }>;
  };
  return { status: response.status, json };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PostgreSQL readiness read-freshness probe", () => {
  it("is ready when a read sees the write before it", async () => {
    useDatabase(false);

    const { status, json } = await readyz(createEnv());

    expect(status).toBe(200);
    expect(json.checks?.postgres).toMatchObject({ status: "ok" });
    expect(json.checks?.postgres?.detail).toMatch(/reads uncached$/);
  });

  it("fails closed when Hyperdrive query caching serves a stale read", async () => {
    useDatabase(true);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { status, json } = await readyz(createEnv());

    expect(status).toBe(503);
    expect(json.status).toBe("degraded");
    expect(json.checks?.postgres).toMatchObject({ status: "error" });
    expect(json.checks?.postgres?.detail).toContain("--caching-disabled");
  });

  it("skips the write probe while a cutover freeze copies the database", async () => {
    useDatabase(true);

    const { status, json } = await readyz(createEnv({ DATABASE_MIGRATION_FREEZE: "1" }));

    expect(status).toBe(200);
    expect(json.checks?.postgres?.detail).toMatch(/unchecked during write freeze$/);
  });
});
