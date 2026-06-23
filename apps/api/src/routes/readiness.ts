import { OpenAPIHono } from "@hono/zod-openapi";

const READINESS_TIMEOUT_MS = 1500;
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
  timeoutMs = READINESS_TIMEOUT_MS,
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
): Promise<CheckResult> {
  const started = nowMs();

  try {
    const detail = await withTimeout(probe());
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

function bindingCheck(
  name: string,
  binding: unknown,
  required = true,
): CheckResult {
  return {
    name,
    required,
    check: {
      status: binding ? "ok" : "missing",
      detail: binding ? undefined : "binding is not configured",
    },
  };
}

function queueBindingCheck(name: string, queue: unknown): CheckResult {
  const ready = typeof (queue as { send?: unknown } | undefined)?.send === "function";
  return {
    name,
    required: true,
    check: {
      status: ready ? "ok" : "missing",
      detail: ready ? undefined : "queue binding is not configured",
    },
  };
}

async function d1Check(env: Env): Promise<CheckResult> {
  if (!env.DB) return missing("d1");

  return runProbe("d1", true, async () => {
    const row = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    if (row?.ok !== 1) {
      throw new Error("unexpected D1 probe result");
    }
    return "SELECT 1";
  });
}

async function kvCheck(name: string, kv: KVNamespace | undefined): Promise<CheckResult> {
  if (!kv) return missing(name);

  return runProbe(name, true, async () => {
    await kv.get(READINESS_KV_PROBE_KEY, { cacheTtl: 60 });
    return "read probe";
  });
}

async function r2Check(env: Env): Promise<CheckResult> {
  if (!env.BUCKET) return missing("r2");

  return runProbe("r2", true, async () => {
    await env.BUCKET.list({ limit: 1 });
    return "list limit 1";
  });
}

function configCheck(env: Env): CheckResult {
  const requiredVars = [
    "PUBLIC_API_BASE_URL",
    "STOREFRONT_URL",
    "BETTER_AUTH_URL",
    "R2_PUBLIC_URL",
  ] as const;
  const missingVars = requiredVars.filter((key) => !String(env[key] ?? "").trim());

  return {
    name: "runtime_config",
    required: true,
    check: {
      status: missingVars.length === 0 ? "ok" : "missing",
      detail: missingVars.length > 0
        ? `missing ${missingVars.join(", ")}`
        : "required public runtime vars present",
    },
  };
}

function flattenChecks(checks: CheckResult[]): Record<string, ReadinessCheck> {
  return Object.fromEntries(checks.map((result) => [result.name, result.check]));
}

function isReady(checks: CheckResult[]): boolean {
  return checks.every((result) => !result.required || result.check.status === "ok");
}

app.get("/readyz", async (c) => {
  const started = nowMs();
  const env = c.env;

  const asyncChecks = await Promise.all([
    d1Check(env),
    kvCheck("api_cache_kv", env.CACHE),
    kvCheck("shared_auth_kv", env.SHARED_AUTH_CACHE),
    r2Check(env),
  ]);

  const checks = [
    ...asyncChecks,
    bindingCheck("widget_design_agent_do", env.WidgetDesignAgent),
    queueBindingCheck("payment_events_queue", env.PAYMENT_EVENTS_QUEUE),
    queueBindingCheck("order_notifications_queue", env.ORDER_NOTIFICATIONS_QUEUE),
    queueBindingCheck("auth_otp_queue", env.AUTH_OTP_QUEUE),
    queueBindingCheck("order_ingest_queue", env.ORDER_INGEST_QUEUE),
    configCheck(env),
  ];
  const ready = isReady(checks);

  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");

  return c.json({
    success: ready,
    status: ready ? "ready" : "degraded",
    timestamp: new Date().toISOString(),
    durationMs: nowMs() - started,
    checks: flattenChecks(checks),
  }, ready ? 200 : 503);
});

export const readinessRoutes = app;
