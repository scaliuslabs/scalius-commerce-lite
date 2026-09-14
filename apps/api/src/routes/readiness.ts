import { OpenAPIHono } from "@hono/zod-openapi";
import { retryTransientD1 } from "@scalius/core/utils/transient-d1";
import {
  getDb,
  resolveDatabaseConfiguration,
} from "@scalius/database/client";
import {
  assertDatabaseSchemaCompatible,
  readDatabaseSchemaState,
} from "@scalius/database/schema-contract";
import { getRequestCorrelation } from "../utils/http-correlation";
import { logOpsEvent } from "../utils/ops-log";
import { MASTER_SECRET_NAME, readMasterSecret } from "@scalius/shared/runtime-secrets";
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
const READINESS_KV_PROBE_KEY = "__scalius:readyz:probe";

type CheckStatus = "ok" | "missing" | "error" | "timeout";

type ReadinessCheck = {
  status: CheckStatus;
  latencyMs?: number;
  detail?: string;
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
  probe: () => Promise<string | undefined>,
  timeoutMs = READINESS_REMOTE_PROBE_TIMEOUT_MS,
): Promise<CheckResult> {
  const started = nowMs();

  try {
    const detail = await withTimeout(probe(), timeoutMs);
    return {
      name,
      required,
      check: {
        status: "ok",
        latencyMs: nowMs() - started,
        ...(detail ? { detail } : {}),
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

function queueBindingCheck(name: string, queue: unknown): CheckResult {
  return bindingMethodsCheck(name, queue, ["send"], "queue");
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
    const state = config.provider === "d1"
      ? await retryTransientD1(
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
            return assertDatabaseSchemaCompatible(result.results);
          },
          { delaysMs: READINESS_D1_RETRY_DELAYS_MS },
        )
      : await readDatabaseSchemaState(getDb(env));
    return `schema ${state.version}/${state.name}`;
  }, READINESS_REMOTE_PROBE_TIMEOUT_MS);
}

async function kvCheck(name: string, kv: KVNamespace | undefined): Promise<CheckResult> {
  if (!kv) return missing(name);

  return runProbe(name, true, async () => {
    await kv.get(READINESS_KV_PROBE_KEY, { cacheTtl: 60 });
    return "read probe";
  });
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

app.get("/readyz", async (c) => {
  const started = nowMs();
  const env = c.env;

  const asyncChecks = await Promise.all([
    databaseCheck(env),
    kvCheck("api_cache_kv", env.CACHE),
    kvCheck("shared_auth_kv", env.SHARED_AUTH_CACHE),
    kvCheck("oauth_kv", env.OAUTH_KV),
    r2Check("r2", env.BUCKET),
    r2Check("agent_artifacts_r2", env.AGENT_ARTIFACTS),
  ]);

  const checks = [
    ...asyncChecks,
    queueBindingCheck("payment_events_queue", env.PAYMENT_EVENTS_QUEUE),
    queueBindingCheck("order_notifications_queue", env.ORDER_NOTIFICATIONS_QUEUE),
    queueBindingCheck("auth_otp_queue", env.AUTH_OTP_QUEUE),
    bindingMethodsCheck(
      "checkout_coordinator",
      env.CHECKOUT_COORDINATOR,
      ["idFromName", "get"],
      "durable object namespace",
    ),
    bindingMethodsCheck(
      "agent_rate_limiter",
      env.AGENT_RATE_LIMITER,
      ["limit"],
      "rate limit",
    ),
    bindingMethodsCheck(
      "search_rate_limiter",
      env.SEARCH_RATE_LIMITER,
      ["limit"],
      "rate limit",
    ),
    bindingMethodsCheck(
      "order_ip_rate_limiter",
      env.ORDER_IP_RATE_LIMITER,
      ["limit"],
      "rate limit",
    ),
    bindingMethodsCheck(
      "order_phone_rate_limiter",
      env.ORDER_PHONE_RATE_LIMITER,
      ["limit"],
      "rate limit",
    ),
    configCheck(env),
    platformCheck(env),
  ];
  const ready = allChecksReady(checks);
  const durationMs = nowMs() - started;

  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");

  if (!ready) {
    const correlation = getRequestCorrelation(c);
    logOpsEvent("warn", "api.readyz.degraded", {
      requestId: correlation.requestId,
      cfRay: correlation.cfRay,
      durationMs,
      degradedChecks: degradedCheckSummaries(checks),
    });
  }

  return c.json({
    success: ready,
    status: ready ? "ready" : "degraded",
    timestamp: new Date().toISOString(),
    durationMs,
    checks: flattenChecks(checks),
  }, ready ? 200 : 503);
});

export const readinessRoutes = app;
