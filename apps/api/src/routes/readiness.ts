import { OpenAPIHono } from "@hono/zod-openapi";
import { retryTransientD1 } from "@scalius/core/utils/transient-d1";
import {
  getDb,
  resolveDatabaseConfiguration,
} from "@scalius/database/client";
import { assertReadsAreUncached } from "@scalius/database/read-freshness";
import {
  assertDatabaseSchemaCompatible,
  readDatabaseSchemaState,
} from "@scalius/database/schema-contract";
import { d1ResultStorage, type DatabaseStorageState } from "@scalius/core/modules/platform";
import { getRequestCorrelation } from "../utils/http-correlation";
import { timingSafeCompare } from "../utils/timing-safe";
import { logOpsEvent } from "../utils/ops-log";
import { isDatabaseMigrationFrozen } from "@scalius/shared/database-migration-freeze";
import { MASTER_SECRET_NAME, OPS_READINESS_PURPOSE, deriveRuntimeSecret, readMasterSecret } from "@scalius/shared/runtime-secrets";
import { EMPTY_PLATFORM_CONFIG, getPlatformConfigReadiness } from "@scalius/shared/platform-config";
import {
  isReady,
  readiness,
  readinessIssue,
  type Readiness,
  type ReadinessIssue,
} from "@scalius/shared/readiness";

const READINESS_REMOTE_PROBE_TIMEOUT_MS = 5000;
const READINESS_D1_RETRY_DELAYS_MS = [75, 200, 400] as const;

type CheckStatus = "ok" | "missing" | "error" | "timeout";

type ReadinessCheck = {
  status: CheckStatus;
  latencyMs?: number;
  detail?: string;
  /**
   * D1 only: the database's size against the plan's cap, as a state only
   * (the probe is public, and the byte count would publish the store's
   * growth). A warning never makes the probe degraded (the store still takes
   * orders); ops:check reports it, and Home shows staff the size.
   */
  storage?: { state: DatabaseStorageState };
};

type CheckResult = {
  name: string;
  required: boolean;
  check: ReadinessCheck;
};

const app = new OpenAPIHono<{ Bindings: Env }>();

function nowMs(): number {
  return Date.now();
}

function sanitizeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.slice(0, 160);
  }
  return "readiness check failed";
}

function missing(name: string, detail = "binding is not configured"): CheckResult {
  return {
    name,
    required: true,
    check: { status: "missing", detail },
  };
}

async function withTimeout<T>(
  task: Promise<T>,
  timeoutMs = READINESS_REMOTE_PROBE_TIMEOUT_MS,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

async function runProbe(
  name: string,
  required: boolean,
  probe: () => Promise<string | undefined | { detail: string; storage: { state: DatabaseStorageState } | null }>,
  timeoutMs = READINESS_REMOTE_PROBE_TIMEOUT_MS,
): Promise<CheckResult> {
  const started = nowMs();

  try {
    const outcome = await withTimeout(probe(), timeoutMs);
    const detail = typeof outcome === "object" ? outcome.detail : outcome;
    const storage = typeof outcome === "object" ? outcome.storage : null;
    return {
      name,
      required,
      check: {
        status: "ok",
        latencyMs: nowMs() - started,
        ...(detail ? { detail } : {}),
        ...(storage ? { storage } : {}),
      },
    };
  } catch (error: unknown) {
    const message = sanitizeError(error);
    return {
      name,
      required,
      check: {
        status: message === "timeout" ? "timeout" : "error",
        latencyMs: nowMs() - started,
        detail: message,
      },
    };
  }
}

function bindingMethodsCheck(
  name: string,
  binding: unknown,
  methods: readonly string[],
  kind: string,
): CheckResult {
  const candidate = binding as Record<string, unknown> | undefined;
  const ready = methods.every((method) => typeof candidate?.[method] === "function");
  return {
    name,
    required: true,
    check: {
      status: ready ? "ok" : "missing",
      detail: ready ? undefined : `${kind} binding is not configured`,
    },
  };
}

async function databaseCheck(env: Env): Promise<CheckResult> {
  let config: ReturnType<typeof resolveDatabaseConfiguration>;
  try {
    config = resolveDatabaseConfiguration(env);
  } catch (error) {
    const hasRemoteDatabaseConfiguration = Boolean(
      env.DATABASE_PROVIDER === "turso" ||
      env.DATABASE_PROVIDER === "postgres" ||
      env.TURSO_DATABASE_URL ||
      env.TURSO_AUTH_TOKEN ||
      env.POSTGRES_DATABASE_URL,
    );
    return missing(
      hasRemoteDatabaseConfiguration ? "database" : "d1",
      sanitizeError(error),
    );
  }

  return runProbe(config.provider, true, async () => {
    if (config.provider === "d1") {
      const { state, storage } = await retryTransientD1(
        async () => {
          const result = await config.binding.prepare(`
            SELECT version, name, source_sha256 AS sourceSha256
            FROM scalius_schema_migrations
            ORDER BY version
          `).all<{
            version: number;
            name: string;
            sourceSha256: string;
          }>();
          // The same result reports the database's size: no extra query.
          return { state: assertDatabaseSchemaCompatible(result.results), storage: d1ResultStorage(result) };
        },
        { delaysMs: READINESS_D1_RETRY_DELAYS_MS },
      );
      return {
        detail: `schema ${state.version}/${state.name}${storage ? `; storage ${storage.state}` : ""}`,
        storage: storage ? { state: storage.state } : null,
      };
    }
    const state = await readDatabaseSchemaState(getDb(env));
    if (config.provider === "postgres") {
      // Hyperdrive caches plain reads by default; DVC, idempotency and
      // checkout authority need every read to see the last commit. The probe
      // writes one private row, so it waits while a cutover freeze copies data.
      if (isDatabaseMigrationFrozen(env)) {
        return `schema ${state.version}/${state.name}; read freshness unchecked during write freeze`;
      }
      await assertReadsAreUncached(getDb(env));
      return `schema ${state.version}/${state.name}; reads uncached`;
    }
    return `schema ${state.version}/${state.name}`;
  }, READINESS_REMOTE_PROBE_TIMEOUT_MS);
}

async function r2Check(
  name: string,
  bucket: R2Bucket | undefined,
): Promise<CheckResult> {
  if (!bucket) return missing(name);

  return runProbe(name, true, async () => {
    await bucket.list({ limit: 1 });
    return "list limit 1";
  }, READINESS_REMOTE_PROBE_TIMEOUT_MS);
}

/**
 * Projects the shared readiness vocabulary onto this endpoint's per-check probe
 * format. `/readyz` is an infrastructure probe consumed by deploy.mjs and the
 * ops scripts, so the wire shape here stays `{ status, latencyMs, detail }`
 * while the reasoning lives in the one shared model.
 */
function readinessCheck(
  name: string,
  value: Readiness,
  readyDetail: string,
): CheckResult {
  if (isReady(value)) {
    return { name, required: true, check: { status: "ok", detail: readyDetail } };
  }

  return {
    name,
    required: true,
    check: {
      status: value.status === "error" ? "error" : "missing",
      detail: value.issues.map((issue) => issue.message).join("; "),
    },
  };
}

/** The two installed secrets. Everything else is derived or merchant-configured. */
function runtimeConfigReadiness(env: Env): Readiness {
  const issues: ReadinessIssue[] = [];
  if (!readMasterSecret(env)) {
    issues.push(readinessIssue(
      "missing_scalius_secret",
      `${MASTER_SECRET_NAME} is not installed.`,
      `Install it with \`wrangler secret put ${MASTER_SECRET_NAME}\`.`,
    ));
  }
  if (!String(env.CREDENTIAL_ENCRYPTION_KEY ?? "").trim()) {
    issues.push(readinessIssue(
      "missing_credential_encryption_key",
      "CREDENTIAL_ENCRYPTION_KEY is not installed.",
      "Install it with `wrangler secret put CREDENTIAL_ENCRYPTION_KEY`.",
    ));
  }
  return readiness.from(issues);
}

function configCheck(env: Env): CheckResult {
  return readinessCheck(
    "runtime_config",
    runtimeConfigReadiness(env),
    "required secrets installed",
  );
}

/** Platform origins are merchant-configured; they gate CORS, cookies, links, and discovery. */
function platformCheck(env: Env): CheckResult {
  return readinessCheck(
    "platform_config",
    getPlatformConfigReadiness(env.PLATFORM_CONFIG ?? EMPTY_PLATFORM_CONFIG),
    "platform origins configured",
  );
}

function flattenChecks(checks: CheckResult[]): Record<string, ReadinessCheck> {
  return Object.fromEntries(checks.map((result) => [result.name, result.check]));
}

function allChecksReady(checks: CheckResult[]): boolean {
  return checks.every((result) => !result.required || result.check.status === "ok");
}

function degradedCheckSummaries(checks: CheckResult[]): string[] {
  return checks
    .filter((result) => result.required && result.check.status !== "ok")
    .map((result) => `${result.name}:${result.check.status}`);
}

/**
 * What an anonymous caller (a load balancer, an uptime monitor) learns of a
 * failing check: its class only, never a binding name, a schema, a secret's
 * name or an error message.
 */
export type ReadinessReason = "database" | "storage" | "rate_limit" | "configuration" | "setup";

function reasonOf(name: string): ReadinessReason {
  if (name === "r2") return "storage";
  if (name === "rl_strict" || name === "rl_standard") return "rate_limit";
  if (name === "runtime_config") return "configuration";
  if (name === "platform_config") return "setup";
  return "database";
}

/**
 * The header an operator sends for the detailed answer: the readiness token
 * (`OPS_READINESS_PURPOSE`, derived from the master secret on demand), which
 * unlocks this detail and nothing else.
 */
export const READINESS_OPERATOR_HEADER = "X-API-Token";

/**
 * True for the store's readiness token, false for another; null when none was
 * sent, or when no master secret is installed to check one against (the
 * anonymous answer then names `configuration`).
 */
async function operatorRead(token: string | undefined, env: Env): Promise<boolean | null> {
  const master = readMasterSecret(env);
  if (!token || !master) return null;
  return timingSafeCompare(token, await deriveRuntimeSecret(master, OPS_READINESS_PURPOSE));
}

app.get("/readyz", async (c) => {
  const started = nowMs();
  const env = c.env;
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  // Anyone may run the probes (a load balancer does); only the answer's detail is the operator's.
  const operatorCheck = operatorRead(c.req.header(READINESS_OPERATOR_HEADER), env);

  const asyncChecks = await Promise.all([
    databaseCheck(env),
    r2Check("r2", env.BUCKET),
  ]);
  const operator = await operatorCheck;
  if (operator === false) {
    return c.json({ success: false, error: { code: "unauthorized", message: "Invalid API token" } }, 401);
  }

  const checks = [
    ...asyncChecks,
    bindingMethodsCheck("rl_strict", env.RL_STRICT, ["limit"], "rate limit"),
    bindingMethodsCheck("rl_standard", env.RL_STANDARD, ["limit"], "rate limit"),
    configCheck(env),
    platformCheck(env),
  ];
  const ready = allChecksReady(checks);
  const durationMs = nowMs() - started;

  if (!ready) {
    const correlation = getRequestCorrelation(c);
    logOpsEvent("warn", "api.readyz.degraded", {
      requestId: correlation.requestId,
      cfRay: correlation.cfRay,
      durationMs,
      degradedChecks: degradedCheckSummaries(checks),
    });
  }

  const status = ready ? "ready" : "degraded";
  if (!operator) {
    const reasons = [...new Set(checks
      .filter((result) => result.required && result.check.status !== "ok")
      .map((result) => reasonOf(result.name)))];
    return c.json({
      success: ready,
      status,
      timestamp: new Date().toISOString(),
      ...(reasons.length > 0 ? { reasons } : {}),
    }, ready ? 200 : 503);
  }
  return c.json({
    success: ready,
    status,
    timestamp: new Date().toISOString(),
    durationMs,
    checks: flattenChecks(checks),
  }, ready ? 200 : 503);
});

export const readinessRoutes = app;
