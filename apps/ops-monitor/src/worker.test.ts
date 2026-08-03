import { describe, expect, it, vi } from "vitest";

import worker, {
  MONITORED_QUEUES,
  OPS_ALERT_PROOF_MARKER_KEY,
  OPS_ALERT_PROOF_RESULT_KEY_PREFIX,
  applyAlerting,
  checkReadiness,
  checkQueues,
  collectQueueChecks,
  evaluateQueueMetrics,
  evaluateReadinessResponse,
  loadConfig,
  nextAlertState,
  runScheduledMonitor,
  type AlertState,
  type AlertEmailConfig,
  type MonitorConfig,
  type OpsMonitorEnv,
  type OpsMonitorEmailBinding,
  type OpsMonitorStateNamespace,
  type QueueMetricsBinding,
} from "./worker";

const config: MonitorConfig = {
  readyzUrl: "https://api.example.test/api/v1/readyz",
  readyzTimeoutMs: 10_000,
  queueMetricsTimeoutMs: 5_000,
  dlqBacklogThreshold: 0,
  queueOldestAgeThresholdMs: 300_000,
  alertStreakThreshold: 3,
  alertCooldownMs: 300_000,
  stateTtlSeconds: 3_600,
};

function createQueue(metrics: Awaited<ReturnType<QueueMetricsBinding["metrics"]>>): QueueMetricsBinding {
  return {
    metrics: vi.fn(async () => metrics),
  };
}

function createEmailBinding(
  send: OpsMonitorEmailBinding["send"] = vi.fn(async () => ({ messageId: "email-safe" })),
): OpsMonitorEmailBinding {
  return { send };
}

function createEmailConfig(binding = createEmailBinding()): AlertEmailConfig {
  return {
    binding,
    from: "ops-alerts@example.test",
    to: ["oncall@example.test"],
    subjectPrefix: "[Scalius ops]",
  };
}

function createState(
  initial: Record<string, AlertState | string> = {},
): OpsMonitorStateNamespace & { values: Map<string, string> } {
  const values = new Map(
    Object.entries(initial).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]),
  );
  return {
    values,
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
}

function createEnv(overrides: Partial<OpsMonitorEnv> = {}): OpsMonitorEnv {
  const empty = createQueue({ backlogCount: 0 });
  return {
    OPS_MONITOR_STATE: createState(),
    READYZ_URL: config.readyzUrl,
    READYZ_TIMEOUT_MS: "10000",
    QUEUE_METRICS_TIMEOUT_MS: "5000",
    DLQ_BACKLOG_THRESHOLD: "0",
    QUEUE_OLDEST_AGE_THRESHOLD_MS: "300000",
    ALERT_STREAK_THRESHOLD: "3",
    ALERT_COOLDOWN_MS: "300000",
    STATE_TTL_SECONDS: "3600",
    PAYMENT_EVENTS_QUEUE: empty,
    PAYMENT_EVENTS_DLQ: empty,
    ORDER_NOTIFICATIONS_QUEUE: empty,
    ORDER_NOTIFICATIONS_DLQ: empty,
    AUTH_OTP_QUEUE: empty,
    AUTH_OTP_DLQ: empty,
    ...overrides,
  };
}

describe("config loading", () => {
  it("loads conservative timeout defaults and accepts configured positive values", () => {
    expect(loadConfig({})).toMatchObject({
      readyzTimeoutMs: 10_000,
      queueMetricsTimeoutMs: 5_000,
    });
    expect(loadConfig({
      READYZ_TIMEOUT_MS: "2500",
      QUEUE_METRICS_TIMEOUT_MS: 750,
    })).toMatchObject({
      readyzTimeoutMs: 2_500,
      queueMetricsTimeoutMs: 750,
    });
    expect(loadConfig({
      READYZ_TIMEOUT_MS: "0",
      QUEUE_METRICS_TIMEOUT_MS: "not-a-number",
    })).toMatchObject({
      readyzTimeoutMs: 10_000,
      queueMetricsTimeoutMs: 5_000,
    });
  });
});

describe("readiness evaluation", () => {
  it("requires 200, success true, ready status, and every check ok", () => {
    expect(evaluateReadinessResponse(200, {
      success: true,
      status: "ready",
      checks: {
        d1: { status: "ok" },
        api_cache_kv: { status: "ok" },
      },
    })).toEqual({
      ready: true,
      status: "ok",
      failedChecks: [],
    });

    expect(evaluateReadinessResponse(503, {
      success: false,
      status: "degraded",
      checks: {
        d1: { status: "timeout" },
        runtime_config: { status: "ok" },
      },
    })).toMatchObject({
      ready: false,
      status: "degraded",
      failedChecks: ["http:503", "success:false", "status:degraded", "d1:timeout"],
    });
  });

  it("sends safe readiness headers and reports degraded checks", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        Accept: "application/json",
        "Cache-Control": "no-cache",
      });
      expect(String((init?.headers as Record<string, string>)["X-Request-Id"])).toMatch(/^ops-monitor-/);
      return Response.json({
        success: false,
        status: "degraded",
        checks: { d1: { status: "error" } },
      }, { status: 503 });
    });

    const result = await checkReadiness({
      readyzUrl: config.readyzUrl,
      fetchImpl,
      now: Date.UTC(2026, 0, 1),
    });

    expect(result.issue).toMatchObject({
      id: "readyz",
      kind: "readyz",
      status: "degraded",
      failedChecks: ["http:503", "success:false", "status:degraded", "d1:error"],
    });
    expect(result.summary).toMatchObject({
      status: "degraded",
      failedChecks: ["http:503", "success:false", "status:degraded", "d1:error"],
    });
  });

  it("times out hung readiness fetches with a safe dependency issue", async () => {
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeDefined();
      return new Promise<Response>(() => undefined);
    });

    const result = await checkReadiness({
      readyzUrl: config.readyzUrl,
      fetchImpl,
      now: Date.UTC(2026, 0, 1),
      timeoutMs: 1,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.issue).toMatchObject({
      id: "readyz",
      kind: "readyz",
      status: "error",
      failedChecks: ["fetch:timeout"],
    });
    expect(result.summary).toMatchObject({
      status: "error",
      failedChecks: ["fetch:timeout"],
    });
  });
});

describe("queue issue detection", () => {
  it("flags DLQ backlog over threshold and normal queues older than threshold", () => {
    const now = Date.UTC(2026, 0, 1, 0, 10, 0);
    const normalQueue = MONITORED_QUEUES.find((queue) => queue.name === "payment-events");
    const dlq = MONITORED_QUEUES.find((queue) => queue.name === "payment-events-dlq");

    expect(normalQueue).toBeDefined();
    expect(dlq).toBeDefined();
    expect(evaluateQueueMetrics(normalQueue!, {
      backlogCount: 4,
      oldestMessageTimestamp: now - 300_001,
    }, config, now)).toMatchObject({
      id: "queue:payment-events",
      status: "threshold",
      backlogCount: 4,
      oldestMessageAgeMs: 300_001,
    });
    expect(evaluateQueueMetrics(dlq!, {
      backlogCount: 1,
      oldestMessageTimestamp: now - 1_000,
    }, config, now)).toMatchObject({
      id: "queue:payment-events-dlq",
      status: "threshold",
      backlogCount: 1,
    });
  });

  it("treats metrics failures as monitor issues without provider payloads", async () => {
    const env = createEnv({
      AUTH_OTP_QUEUE: {
        metrics: vi.fn(async () => {
          throw new Error("provider payload should not be logged");
        }),
      },
    });

    const issues = await checkQueues(env, config, Date.UTC(2026, 0, 1));

    expect(issues).toEqual([
      expect.objectContaining({
        id: "queue:auth-otp",
        kind: "monitor",
        name: "auth-otp",
        status: "error",
        queueName: "auth-otp",
        failedChecks: ["metrics:error"],
      }),
    ]);
    expect(JSON.stringify(issues)).not.toContain("provider payload");
  });

  it("times out one stuck queue metrics read without blocking other queues", async () => {
    const env = createEnv({
      AUTH_OTP_QUEUE: {
        metrics: vi.fn(() => new Promise<never>(() => undefined)),
      },
    });

    const checks = await collectQueueChecks(env, {
      ...config,
      queueMetricsTimeoutMs: 1,
    }, Date.UTC(2026, 0, 1));

    expect(checks.issues).toEqual([
      expect.objectContaining({
        id: "queue:auth-otp",
        kind: "monitor",
        status: "error",
        failedChecks: ["metrics:timeout"],
      }),
    ]);
    expect(checks.summaries).toHaveLength(6);
    expect(checks.summaries.find((summary) => summary.queueName === "auth-otp")).toMatchObject({
      queueName: "auth-otp",
      status: "error",
      backlogCount: null,
      oldestMessageAgeMs: null,
    });
    expect(checks.summaries.filter((summary) => summary.status === "ok")).toHaveLength(5);
  });

  it("returns safe summaries for every queue even when there are no issues", async () => {
    const now = Date.UTC(2026, 0, 1, 0, 10, 0);
    const checks = await collectQueueChecks(createEnv(), config, now);

    expect(checks.issues).toEqual([]);
    expect(checks.summaries).toHaveLength(6);
    expect(checks.summaries[0]).toMatchObject({
      queueName: "payment-events",
      kind: "normal",
      status: "ok",
      backlogCount: 0,
      oldestMessageAgeMs: null,
    });
    expect(JSON.stringify(checks.summaries)).not.toContain("provider payload");
  });
});

describe("streak and cooldown alerting", () => {
  it("waits for the configured streak before alerting", () => {
    const first = nextAlertState(null, true, 1_000, config);
    const second = nextAlertState(first.state, true, 2_000, config);
    const third = nextAlertState(second.state, true, 3_000, config);

    expect(first.shouldAlert).toBe(false);
    expect(second.shouldAlert).toBe(false);
    expect(third.shouldAlert).toBe(true);
    expect(third.state).toMatchObject({
      status: "issue",
      streak: 3,
      lastAlertedAt: 3_000,
    });
  });

  it("suppresses repeated alerts until cooldown expires and resets streak on recovery", async () => {
    const state = createState({
      "ops-monitor:v1:readyz": {
        status: "issue",
        streak: 3,
        lastAlertedAt: 10_000,
      },
    });
    const logger = { error: vi.fn() };
    const issue = {
      id: "readyz",
      kind: "readyz" as const,
      name: "api.readyz",
      status: "degraded" as const,
      durationMs: 25,
      requestId: "ops-monitor-safe",
      failedChecks: ["d1:error"],
    };

    await expect(applyAlerting({
      state,
      issues: [issue],
      monitorIds: ["readyz"],
      config,
      now: 20_000,
      runId: "run-safe",
      emailConfig: createEmailConfig(),
      logger,
    })).resolves.toMatchObject({
      alertCount: 0,
      routedAlertCount: 0,
      deliveryFailureCount: 0,
    });
    expect(logger.error).not.toHaveBeenCalled();

    const emailConfig = createEmailConfig();
    await expect(applyAlerting({
      state,
      issues: [issue],
      monitorIds: ["readyz"],
      config,
      now: 310_000,
      runId: "run-safe",
      emailConfig,
      logger,
    })).resolves.toMatchObject({
      alertCount: 1,
      routedAlertCount: 1,
      deliveryFailureCount: 0,
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]?.[0]).toBe("[ops-monitor-alert]");
    expect(JSON.parse(logger.error.mock.calls[0]?.[1] as string)).toMatchObject({
      event: "ops_monitor.alert",
      monitorId: "readyz",
      checkKind: "readyz",
      checkName: "api.readyz",
      status: "degraded",
      requestId: "ops-monitor-safe",
      failedChecks: ["d1:error"],
    });

    await applyAlerting({
      state,
      issues: [],
      monitorIds: ["readyz"],
      config,
      now: 320_000,
      runId: "run-safe",
      logger,
    });
    expect(JSON.parse(state.values.get("ops-monitor:v1:readyz") ?? "{}")).toMatchObject({
      status: "ok",
      streak: 0,
    });
  });

  it("sends a compact redacted email when the routed alert channel is configured", async () => {
    const state = createState();
    const send = vi.fn(async (_message: Parameters<OpsMonitorEmailBinding["send"]>[0]) => ({
      messageId: "email-safe",
    }));
    const issue = {
      id: "queue:payment-events",
      kind: "queue" as const,
      name: "payment-events",
      status: "threshold" as const,
      durationMs: 12,
      queueName: "payment-events",
      backlogCount: 3,
      oldestMessageAgeMs: 310_000,
    };
    const oneStrikeConfig = { ...config, alertStreakThreshold: 1 };
    const logger = { error: vi.fn() };

    await expect(applyAlerting({
      state,
      issues: [issue],
      monitorIds: ["queue:payment-events"],
      config: oneStrikeConfig,
      now: Date.UTC(2026, 0, 1, 0, 5, 0),
      runId: "run-safe",
      emailConfig: createEmailConfig(createEmailBinding(send)),
      queueSummaries: [{
        queueName: "payment-events",
        kind: "normal",
        status: "threshold",
        durationMs: 12,
        backlogCount: 3,
        oldestMessageAgeMs: 310_000,
      }],
      logger,
    })).resolves.toMatchObject({
      alertCount: 1,
      routedAlertCount: 1,
      deliveryFailureCount: 0,
    });

    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0]?.[0];
    expect(message).toMatchObject({
      from: "ops-alerts@example.test",
      to: ["oncall@example.test"],
      subject: "[Scalius ops] threshold payment-events",
    });
    expect(message?.text).toContain("key: queue:payment-events");
    expect(message?.text).toContain("streak: 1");
    expect(message?.text).toContain("firstSeenAt: 2026-01-01T00:05:00.000Z");
    expect(message?.text).toContain("- payment-events normal threshold backlog=3 oldestAgeMs=310000 durationMs=12");
    expect(message?.text).not.toContain("provider payload");
    expect(message?.text).not.toContain("customer");
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logger.error.mock.calls[0]?.[1] as string)).toMatchObject({
      event: "ops_monitor.alert",
      monitorId: "queue:payment-events",
      streak: 1,
    });
  });

  it("keeps missing email config log-only without reporting a routed alert success", async () => {
    const logger = { log: vi.fn(), error: vi.fn() };
    const fetchImpl = vi.fn(async () =>
      Response.json({
        success: false,
        status: "degraded",
        checks: { d1: { status: "error" } },
      }, { status: 503 }));

    await runScheduledMonitor(createEnv({
      ALERT_STREAK_THRESHOLD: "1",
    }), {
      now: Date.UTC(2026, 0, 1),
      fetchImpl,
      logger,
    });

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logger.error.mock.calls[0]?.[1] as string)).toMatchObject({
      event: "ops_monitor.alert",
      monitorId: "readyz",
    });
    const payload = JSON.parse(logger.log.mock.calls[0]?.[1] as string);
    expect(payload).toMatchObject({
      event: "ops_monitor.run_completed",
      status: "issues",
      issueCount: 1,
      alertCount: 1,
      routedAlertCount: 0,
      deliveryFailureCount: 0,
      readyz: {
        status: "degraded",
        failedChecks: ["http:503", "success:false", "status:degraded", "d1:error"],
      },
    });
  });

  it("consumes a valid scheduled alert proof marker and sends one routed email", async () => {
    const now = Date.UTC(2026, 0, 1, 0, 5, 0);
    const nonce = "ops-005-test";
    const resultKey = `${OPS_ALERT_PROOF_RESULT_KEY_PREFIX}:${nonce}`;
    const state = createState({
      [OPS_ALERT_PROOF_MARKER_KEY]: JSON.stringify({ nonce, expiresAt: now + 60_000 }),
    });
    const send = vi.fn(async (_message: Parameters<OpsMonitorEmailBinding["send"]>[0]) => ({
      messageId: "email-safe",
    }));
    const logger = { log: vi.fn(), error: vi.fn() };
    const fetchImpl = vi.fn(async () =>
      Response.json({
        success: true,
        status: "ready",
        checks: { d1: { status: "ok" } },
      }));

    await runScheduledMonitor(createEnv({
      OPS_MONITOR_STATE: state,
      ALERT_EMAIL: createEmailBinding(send),
      ALERT_EMAIL_FROM: "ops-alerts@example.test",
      ALERT_EMAIL_TO: "oncall@example.test",
    }), {
      now,
      fetchImpl,
      logger,
    });

    expect(state.values.has(OPS_ALERT_PROOF_MARKER_KEY)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      from: "ops-alerts@example.test",
      to: ["oncall@example.test"],
      subject: "[Scalius ops] threshold ops-monitor.routed-alert-proof",
    });
    expect(send.mock.calls[0]?.[0].text).toContain("key: proof:routed-alert:ops-005-test");
    expect(send.mock.calls[0]?.[0].text).toContain("failedChecks: synthetic:scheduled-routed-alert-proof");
    expect(JSON.stringify(send.mock.calls[0]?.[0])).not.toContain("oncall@example.test or provider payload");
    expect(JSON.parse(state.values.get(resultKey) ?? "{}")).toMatchObject({
      version: 1,
      type: "routed-alert-proof-result",
      nonce,
      status: "sent",
      attemptedAt: "2026-01-01T00:05:00.000Z",
      runId: expect.stringMatching(/^ops-monitor-/),
      monitorId: "proof:routed-alert:ops-005-test",
      alertCount: 1,
      routedAlertCount: 1,
      deliveryFailureCount: 0,
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logger.error.mock.calls[0]?.[1] as string)).toMatchObject({
      event: "ops_monitor.alert",
      monitorId: "proof:routed-alert:ops-005-test",
      checkName: "ops-monitor.routed-alert-proof",
    });
    expect(JSON.parse(logger.log.mock.calls[0]?.[1] as string)).toMatchObject({
      event: "ops_monitor.run_completed",
      status: "issues",
      issueCount: 1,
      alertCount: 1,
      routedAlertCount: 1,
      deliveryFailureCount: 0,
      alertProofMarker: {
        consumed: true,
        accepted: true,
        nonce,
        resultKey,
        status: "sent",
      },
    });
  });

  it("consumes a valid alert proof marker when email config is missing without routed send", async () => {
    const now = Date.UTC(2026, 0, 1, 0, 5, 0);
    const nonce = "ops-005-log-only";
    const resultKey = `${OPS_ALERT_PROOF_RESULT_KEY_PREFIX}:${nonce}`;
    const state = createState({
      [OPS_ALERT_PROOF_MARKER_KEY]: JSON.stringify({ nonce, expiresAt: now + 60_000 }),
    });
    const logger = { log: vi.fn(), error: vi.fn() };
    const fetchImpl = vi.fn(async () =>
      Response.json({
        success: true,
        status: "ready",
        checks: { d1: { status: "ok" } },
      }));

    await runScheduledMonitor(createEnv({
      OPS_MONITOR_STATE: state,
    }), {
      now,
      fetchImpl,
      logger,
    });

    expect(state.values.has(OPS_ALERT_PROOF_MARKER_KEY)).toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logger.error.mock.calls[0]?.[1] as string)).toMatchObject({
      event: "ops_monitor.alert",
      monitorId: "proof:routed-alert:ops-005-log-only",
    });
    expect(JSON.parse(state.values.get(resultKey) ?? "{}")).toMatchObject({
      version: 1,
      type: "routed-alert-proof-result",
      nonce,
      status: "log_only",
      monitorId: "proof:routed-alert:ops-005-log-only",
      alertCount: 1,
      routedAlertCount: 0,
      deliveryFailureCount: 0,
    });
    expect(JSON.parse(logger.log.mock.calls[0]?.[1] as string)).toMatchObject({
      event: "ops_monitor.run_completed",
      issueCount: 1,
      alertCount: 1,
      routedAlertCount: 0,
      deliveryFailureCount: 0,
      alertProofMarker: {
        consumed: true,
        accepted: true,
        nonce,
        resultKey,
        status: "log_only",
      },
    });
  });

  it.each([
    ["expired", JSON.stringify({ expiresAt: Date.UTC(2026, 0, 1, 0, 4, 59) }), "expired"],
    ["invalid", "not-json", "invalid"],
    ["unsafe nonce", JSON.stringify({ nonce: "unsafe address@example.test", expiresAt: Date.UTC(2026, 0, 1, 0, 6, 0) }), "invalid"],
  ])("ignores and consumes an %s scheduled alert proof marker safely", async (_label, markerValue, ignoredReason) => {
    const now = Date.UTC(2026, 0, 1, 0, 5, 0);
    const state = createState({
      [OPS_ALERT_PROOF_MARKER_KEY]: markerValue,
    });
    const send = vi.fn(async () => ({ messageId: "email-safe" }));
    const logger = { log: vi.fn(), error: vi.fn() };
    const fetchImpl = vi.fn(async () =>
      Response.json({
        success: true,
        status: "ready",
        checks: { d1: { status: "ok" } },
      }));

    await runScheduledMonitor(createEnv({
      OPS_MONITOR_STATE: state,
      ALERT_EMAIL: createEmailBinding(send),
      ALERT_EMAIL_FROM: "ops-alerts@example.test",
      ALERT_EMAIL_TO: "oncall@example.test",
    }), {
      now,
      fetchImpl,
      logger,
    });

    expect(state.values.has(OPS_ALERT_PROOF_MARKER_KEY)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(JSON.parse(logger.log.mock.calls[0]?.[1] as string)).toMatchObject({
      event: "ops_monitor.run_completed",
      status: "ok",
      issueCount: 0,
      alertCount: 0,
      routedAlertCount: 0,
      deliveryFailureCount: 0,
      alertProofMarker: {
        consumed: true,
        accepted: false,
        ignoredReason,
      },
    });
  });

  it("emits run completion when readiness fetch hangs", async () => {
    const logger = { log: vi.fn(), error: vi.fn() };
    const fetchImpl = vi.fn(() => new Promise<Response>(() => undefined));

    await runScheduledMonitor(createEnv({
      READYZ_TIMEOUT_MS: "1",
      ALERT_STREAK_THRESHOLD: "1",
    }), {
      now: Date.UTC(2026, 0, 1),
      fetchImpl,
      logger,
    });

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(logger.log.mock.calls[0]?.[1] as string);
    expect(payload).toMatchObject({
      event: "ops_monitor.run_completed",
      status: "issues",
      issueCount: 1,
      alertCount: 1,
      readyz: {
        status: "error",
        failedChecks: ["fetch:timeout"],
      },
    });
    expect(payload.queues).toHaveLength(6);
    expect(JSON.stringify(payload)).not.toContain("provider payload");
  });

  it("logs delivery failures compactly and continues the run", async () => {
    const logger = { log: vi.fn(), error: vi.fn() };
    const send = vi.fn(async () => {
      const error = new Error("do not log oncall@example.test or provider payload");
      (error as Error & { code: string }).code = "EMAIL_SEND_FAILED";
      throw error;
    });
    const fetchImpl = vi.fn(async () =>
      Response.json({
        success: false,
        status: "degraded",
        checks: { runtime_config: { status: "missing" } },
      }, { status: 503 }));

    await runScheduledMonitor(createEnv({
      ALERT_STREAK_THRESHOLD: "1",
      ALERT_EMAIL: createEmailBinding(send),
      ALERT_EMAIL_FROM: "ops-alerts@example.test",
      ALERT_EMAIL_TO: "oncall@example.test",
    }), {
      now: Date.UTC(2026, 0, 1),
      fetchImpl,
      logger,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(2);
    const deliveryFailure = JSON.parse(logger.error.mock.calls[1]?.[1] as string);
    expect(deliveryFailure).toMatchObject({
      event: "ops_monitor.alert_delivery_failed",
      monitorId: "readyz",
      errorName: "Error",
      errorCode: "EMAIL_SEND_FAILED",
    });
    expect(JSON.stringify(deliveryFailure)).not.toContain("oncall@example.test");
    expect(JSON.stringify(deliveryFailure)).not.toContain("provider payload");
    expect(JSON.parse(logger.log.mock.calls[0]?.[1] as string)).toMatchObject({
      event: "ops_monitor.run_completed",
      status: "issues",
      alertCount: 1,
      routedAlertCount: 0,
      deliveryFailureCount: 1,
    });
  });

  it("logs a compact healthy run summary with queue metric evidence", async () => {
    const logger = { log: vi.fn(), error: vi.fn() };
    const fetchImpl = vi.fn(async () =>
      Response.json({
        success: true,
        status: "ready",
        checks: { d1: { status: "ok" } },
      }));

    await runScheduledMonitor(createEnv(), {
      now: Date.UTC(2026, 0, 1),
      fetchImpl,
      logger,
    });

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(logger.log.mock.calls[0]?.[1] as string);
    expect(payload).toMatchObject({
      event: "ops_monitor.run_completed",
      status: "ok",
      issueCount: 0,
      alertCount: 0,
      readyz: {
        status: "ok",
        failedChecks: [],
      },
    });
    expect(payload.queues).toHaveLength(6);
    expect(payload.queues[0]).toMatchObject({
      queueName: "payment-events",
      kind: "normal",
      status: "ok",
      backlogCount: 0,
    });
  });
});

describe("public fetch surface", () => {
  it("keeps every public request closed with a 404", () => {
    const response = worker.fetch(new Request("https://ops-monitor.example.test/alert-proof"));

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
