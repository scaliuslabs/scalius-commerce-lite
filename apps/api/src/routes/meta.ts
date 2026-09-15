// apps/api/src/routes/meta.ts
// `GET /api/v1/meta`: the compatibility discovery document for automated and
// managed deployments. It reports the runtime release, the API majors, the
// database provider, the schema revision this build expects, the revision the
// database has actually applied, and which opt-in automation contracts are
// active. It is a probe: it answers while the master secret is missing and
// during a migration freeze, and it never depends on merchant data.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { asc } from "drizzle-orm";
import { resolveDatabaseConfiguration } from "@scalius/database/client";
import { scaliusSchemaMigrations } from "@scalius/database/schema";
import {
  CURRENT_DATABASE_SCHEMA,
  CURRENT_DATABASE_SCHEMA_MIGRATIONS,
} from "@scalius/database/schema-contract";
import {
  EMPTY_PLATFORM_CONFIG,
  dashboardBasePathFromUrl,
} from "@scalius/shared/platform-config";
import { FRONT_PROXY_SIGNATURE_VERSION } from "@scalius/shared/trusted-front-proxy";
import {
  API_CURRENT_MAJOR,
  API_RELEASE_NAME,
  API_RELEASE_VERSION,
  API_SUPPORTED_MAJORS,
} from "../release";
import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();

const schemaIdentitySchema = z.object({
  version: z.number().int(),
  name: z.string(),
});

export const SCHEMA_STATUSES = ["current", "behind", "ahead", "diverged", "unavailable"] as const;
export type SchemaStatus = (typeof SCHEMA_STATUSES)[number];

const metaSchema = z.object({
  platform: z.object({
    name: z.literal(API_RELEASE_NAME),
    version: z.string(),
  }),
  api: z.object({
    current: z.string(),
    supportedMajors: z.array(z.string()),
    basePath: z.string(),
    openapi: z.string(),
  }),
  database: z.object({
    provider: z.enum(["d1", "turso", "postgres"]).nullable(),
    schema: z.object({
      expected: schemaIdentitySchema,
      applied: schemaIdentitySchema.nullable(),
      status: z.enum(SCHEMA_STATUSES),
      /** Present only when the ledger could not be read. */
      detail: z.string().optional(),
    }),
  }),
  automation: z.object({
    setupTokenRequired: z.boolean(),
    identityHandoffEnabled: z.boolean(),
    localLoginDisabled: z.boolean(),
    dashboardBasePath: z.string(),
    frontProxySignature: z.string(),
  }),
});

export type MetaDocument = z.infer<typeof metaSchema>;

interface LedgerRow {
  version: number;
  name: string;
  sourceSha256: string;
}

/**
 * Compares the applied ledger with the release manifest without throwing:
 * automation reads this before and after applying migrations, so every
 * intermediate state must be describable.
 */
export function classifySchemaLedger(rows: readonly LedgerRow[]): {
  applied: { version: number; name: string } | null;
  status: SchemaStatus;
} {
  if (rows.length === 0) return { applied: null, status: "behind" };
  const ordered = [...rows].sort((left, right) => left.version - right.version);
  const latest = ordered.at(-1)!;
  const applied = { version: latest.version, name: latest.name };
  const shared = Math.min(ordered.length, CURRENT_DATABASE_SCHEMA_MIGRATIONS.length);
  for (let index = 0; index < shared; index += 1) {
    const actual = ordered[index]!;
    const expected = CURRENT_DATABASE_SCHEMA_MIGRATIONS[index]!;
    if (
      actual.version !== expected.version
      || actual.name !== expected.name
      || actual.sourceSha256 !== expected.sourceSha256
    ) {
      return { applied, status: "diverged" };
    }
  }
  if (ordered.length === CURRENT_DATABASE_SCHEMA_MIGRATIONS.length) return { applied, status: "current" };
  return { applied, status: ordered.length < CURRENT_DATABASE_SCHEMA_MIGRATIONS.length ? "behind" : "ahead" };
}

function sanitizeDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 160) || "schema ledger unavailable";
}

const metaRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "system.meta.get",
  tags: ["Platform"],
  summary: "Get the runtime release, API majors, database schema revision, and automation contracts",
  responses: {
    200: {
      description: "Compatibility discovery document",
      content: { "application/json": { schema: successEnvelope(metaSchema) } },
    },
    500: errorResponses[500],
  },
});

app.openapi(metaRoute, async (c) => {
  const env = c.env;
  const platform = env.PLATFORM_CONFIG ?? EMPTY_PLATFORM_CONFIG;

  // An incomplete provider configuration must not break discovery: automation
  // reads this endpoint precisely to find out what a half-installed store has.
  let provider: MetaDocument["database"]["provider"];
  try {
    provider = resolveDatabaseConfiguration(env).provider;
  } catch {
    provider = null;
  }

  let schema: MetaDocument["database"]["schema"];
  try {
    const rows = await c.get("db")
      .select({
        version: scaliusSchemaMigrations.version,
        name: scaliusSchemaMigrations.name,
        sourceSha256: scaliusSchemaMigrations.sourceSha256,
      })
      .from(scaliusSchemaMigrations)
      .orderBy(asc(scaliusSchemaMigrations.version))
      .all();
    schema = { expected: { ...CURRENT_DATABASE_SCHEMA }, ...classifySchemaLedger(rows) };
  } catch (error) {
    schema = {
      expected: { ...CURRENT_DATABASE_SCHEMA },
      applied: null,
      status: "unavailable",
      detail: sanitizeDetail(error),
    };
  }

  c.header("Cache-Control", "no-store");
  return ok(c, {
    platform: { name: API_RELEASE_NAME, version: API_RELEASE_VERSION },
    api: {
      current: API_CURRENT_MAJOR,
      supportedMajors: [...API_SUPPORTED_MAJORS],
      basePath: `/api/${API_CURRENT_MAJOR}`,
      openapi: `/api/${API_CURRENT_MAJOR}/openapi.json`,
    },
    database: { provider, schema },
    automation: {
      setupTokenRequired: platform.setupTokenRequired,
      identityHandoffEnabled: platform.identityHandoff.enabled,
      localLoginDisabled: platform.identityHandoff.localLoginDisabled,
      dashboardBasePath: dashboardBasePathFromUrl(platform.dashboardUrl),
      frontProxySignature: FRONT_PROXY_SIGNATURE_VERSION,
    },
  } satisfies MetaDocument);
});

export { app as metaRoutes };
export default app;
