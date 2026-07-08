const DEFAULT_READYZ_URL = "https://api.scalius.com/api/v1/readyz";
const DEFAULT_READYZ_TIMEOUT_MS = 10_000;
const DEFAULT_QUEUE_METRICS_TIMEOUT_MS = 5_000;
const DEFAULT_DLQ_BACKLOG_THRESHOLD = 0;
const DEFAULT_QUEUE_OLDEST_AGE_THRESHOLD_MS = 300_000;
const DEFAULT_ALERT_STREAK_THRESHOLD = 3;
const DEFAULT_ALERT_COOLDOWN_MS = 300_000;
const DEFAULT_STATE_TTL_SECONDS = 86_400;
const STATE_KEY_PREFIX = "ops-monitor:v1";
const ALERT_PROOF_MARKER_KEY = `${STATE_KEY_PREFIX}:control:routed-alert-proof`;
const ALERT_PROOF_RESULT_KEY_PREFIX = `${ALERT_PROOF_MARKER_KEY}:result`;
const ALERT_PROOF_DEFAULT_NONCE = "manual";
const ALERT_PROOF_MONITOR_ID_PREFIX = "proof:routed-alert";
const ALERT_PROOF_MAX_FUTURE_MS = 15 * 60 * 1_000;
const ALERT_PROOF_CONSUMED_TTL_SECONDS = 60;
const ALERT_PROOF_RESULT_TTL_SECONDS = 86_400;

export const OPS_ALERT_PROOF_MARKER_KEY = ALERT_PROOF_MARKER_KEY;
export const OPS_ALERT_PROOF_RESULT_KEY_PREFIX = ALERT_PROOF_RESULT_KEY_PREFIX;

export type QueueKind = "normal" | "dlq";

export interface QueueMetricsSnapshot {
  backlogCount: number;
  backlogBytes?: number;
  oldestMessageTimestamp?: Date | string | number;
}

export interface QueueMetricsBinding {
  metrics(): Promise<QueueMetricsSnapshot>;
}

export interface OpsMonitorStateNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete?(key: string): Promise<void>;
}

export interface OpsMonitorEmailMessage {
  to: string | string[];
  from: string;
  subject: string;
  text: string;
}

export interface OpsMonitorEmailBinding {
  send(message: OpsMonitorEmailMessage): Promise<{ messageId: string }>;
}

export interface OpsMonitorEnv {
  OPS_MONITOR_STATE: OpsMonitorStateNamespace;
  READYZ_URL?: string;
  READYZ_TIMEOUT_MS?: string | number;
  QUEUE_METRICS_TIMEOUT_MS?: string | number;
  DLQ_BACKLOG_THRESHOLD?: string | number;
  QUEUE_OLDEST_AGE_THRESHOLD_MS?: string | number;
  ALERT_STREAK_THRESHOLD?: string | number;
  ALERT_COOLDOWN_MS?: string | number;
  STATE_TTL_SECONDS?: string | number;
  ALERT_EMAIL?: OpsMonitorEmailBinding;
  ALERT_EMAIL_FROM?: string;
  ALERT_EMAIL_TO?: string;
  ALERT_EMAIL_SUBJECT_PREFIX?: string;
  PAYMENT_EVENTS_QUEUE: QueueMetricsBinding;
  PAYMENT_EVENTS_DLQ: QueueMetricsBinding;
  ORDER_NOTIFICATIONS_QUEUE: QueueMetricsBinding;
  ORDER_NOTIFICATIONS_DLQ: QueueMetricsBinding;
  AUTH_OTP_QUEUE: QueueMetricsBinding;
  AUTH_OTP_DLQ: QueueMetricsBinding;
  STOREFRONT_CACHE_QUEUE: QueueMetricsBinding;
  STOREFRONT_CACHE_DLQ: QueueMetricsBinding;
}

export interface MonitorConfig {
  readyzUrl: string;
  readyzTimeoutMs: number;
  queueMetricsTimeoutMs: number;
  dlqBacklogThreshold: number;
  queueOldestAgeThresholdMs: number;
  alertStreakThreshold: number;
  alertCooldownMs: number;
  stateTtlSeconds: number;
}

export interface MonitoredQueue {
  binding: keyof Pick<
    OpsMonitorEnv,
    | "PAYMENT_EVENTS_QUEUE"
    | "PAYMENT_EVENTS_DLQ"
    | "ORDER_NOTIFICATIONS_QUEUE"
    | "ORDER_NOTIFICATIONS_DLQ"
    | "AUTH_OTP_QUEUE"
    | "AUTH_OTP_DLQ"
    | "STOREFRONT_CACHE_QUEUE"
    | "STOREFRONT_CACHE_DLQ"
  >;
  name: string;
  kind: QueueKind;
}

export interface MonitorIssue {
  id: string;
  kind: "readyz" | "queue" | "monitor";
  name: string;
  status: "degraded" | "threshold" | "error";
  durationMs: number;
  requestId?: string;
  queueName?: string;
  backlogCount?: number;
  oldestMessageAgeMs?: number | null;
  failedChecks?: string[];
}

export interface ReadinessSummary {
  status: "ok" | "degraded" | "error";
  durationMs: number;
  failedChecks: string[];
}

export interface QueueMetricSummary {
  queueName: string;
  kind: QueueKind;
  status: "ok" | "threshold" | "error";
  durationMs: number;
  backlogCount: number | null;
  oldestMessageAgeMs: number | null;
}

export interface QueueCheckResult {
  issue: MonitorIssue | null;
  summary: QueueMetricSummary;
}

export interface ReadinessEvaluation {
  ready: boolean;
  status: "ok" | "degraded";
  failedChecks: string[];
}

export interface AlertState {
  status: "ok" | "issue";
  streak: number;
  lastAlertedAt: number | null;
  firstSeenAt?: number | null;
  lastSeenAt?: number | null;
}

export interface AlertDecision {
  state: AlertState;
  shouldAlert: boolean;
}

export interface AlertingResult {
  alertCount: number;
  routedAlertCount: number;
  deliveryFailureCount: number;
}

export interface AlertEmailConfig {
  binding: OpsMonitorEmailBinding;
  from: string;
  to: string[];
  subjectPrefix: string;
}

export interface AlertProofMarkerResult {
  issue: MonitorIssue | null;
  consumed: boolean;
  nonce?: string;
  resultKey?: string;
  ignoredReason?: "expired" | "invalid";
}

export const MONITORED_QUEUES: MonitoredQueue[] = [
  { binding: "PAYMENT_EVENTS_QUEUE", name: "payment-events", kind: "normal" },
  { binding: "PAYMENT_EVENTS_DLQ", name: "payment-events-dlq", kind: "dlq" },
  { binding: "ORDER_NOTIFICATIONS_QUEUE", name: "order-notifications", kind: "normal" },
  { binding: "ORDER_NOTIFICATIONS_DLQ", name: "order-notifications-dlq", kind: "dlq" },
  { binding: "AUTH_OTP_QUEUE", name: "auth-otp", kind: "normal" },
  { binding: "AUTH_OTP_DLQ", name: "auth-otp-dlq", kind: "dlq" },
  { binding: "STOREFRONT_CACHE_QUEUE", name: "storefront-cache", kind: "normal" },
  { binding: "STOREFRONT_CACHE_DLQ", name: "storefront-cache-dlq", kind: "dlq" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Math.floor(parseNumber(value, fallback));
  return parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: Partial<OpsMonitorEnv>): MonitorConfig {
  return {
    readyzUrl: typeof env.READYZ_URL === "string" && env.READYZ_URL ? env.READYZ_URL : DEFAULT_READYZ_URL,
    readyzTimeoutMs: parsePositiveInteger(env.READYZ_TIMEOUT_MS, DEFAULT_READYZ_TIMEOUT_MS),
    queueMetricsTimeoutMs: parsePositiveInteger(env.QUEUE_METRICS_TIMEOUT_MS, DEFAULT_QUEUE_METRICS_TIMEOUT_MS),
    dlqBacklogThreshold: parseNumber(env.DLQ_BACKLOG_THRESHOLD, DEFAULT_DLQ_BACKLOG_THRESHOLD),
    queueOldestAgeThresholdMs: parseNumber(
      env.QUEUE_OLDEST_AGE_THRESHOLD_MS,
      DEFAULT_QUEUE_OLDEST_AGE_THRESHOLD_MS,
    ),
    alertStreakThreshold: parsePositiveInteger(env.ALERT_STREAK_THRESHOLD, DEFAULT_ALERT_STREAK_THRESHOLD),
    alertCooldownMs: parseNumber(env.ALERT_COOLDOWN_MS, DEFAULT_ALERT_COOLDOWN_MS),
    stateTtlSeconds: parsePositiveInteger(env.STATE_TTL_SECONDS, DEFAULT_STATE_TTL_SECONDS),
  };
}

class DependencyTimeoutError extends Error {
  constructor() {
    super("dependency timeout");
    this.name = "DependencyTimeoutError";
  }
}

function isDependencyTimeoutError(error: unknown): boolean {
  return error instanceof DependencyTimeoutError;
}

async function runWithDependencyTimeout<T>({
  timeoutMs,
  start,
}: {
  timeoutMs: number;
  start: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  const timeoutError = new DependencyTimeoutError();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const operation = Promise.resolve().then(() => start(controller.signal));
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, Math.max(1, Math.floor(timeoutMs)));
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

export function createRequestId(now = new Date()): string {
  const timestamp = now.toISOString().replace(/[-:.]/g, "").replace("T", "t").replace("Z", "z");
  const suffix = typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `ops-monitor-${timestamp}-${suffix}`.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function evaluateReadinessResponse(httpStatus: number, body: unknown): ReadinessEvaluation {
  const failedChecks: string[] = [];

  if (httpStatus !== 200) {
    failedChecks.push(`http:${httpStatus}`);
  }
  if (!isRecord(body)) {
    return { ready: false, status: "degraded", failedChecks: [...failedChecks, "body:invalid"] };
  }
  if (body.success !== true) {
    failedChecks.push("success:false");
  }
  if (body.status !== "ready") {
    failedChecks.push(`status:${typeof body.status === "string" ? body.status : "invalid"}`);
  }
  if (!isRecord(body.checks) || Object.keys(body.checks).length === 0) {
    failedChecks.push("checks:missing");
  } else {
    for (const [name, check] of Object.entries(body.checks)) {
      const checkStatus = isRecord(check) && typeof check.status === "string" ? check.status : "invalid";
      if (checkStatus !== "ok") {
        failedChecks.push(`${name}:${checkStatus}`);
      }
    }
  }

  return {
    ready: failedChecks.length === 0,
    status: failedChecks.length === 0 ? "ok" : "degraded",
    failedChecks,
  };
}

export async function checkReadiness({
  readyzUrl,
  fetchImpl,
  now,
  timeoutMs = DEFAULT_READYZ_TIMEOUT_MS,
}: {
  readyzUrl: string;
  fetchImpl: typeof fetch;
  now: number;
  timeoutMs?: number;
}): Promise<{ issue: MonitorIssue | null; requestId: string; summary: ReadinessSummary }> {
  const requestId = createRequestId(new Date(now));
  const startedAt = Date.now();

  try {
    const { response, body } = await runWithDependencyTimeout({
      timeoutMs,
      start: async (signal) => {
        const response = await fetchImpl(readyzUrl, {
          method: "GET",
          headers: {
            Accept: "application/json",
            "Cache-Control": "no-cache",
            "X-Request-Id": requestId,
          },
          signal,
        });
        return {
          response,
          body: await response.json().catch(() => null),
        };
      },
    });
    const evaluation = evaluateReadinessResponse(response.status, body);
    const durationMs = Date.now() - startedAt;
    const summary: ReadinessSummary = {
      status: evaluation.status,
      durationMs,
      failedChecks: evaluation.failedChecks,
    };
    if (evaluation.ready) return { issue: null, requestId, summary };

    return {
      requestId,
      summary,
      issue: {
        id: "readyz",
        kind: "readyz",
        name: "api.readyz",
        status: "degraded",
        durationMs,
        requestId,
        failedChecks: evaluation.failedChecks,
      },
    };
  } catch (error) {
    const failedChecks = [isDependencyTimeoutError(error) ? "fetch:timeout" : "fetch:error"];
    const durationMs = Date.now() - startedAt;
    return {
      requestId,
      summary: {
        status: "error",
        durationMs,
        failedChecks,
      },
      issue: {
        id: "readyz",
        kind: "readyz",
        name: "api.readyz",
        status: "error",
        durationMs,
        requestId,
        failedChecks,
      },
    };
  }
}

function timestampToMillis(value: QueueMetricsSnapshot["oldestMessageTimestamp"]): number | null {
  if (value === undefined) return null;
  const millis = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(millis) ? millis : null;
}

export function evaluateQueueMetrics(
  queue: MonitoredQueue,
  metrics: QueueMetricsSnapshot,
  config: Pick<MonitorConfig, "dlqBacklogThreshold" | "queueOldestAgeThresholdMs">,
  now: number,
  durationMs = 0,
): MonitorIssue | null {
  const backlogCount = Number.isFinite(metrics.backlogCount) ? metrics.backlogCount : 0;
  const oldestMillis = timestampToMillis(metrics.oldestMessageTimestamp);
  const oldestMessageAgeMs = oldestMillis === null ? null : Math.max(0, now - oldestMillis);

  if (queue.kind === "dlq" && backlogCount > config.dlqBacklogThreshold) {
    return {
      id: `queue:${queue.name}`,
      kind: "queue",
      name: queue.name,
      status: "threshold",
      durationMs,
      queueName: queue.name,
      backlogCount,
      oldestMessageAgeMs,
    };
  }

  if (
    queue.kind === "normal"
    && oldestMessageAgeMs !== null
    && oldestMessageAgeMs > config.queueOldestAgeThresholdMs
  ) {
    return {
      id: `queue:${queue.name}`,
      kind: "queue",
      name: queue.name,
      status: "threshold",
      durationMs,
      queueName: queue.name,
      backlogCount,
      oldestMessageAgeMs,
    };
  }

  return null;
}

function summarizeQueueMetrics(
  queue: MonitoredQueue,
  metrics: QueueMetricsSnapshot,
  issue: MonitorIssue | null,
  now: number,
  durationMs: number,
): QueueMetricSummary {
  const backlogCount = Number.isFinite(metrics.backlogCount) ? metrics.backlogCount : 0;
  const oldestMillis = timestampToMillis(metrics.oldestMessageTimestamp);
  const oldestMessageAgeMs = oldestMillis === null ? null : Math.max(0, now - oldestMillis);

  return {
    queueName: queue.name,
    kind: queue.kind,
    status: issue ? "threshold" : "ok",
    durationMs,
    backlogCount,
    oldestMessageAgeMs,
  };
}

async function checkQueueWithSummary(
  env: OpsMonitorEnv,
  queue: MonitoredQueue,
  config: Pick<MonitorConfig, "dlqBacklogThreshold" | "queueOldestAgeThresholdMs" | "queueMetricsTimeoutMs">,
  now: number,
): Promise<QueueCheckResult> {
  const startedAt = Date.now();
  try {
    const metrics = await runWithDependencyTimeout({
      timeoutMs: config.queueMetricsTimeoutMs,
      start: () => env[queue.binding].metrics(),
    });
    const durationMs = Date.now() - startedAt;
    const issue = evaluateQueueMetrics(queue, metrics, config, now, durationMs);
    return {
      issue,
      summary: summarizeQueueMetrics(queue, metrics, issue, now, durationMs),
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const issue: MonitorIssue = {
      id: `queue:${queue.name}`,
      kind: "monitor",
      name: queue.name,
      status: "error",
      durationMs,
      queueName: queue.name,
      failedChecks: [isDependencyTimeoutError(error) ? "metrics:timeout" : "metrics:error"],
    };
    return {
      issue,
      summary: {
        queueName: queue.name,
        kind: queue.kind,
        status: "error",
        durationMs,
        backlogCount: null,
        oldestMessageAgeMs: null,
      },
    };
  }
}

export async function checkQueue(
  env: OpsMonitorEnv,
  queue: MonitoredQueue,
  config: Pick<MonitorConfig, "dlqBacklogThreshold" | "queueOldestAgeThresholdMs" | "queueMetricsTimeoutMs">,
  now: number,
): Promise<MonitorIssue | null> {
  return (await checkQueueWithSummary(env, queue, config, now)).issue;
}

export async function collectQueueChecks(
  env: OpsMonitorEnv,
  config: Pick<MonitorConfig, "dlqBacklogThreshold" | "queueOldestAgeThresholdMs" | "queueMetricsTimeoutMs">,
  now: number,
): Promise<{ issues: MonitorIssue[]; summaries: QueueMetricSummary[] }> {
  const results = await Promise.all(MONITORED_QUEUES.map((queue) => checkQueueWithSummary(env, queue, config, now)));
  return {
    issues: results.map((result) => result.issue).filter((issue): issue is MonitorIssue => issue !== null),
    summaries: results.map((result) => result.summary),
  };
}

export async function checkQueues(
  env: OpsMonitorEnv,
  config: Pick<MonitorConfig, "dlqBacklogThreshold" | "queueOldestAgeThresholdMs" | "queueMetricsTimeoutMs">,
  now: number,
): Promise<MonitorIssue[]> {
  return (await collectQueueChecks(env, config, now)).issues;
}

export function nextAlertState(
  previous: AlertState | null,
  unhealthy: boolean,
  now: number,
  config: Pick<MonitorConfig, "alertStreakThreshold" | "alertCooldownMs">,
): AlertDecision {
  if (!unhealthy) {
    return {
      state: {
        status: "ok",
        streak: 0,
        lastAlertedAt: previous?.lastAlertedAt ?? null,
        firstSeenAt: null,
        lastSeenAt: null,
      },
      shouldAlert: false,
    };
  }

  const streak = previous?.status === "issue" ? previous.streak + 1 : 1;
  const firstSeenAt = previous?.status === "issue" && Number.isFinite(previous.firstSeenAt)
    ? previous.firstSeenAt
    : now;
  const cooldownElapsed = previous?.lastAlertedAt === undefined
    || previous.lastAlertedAt === null
    || now - previous.lastAlertedAt >= config.alertCooldownMs;
  const shouldAlert = streak >= config.alertStreakThreshold && cooldownElapsed;

  return {
    state: {
      status: "issue",
      streak,
      lastAlertedAt: shouldAlert ? now : previous?.lastAlertedAt ?? null,
      firstSeenAt,
      lastSeenAt: now,
    },
    shouldAlert,
  };
}

function stateKey(monitorId: string): string {
  return `${STATE_KEY_PREFIX}:${monitorId}`;
}

function parseAlertProofNonce(value: unknown): string | null {
  if (value === undefined) return ALERT_PROOF_DEFAULT_NONCE;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(trimmed)) return null;
  return trimmed;
}

function alertProofMonitorId(nonce: string): string {
  return `${ALERT_PROOF_MONITOR_ID_PREFIX}:${nonce}`;
}

function alertProofResultKey(nonce: string): string {
  return `${ALERT_PROOF_RESULT_KEY_PREFIX}:${nonce}`;
}

function parseExpiresAtMillis(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.length > 80) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseAlertProofMarker(raw: string, now: number): AlertProofMarkerResult {
  if (raw.length > 1_024) return { issue: null, consumed: true, ignoredReason: "invalid" };

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return { issue: null, consumed: true, ignoredReason: "invalid" };
    const expiresAt = parseExpiresAtMillis(parsed.expiresAt);
    const nonce = parseAlertProofNonce(parsed.nonce);
    if (expiresAt === null) return { issue: null, consumed: true, ignoredReason: "invalid" };
    if (nonce === null) return { issue: null, consumed: true, ignoredReason: "invalid" };
    if (expiresAt <= now) return { issue: null, consumed: true, ignoredReason: "expired" };
    if (expiresAt - now > ALERT_PROOF_MAX_FUTURE_MS) {
      return { issue: null, consumed: true, ignoredReason: "invalid" };
    }

    return {
      consumed: true,
      nonce,
      resultKey: alertProofResultKey(nonce),
      issue: {
        id: alertProofMonitorId(nonce),
        kind: "monitor",
        name: "ops-monitor.routed-alert-proof",
        status: "threshold",
        durationMs: 0,
        failedChecks: ["synthetic:scheduled-routed-alert-proof"],
      },
    };
  } catch {
    return { issue: null, consumed: true, ignoredReason: "invalid" };
  }
}

async function consumeAlertProofMarker(
  state: OpsMonitorStateNamespace,
  now: number,
): Promise<AlertProofMarkerResult> {
  const raw = await state.get(ALERT_PROOF_MARKER_KEY);
  if (raw === null) return { issue: null, consumed: false };

  if (state.delete) {
    await state.delete(ALERT_PROOF_MARKER_KEY);
  } else {
    await state.put(ALERT_PROOF_MARKER_KEY, JSON.stringify({ consumedAt: now }), {
      expirationTtl: ALERT_PROOF_CONSUMED_TTL_SECONDS,
    });
  }

  return parseAlertProofMarker(raw, now);
}

function alertProofStatus(result: AlertingResult): "sent" | "failed" | "log_only" {
  if (result.routedAlertCount > 0) return "sent";
  if (result.deliveryFailureCount > 0) return "failed";
  return "log_only";
}

function safeAlertProofResultFailurePayload({
  runId,
  resultKey,
  error,
}: {
  runId: string;
  resultKey: string;
  error: unknown;
}): Record<string, unknown> {
  const errorRecord = isRecord(error) ? error : {};
  return {
    event: "ops_monitor.routed_alert_proof_result_failed",
    runId,
    resultKey,
    errorName: error instanceof Error ? error.name : typeof error,
    errorCode: typeof errorRecord.code === "string" ? errorRecord.code.slice(0, 80) : undefined,
  };
}

async function writeAlertProofResult({
  state,
  marker,
  alerting,
  runId,
  now,
  logger,
}: {
  state: OpsMonitorStateNamespace;
  marker: AlertProofMarkerResult;
  alerting: AlertingResult;
  runId: string;
  now: number;
  logger: Pick<Console, "error">;
}): Promise<string | undefined> {
  if (!marker.issue || !marker.resultKey || !marker.nonce) return undefined;

  try {
    await state.put(marker.resultKey, JSON.stringify({
      version: 1,
      type: "routed-alert-proof-result",
      nonce: marker.nonce,
      status: alertProofStatus(alerting),
      attemptedAt: new Date(now).toISOString(),
      runId,
      monitorId: marker.issue.id,
      alertCount: alerting.alertCount,
      routedAlertCount: alerting.routedAlertCount,
      deliveryFailureCount: alerting.deliveryFailureCount,
    }), {
      expirationTtl: ALERT_PROOF_RESULT_TTL_SECONDS,
    });
    return marker.resultKey;
  } catch (error) {
    logger.error(
      "[ops-monitor-alert-proof-result-failed]",
      JSON.stringify(safeAlertProofResultFailurePayload({ runId, resultKey: marker.resultKey, error })),
    );
    return undefined;
  }
}

function parseAlertState(raw: string | null): AlertState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AlertState>;
    if (
      (parsed.status === "ok" || parsed.status === "issue")
      && Number.isFinite(parsed.streak)
      && (parsed.lastAlertedAt === null || Number.isFinite(parsed.lastAlertedAt))
    ) {
      const streak = parsed.streak;
      if (streak === undefined) return null;
      return {
        status: parsed.status,
        streak,
        lastAlertedAt: parsed.lastAlertedAt ?? null,
        firstSeenAt: Number.isFinite(parsed.firstSeenAt) ? parsed.firstSeenAt ?? null : null,
        lastSeenAt: Number.isFinite(parsed.lastSeenAt) ? parsed.lastSeenAt ?? null : null,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function formatIsoTimestamp(value: number | null | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return new Date(value).toISOString();
}

function safeAlertPayload(issue: MonitorIssue, state: AlertState, runId: string): Record<string, unknown> {
  return {
    event: "ops_monitor.alert",
    monitorId: issue.id,
    runId,
    checkKind: issue.kind,
    checkName: issue.name,
    status: issue.status,
    streak: state.streak,
    firstSeenAt: formatIsoTimestamp(state.firstSeenAt),
    lastSeenAt: formatIsoTimestamp(state.lastSeenAt),
    durationMs: issue.durationMs,
    requestId: issue.requestId,
    queueName: issue.queueName,
    backlogCount: issue.backlogCount,
    oldestMessageAgeMs: issue.oldestMessageAgeMs,
    failedChecks: issue.failedChecks,
  };
}

function parseAlertEmailRecipients(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((recipient) => recipient.trim()).filter(Boolean).slice(0, 50);
}

export function loadAlertEmailConfig(env: Partial<OpsMonitorEnv>): AlertEmailConfig | null {
  const from = typeof env.ALERT_EMAIL_FROM === "string" ? env.ALERT_EMAIL_FROM.trim() : "";
  const to = parseAlertEmailRecipients(env.ALERT_EMAIL_TO);
  if (!env.ALERT_EMAIL || !from || to.length === 0) return null;
  return {
    binding: env.ALERT_EMAIL,
    from,
    to,
    subjectPrefix: typeof env.ALERT_EMAIL_SUBJECT_PREFIX === "string" && env.ALERT_EMAIL_SUBJECT_PREFIX.trim()
      ? env.ALERT_EMAIL_SUBJECT_PREFIX.trim()
      : "[Scalius ops]",
  };
}

function formatMaybeNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? "null" : String(value);
}

function buildAlertEmailSubject(config: AlertEmailConfig, issue: MonitorIssue): string {
  return `${config.subjectPrefix} ${issue.status} ${issue.name}`
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function buildAlertEmailText(
  issue: MonitorIssue,
  state: AlertState,
  runId: string,
  queueSummaries: QueueMetricSummary[] = [],
): string {
  const lines = [
    "Scalius ops monitor alert",
    `key: ${issue.id}`,
    `type: ${issue.kind}`,
    `name: ${issue.name}`,
    `status: ${issue.status}`,
    `runId: ${runId}`,
    `requestId: ${issue.requestId ?? "n/a"}`,
    `streak: ${state.streak}`,
    `firstSeenAt: ${formatIsoTimestamp(state.firstSeenAt) ?? "n/a"}`,
    `lastSeenAt: ${formatIsoTimestamp(state.lastSeenAt) ?? "n/a"}`,
    `durationMs: ${issue.durationMs}`,
  ];

  if (issue.queueName) lines.push(`queueName: ${issue.queueName}`);
  if (issue.backlogCount !== undefined) lines.push(`backlogCount: ${issue.backlogCount}`);
  if (issue.oldestMessageAgeMs !== undefined) {
    lines.push(`oldestMessageAgeMs: ${formatMaybeNumber(issue.oldestMessageAgeMs)}`);
  }
  if (issue.failedChecks?.length) lines.push(`failedChecks: ${issue.failedChecks.join(",")}`);
  if (queueSummaries.length > 0) {
    lines.push("queues:");
    for (const queue of queueSummaries) {
      lines.push(
        `- ${queue.queueName} ${queue.kind} ${queue.status} backlog=${formatMaybeNumber(queue.backlogCount)} `
          + `oldestAgeMs=${formatMaybeNumber(queue.oldestMessageAgeMs)} durationMs=${queue.durationMs}`,
      );
    }
  }

  return lines.join("\n");
}

function safeAlertDeliveryFailurePayload(
  issue: MonitorIssue,
  state: AlertState,
  runId: string,
  error: unknown,
): Record<string, unknown> {
  const errorRecord = isRecord(error) ? error : {};
  return {
    event: "ops_monitor.alert_delivery_failed",
    monitorId: issue.id,
    runId,
    checkKind: issue.kind,
    checkName: issue.name,
    status: issue.status,
    streak: state.streak,
    firstSeenAt: formatIsoTimestamp(state.firstSeenAt),
    lastSeenAt: formatIsoTimestamp(state.lastSeenAt),
    requestId: issue.requestId,
    errorName: error instanceof Error ? error.name : typeof error,
    errorCode: typeof errorRecord.code === "string" ? errorRecord.code.slice(0, 80) : undefined,
  };
}

async function sendAlertEmail({
  emailConfig,
  issue,
  state,
  runId,
  queueSummaries,
  logger,
}: {
  emailConfig: AlertEmailConfig | null;
  issue: MonitorIssue;
  state: AlertState;
  runId: string;
  queueSummaries?: QueueMetricSummary[];
  logger: Pick<Console, "error">;
}): Promise<"not_configured" | "sent" | "failed"> {
  if (!emailConfig) return "not_configured";

  try {
    await emailConfig.binding.send({
      to: emailConfig.to,
      from: emailConfig.from,
      subject: buildAlertEmailSubject(emailConfig, issue),
      text: buildAlertEmailText(issue, state, runId, queueSummaries),
    });
    return "sent";
  } catch (error) {
    logger.error(
      "[ops-monitor-alert-delivery-failed]",
      JSON.stringify(safeAlertDeliveryFailurePayload(issue, state, runId, error)),
    );
    return "failed";
  }
}

export async function applyAlerting({
  state,
  issues,
  monitorIds,
  config,
  now,
  runId,
  emailConfig = null,
  queueSummaries = [],
  logger = console,
}: {
  state: OpsMonitorStateNamespace;
  issues: MonitorIssue[];
  monitorIds: string[];
  config: Pick<MonitorConfig, "alertStreakThreshold" | "alertCooldownMs" | "stateTtlSeconds">;
  now: number;
  runId: string;
  emailConfig?: AlertEmailConfig | null;
  queueSummaries?: QueueMetricSummary[];
  logger?: Pick<Console, "error">;
}): Promise<AlertingResult> {
  const issuesById = new Map(issues.map((issue) => [issue.id, issue]));
  let alertCount = 0;
  let deliveredAlertCount = 0;
  let deliveryFailureCount = 0;

  await Promise.all(monitorIds.map(async (monitorId) => {
    const issue = issuesById.get(monitorId);
    const previous = parseAlertState(await state.get(stateKey(monitorId)));
    const decision = nextAlertState(previous, issue !== undefined, now, config);

    if (issue && decision.shouldAlert) {
      alertCount += 1;
      logger.error("[ops-monitor-alert]", JSON.stringify(safeAlertPayload(issue, decision.state, runId)));
      const emailResult = await sendAlertEmail({
        emailConfig,
        issue,
        state: decision.state,
        runId,
        queueSummaries,
        logger,
      });
      if (emailResult === "sent") {
        deliveredAlertCount += 1;
      }
      if (emailResult === "failed") {
        deliveryFailureCount += 1;
      }
    }

    await state.put(stateKey(monitorId), JSON.stringify(decision.state), {
      expirationTtl: config.stateTtlSeconds,
    });
  }));

  return {
    alertCount,
    routedAlertCount: deliveredAlertCount,
    deliveryFailureCount,
  };
}

export async function runScheduledMonitor(
  env: OpsMonitorEnv,
  {
    now = Date.now(),
    fetchImpl = fetch,
    logger = console,
  }: {
    now?: number;
    fetchImpl?: typeof fetch;
    logger?: Pick<Console, "error" | "log">;
  } = {},
): Promise<void> {
  const runId = createRequestId(new Date(now));
  const startedAt = Date.now();
  const config = loadConfig(env);
  const emailConfig = loadAlertEmailConfig(env);
  const [readiness, queueChecks, alertProofMarker] = await Promise.all([
    checkReadiness({ readyzUrl: config.readyzUrl, fetchImpl, now, timeoutMs: config.readyzTimeoutMs }),
    collectQueueChecks(env, config, now),
    consumeAlertProofMarker(env.OPS_MONITOR_STATE, now),
  ]);
  const queueIssues = queueChecks.issues;
  const normalIssues = readiness.issue ? [readiness.issue, ...queueIssues] : queueIssues;
  const proofIssues = alertProofMarker.issue ? [alertProofMarker.issue] : [];
  const issues = [...normalIssues, ...proofIssues];
  const monitorIds = ["readyz", ...MONITORED_QUEUES.map((queue) => `queue:${queue.name}`)];
  const alerting = await applyAlerting({
    state: env.OPS_MONITOR_STATE,
    issues: normalIssues,
    monitorIds,
    config,
    now,
    runId,
    emailConfig,
    queueSummaries: queueChecks.summaries,
    logger,
  });
  const proofAlerting = proofIssues.length === 0
    ? { alertCount: 0, routedAlertCount: 0, deliveryFailureCount: 0 }
    : await applyAlerting({
      state: env.OPS_MONITOR_STATE,
      issues: proofIssues,
      monitorIds: proofIssues.map((issue) => issue.id),
      config: {
        ...config,
        alertStreakThreshold: 1,
        alertCooldownMs: 0,
      },
      now,
      runId,
      emailConfig,
      queueSummaries: queueChecks.summaries,
      logger,
    });
  const alertProofResultKey = await writeAlertProofResult({
    state: env.OPS_MONITOR_STATE,
    marker: alertProofMarker,
    alerting: proofAlerting,
    runId,
    now,
    logger,
  });
  const alertCounts = {
    alertCount: alerting.alertCount + proofAlerting.alertCount,
    routedAlertCount: alerting.routedAlertCount + proofAlerting.routedAlertCount,
    deliveryFailureCount: alerting.deliveryFailureCount + proofAlerting.deliveryFailureCount,
  };

  logger.log("[ops-monitor]", JSON.stringify({
    event: "ops_monitor.run_completed",
    monitorId: "ops-monitor",
    runId,
    status: issues.length === 0 ? "ok" : "issues",
    durationMs: Date.now() - startedAt,
    issueCount: issues.length,
    alertCount: alertCounts.alertCount,
    routedAlertCount: alertCounts.routedAlertCount,
    deliveryFailureCount: alertCounts.deliveryFailureCount,
    requestId: readiness.requestId,
    readyz: readiness.summary,
    queues: queueChecks.summaries,
    alertProofMarker: alertProofMarker.consumed
      ? {
        consumed: true,
        accepted: alertProofMarker.issue !== null,
        nonce: alertProofMarker.nonce,
        resultKey: alertProofResultKey,
        status: alertProofMarker.issue ? alertProofStatus(proofAlerting) : undefined,
        ignoredReason: alertProofMarker.ignoredReason,
      }
      : undefined,
  }));
}

export default {
  fetch(_request: Request) {
    return new Response("Not found", {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  },
  async scheduled(_controller: ScheduledController, env: OpsMonitorEnv): Promise<void> {
    await runScheduledMonitor(env);
  },
};
