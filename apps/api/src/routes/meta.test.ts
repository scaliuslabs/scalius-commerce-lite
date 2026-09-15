import { OpenAPIHono } from "@hono/zod-openapi";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CURRENT_DATABASE_SCHEMA,
  CURRENT_DATABASE_SCHEMA_MIGRATIONS,
} from "@scalius/database/schema-contract";

import { API_RELEASE_VERSION } from "../release";
import { classifySchemaLedger, metaRoutes } from "./meta";

type LedgerRow = { version: number; name: string; sourceSha256: string };

function createDb(rows: LedgerRow[] | Error) {
  const all = async () => {
    if (rows instanceof Error) throw rows;
    return rows;
  };
  return {
    select: () => ({ from: () => ({ orderBy: () => ({ all }) }) }),
  };
}

function createApp(rows: LedgerRow[] | Error) {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  app.use("*", async (c, next) => {
    c.set("db", createDb(rows) as never);
    await next();
  });
  app.route("/meta", metaRoutes);
  return app;
}

const PLATFORM = {
  storefrontUrl: "https://shop.example.com",
  apiUrl: "https://api.example.com",
  dashboardUrl: "https://shop.example.com/dashboard",
  mediaUrl: "https://cdn.example.com",
  customerAuthCookieDomain: "",
  corsAllowedOrigins: [] as string[],
  setupTokenRequired: true,
  identityHandoff: {
    enabled: true,
    issuer: "https://idp.example.com",
    audience: "scalius:store-1",
    jwksUrl: "",
    localLoginDisabled: false,
  },
};

const FULL_LEDGER = CURRENT_DATABASE_SCHEMA_MIGRATIONS.map((row) => ({ ...row }));

describe("GET /api/v1/meta", () => {
  it("reports the release, API majors, provider, schema revision, and automation contracts", async () => {
    const response = await createApp(FULL_LEDGER).request(
      "/api/v1/meta",
      {},
      { PLATFORM_CONFIG: PLATFORM, DB: {} } as unknown as Env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        platform: { name: "scalius-commerce", version: API_RELEASE_VERSION },
        api: {
          current: "v1",
          supportedMajors: ["v1"],
          basePath: "/api/v1",
          openapi: "/api/v1/openapi.json",
        },
        database: {
          provider: "d1",
          schema: {
            expected: { ...CURRENT_DATABASE_SCHEMA },
            applied: { ...CURRENT_DATABASE_SCHEMA },
            status: "current",
          },
        },
        automation: {
          setupTokenRequired: true,
          identityHandoffEnabled: true,
          localLoginDisabled: false,
          dashboardBasePath: "/dashboard",
          frontProxySignature: "v1",
        },
      },
    });
  });

  it("answers before the platform is configured and when the ledger table does not exist", async () => {
    const response = await createApp(new Error("no such table: scalius_schema_migrations")).request(
      "/api/v1/meta",
      {},
      { DB: {} } as unknown as Env,
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { data: Record<string, unknown> };
    expect(body.data.database).toEqual({
      provider: "d1",
      schema: {
        expected: { ...CURRENT_DATABASE_SCHEMA },
        applied: null,
        status: "unavailable",
        detail: "no such table: scalius_schema_migrations",
      },
    });
    expect(body.data.automation).toEqual({
      setupTokenRequired: false,
      identityHandoffEnabled: false,
      localLoginDisabled: false,
      dashboardBasePath: "",
      frontProxySignature: "v1",
    });
  });

  it("reports the configured provider and null when the database configuration is invalid", async () => {
    const turso = await createApp(FULL_LEDGER).request(
      "/api/v1/meta",
      {},
      {
        DATABASE_PROVIDER: "turso",
        TURSO_DATABASE_URL: "libsql://store.turso.io",
        TURSO_AUTH_TOKEN: "token",
      } as unknown as Env,
    );
    expect(((await turso.json()) as { data: { database: { provider: string } } }).data.database.provider).toBe("turso");

    const invalid = await createApp(FULL_LEDGER).request(
      "/api/v1/meta",
      {},
      { DATABASE_PROVIDER: "oracle" } as unknown as Env,
    );
    expect(((await invalid.json()) as { data: { database: { provider: null } } }).data.database.provider).toBeNull();
  });

  it("exposes a stable system operation id", () => {
    const spec = createApp(FULL_LEDGER).getOpenAPIDocument({
      openapi: "3.0.0",
      info: { title: "meta", version: "test" },
    });
    const operation = (spec.paths?.["/api/v1/meta"] as Record<string, { operationId?: string }> | undefined)?.get;

    expect(operation?.operationId).toBe("system.meta.get");
  });
});

describe("classifySchemaLedger", () => {
  it("distinguishes empty, behind, current, ahead, and diverged ledgers", () => {
    expect(classifySchemaLedger([])).toEqual({ applied: null, status: "behind" });
    expect(classifySchemaLedger(FULL_LEDGER.slice(0, 3))).toEqual({
      applied: { version: FULL_LEDGER[2]!.version, name: FULL_LEDGER[2]!.name },
      status: "behind",
    });
    expect(classifySchemaLedger(FULL_LEDGER)).toEqual({
      applied: { ...CURRENT_DATABASE_SCHEMA },
      status: "current",
    });
    const future = { version: CURRENT_DATABASE_SCHEMA.version + 1, name: "0099_future", sourceSha256: "f".repeat(64) };
    expect(classifySchemaLedger([...FULL_LEDGER, future])).toEqual({
      applied: { version: future.version, name: future.name },
      status: "ahead",
    });
    const diverged = [{ ...FULL_LEDGER[0]!, sourceSha256: "0".repeat(64) }, ...FULL_LEDGER.slice(1)];
    expect(classifySchemaLedger(diverged)).toEqual({
      applied: { ...CURRENT_DATABASE_SCHEMA },
      status: "diverged",
    });
    // Order in the ledger does not matter; version order does.
    expect(classifySchemaLedger([...FULL_LEDGER].reverse()).status).toBe("current");
  });
});

describe("release identity", () => {
  it("matches the API package version so the /meta document is truthful", () => {
    const packageJson = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
    ) as { version: string };
    expect(API_RELEASE_VERSION).toBe(packageJson.version);
  });
});
