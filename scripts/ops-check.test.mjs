import { describe, expect, it, vi } from "vitest";
import {
  buildApiV1Url,
  buildWranglerDeploymentsCommand,
  buildWranglerQueueInfoCommand,
  evaluateMonitoringConfig,
  evaluateLatestDeployment,
  evaluateQueueInfoOutput,
  evaluateReadinessSamples,
  getKnownQueueNames,
  parseOpsCheckArgs,
  parseWranglerQueueInfoOutput,
  runOpsCheck,
} from "./ops-check.mjs";

function monitoringApiConfig() {
  return {
    name: "scalius-api",
    observability: { enabled: true },
    triggers: { crons: ["*/15 * * * *"] },
    queues: {
      producers: [{ queue: "payment-events" }],
      consumers: [
        { queue: "payment-events", dead_letter_queue: "payment-events-dlq" },
        { queue: "payment-events-dlq" },
      ],
    },
  };
}

function readyResponse() {
  return new Response(JSON.stringify({
    success: true,
    status: "ready",
    checks: {
      d1: { status: "ok", latencyMs: 20 },
      api_cache_kv: { status: "ok", latencyMs: 30 },
      r2: { status: "ok", latencyMs: 40 },
    },
  }), { status: 200 });
}

function degradedResponse(status = 503) {
  return new Response(JSON.stringify({
    success: false,
    status: "degraded",
    checks: {
      d1: { status: "ok", latencyMs: 20 },
      api_cache_kv: { status: "timeout", latencyMs: 1_500 },
      r2: { status: "ok", latencyMs: 40 },
    },
  }), { status });
}

function textResponse(body, status = 200) {
  return new Response(body, { status });
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status });
}

describe("ops-check config helpers", () => {
  it("parses supported flags and validates incompatible options", () => {
    expect(parseOpsCheckArgs([
      "--json",
      "--api-base-url",
      "https://api.example.test/api/v1",
      "--samples=2",
      "--timeout-ms",
      "5000",
    ], { defaultApiBaseUrl: "https://api.scalius.com" })).toMatchObject({
      json: true,
      apiBaseUrl: "https://api.example.test/api/v1",
      samples: 2,
      timeoutMs: 5000,
      skipWrangler: false,
      queues: false,
    });

    expect(() => parseOpsCheckArgs(["--samples", "0"])).toThrow("--samples must be a positive integer");
    expect(() => parseOpsCheckArgs(["--skip-wrangler", "--queues"])).toThrow("cannot be combined");
  });

  it("builds API v1 URLs without duplicating an existing prefix", () => {
    expect(buildApiV1Url("https://api.example.test", "/readyz")).toBe("https://api.example.test/api/v1/readyz");
    expect(buildApiV1Url("https://api.example.test/api/v1", "/readyz")).toBe("https://api.example.test/api/v1/readyz");
  });

  it("derives known queue names from the API Wrangler config shape", () => {
    expect(getKnownQueueNames({
      queues: {
        producers: [{ queue: "payment-events" }],
        consumers: [
          { queue: "payment-events", dead_letter_queue: "payment-events-dlq" },
          { queue: "payment-events-dlq" },
          { queue: "auth-otp", dead_letter_queue: "auth-otp-dlq" },
        ],
      },
    })).toEqual(["payment-events", "payment-events-dlq", "auth-otp", "auth-otp-dlq"]);
  });

  it("validates monitoring config preconditions from the API Wrangler config", () => {
    expect(evaluateMonitoringConfig(monitoringApiConfig())).toMatchObject({
      ok: true,
      workerName: "scalius-api",
      observabilityEnabled: true,
      requiredCronPresent: true,
      queueCount: 2,
      normalQueueCount: 1,
      deadLetterQueueCount: 1,
    });

    expect(evaluateMonitoringConfig({
      name: "scalius-api",
      observability: { enabled: false },
      triggers: { crons: [] },
      queues: {
        producers: [{ queue: "payment-events" }],
        consumers: [{ queue: "payment-events" }],
      },
    })).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.stringContaining("observability.enabled true"),
        expect.stringContaining("scheduled maintenance cron"),
        expect.stringContaining("dead_letter_queue"),
      ]),
    });
  });
});

describe("ops-check readiness evaluation", () => {
  it("passes a recovered transient readiness window", () => {
    const result = evaluateReadinessSamples([
      { ready: false, statusCode: 503, summary: "r2:timeout" },
      { ready: true, statusCode: 200, summary: "d1:ok" },
      { ready: true, statusCode: 200, summary: "d1:ok" },
      { ready: true, statusCode: 200, summary: "d1:ok" },
    ]);

    expect(result).toMatchObject({
      ok: true,
      readyCount: 3,
      requiredReadyCount: 2,
      finalReady: true,
      transientRecovery: true,
    });
  });

  it("fails persistent or final degraded readiness", () => {
    expect(evaluateReadinessSamples([
      { ready: true, statusCode: 200, summary: "d1:ok" },
      { ready: false, statusCode: 503, summary: "r2:timeout" },
    ])).toMatchObject({
      ok: false,
      readyCount: 1,
      finalReady: false,
    });
  });
});

describe("ops-check Wrangler helpers", () => {
  it("uses app-local Wrangler commands through pnpm --dir apps/api", () => {
    expect(buildWranglerDeploymentsCommand({
      pnpmExecutable: "pnpm",
      rootDir: "/repo",
    })).toMatchObject({
      command: "pnpm",
      args: ["--dir", "apps/api", "exec", "wrangler", "deployments", "list", "--json"],
      cwd: "/repo",
      display: "pnpm --dir apps/api exec wrangler deployments list --json",
    });

    expect(buildWranglerQueueInfoCommand("auth-otp", {
      pnpmExecutable: "pnpm",
      rootDir: "/repo",
    })).toMatchObject({
      command: "pnpm",
      args: ["--dir", "apps/api", "exec", "wrangler", "queues", "info", "auth-otp"],
      cwd: "/repo",
      display: "pnpm --dir apps/api exec wrangler queues info auth-otp",
    });
  });

  it("requires the latest deployment to have exactly one 100% version", () => {
    expect(evaluateLatestDeployment([
      {
        created_on: "2026-07-05T01:00:00Z",
        versions: [{ version_id: "old", percentage: 100 }],
      },
      {
        created_on: "2026-07-05T02:00:00Z",
        versions: [{ version_id: "new", percentage: 100 }],
      },
    ])).toMatchObject({
      ok: true,
      versionId: "new",
      fullyServedVersionCount: 1,
    });

    expect(evaluateLatestDeployment([
      {
        created_on: "2026-07-05T02:00:00Z",
        versions: [
          { version_id: "a", percentage: 50 },
          { version_id: "b", percentage: 50 },
        ],
      },
    ])).toMatchObject({
      ok: false,
      fullyServedVersionCount: 0,
    });
  });

  it("parses Wrangler queue info and fails missing provider actors", () => {
    const output = [
      "Queue Name: payment-events",
      "Queue ID: queue-id",
      "Number of Producers: 1",
      "Producers: worker:scalius-api",
      "Number of Consumers: 0",
    ].join("\n");

    expect(parseWranglerQueueInfoOutput(output)).toMatchObject({
      name: "payment-events",
      producerCount: 1,
      consumerCount: 0,
      producers: ["worker:scalius-api"],
      consumers: [],
    });

    expect(evaluateQueueInfoOutput("payment-events", output, {
      expectedProducers: ["worker:scalius-api"],
      expectedConsumers: ["worker:scalius-api"],
    })).toMatchObject({
      ok: false,
      errors: ["missing expected consumer worker:scalius-api"],
    });
  });
});

describe("runOpsCheck", () => {
  it("runs HTTP checks and deployment proof with fake fetch and fake exec", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      const path = new URL(url).pathname;
      expect(init.method).toBe("GET");
      expect(init.headers["X-Request-Id"]).toBe("ops-check-test");
      expect(init.headers["Cache-Control"]).toBe("no-cache");

      if (path === "/api/v1/health") return textResponse("ok");
      if (path === "/api/v1/readyz") return readyResponse();
      if (path === "/api/v1/openapi.json") {
        return jsonResponse({
          openapi: "3.0.0",
          paths: {
            "/api/v1/health": {},
            "/api/v1/readyz": {},
            "/api/v1/openapi.json": {},
          },
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const execFileImpl = vi.fn(async (command, args) => {
      expect(command).toBe("pnpm");
      expect(args).toEqual(["--dir", "apps/api", "exec", "wrangler", "deployments", "list", "--json"]);
      return {
        stdout: JSON.stringify([
          {
            created_on: "2026-07-05T02:00:00Z",
            versions: [{ version_id: "api-version", percentage: 100 }],
          },
        ]),
      };
    });

    const result = await runOpsCheck(parseOpsCheckArgs(["--samples", "1"], {
      defaultApiBaseUrl: "https://api.example.test",
    }), {
      apiConfig: monitoringApiConfig(),
      fetchImpl,
      execFileImpl,
      sleepImpl: async () => undefined,
      logger: null,
      pnpmExecutable: "pnpm",
      rootDir: "/repo",
      requestId: "ops-check-test",
    });

    expect(result.status).toBe("passed");
    expect(result.checks.health.statusCode).toBe(200);
    expect(result.checks.readyz.readyCount).toBe(1);
    expect(result.checks.openapi.pathCount).toBe(3);
    expect(result.checks.monitoringConfig.status).toBe("passed");
    expect(result.checks.deployment.versionId).toBe("api-version");
    expect(result.checks.queues.status).toBe("skipped");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(execFileImpl).toHaveBeenCalledTimes(1);
  });

  it("warns but passes when readiness recovers by the final sample", async () => {
    const fetchImpl = vi.fn(async (url) => {
      const path = new URL(url).pathname;
      if (path === "/api/v1/health") return textResponse("ok");
      if (path === "/api/v1/readyz") {
        return fetchImpl.mock.calls.filter(([calledUrl]) =>
          new URL(calledUrl).pathname === "/api/v1/readyz").length === 1
          ? degradedResponse()
          : readyResponse();
      }
      if (path === "/api/v1/openapi.json") return jsonResponse({ paths: { "/x": {} } });
      throw new Error(`Unexpected URL ${url}`);
    });
    const execFileImpl = vi.fn(async () => ({
      stdout: JSON.stringify([
        {
          created_on: "2026-07-05T02:00:00Z",
          versions: [{ version_id: "api-version", percentage: 100 }],
        },
      ]),
    }));

    const result = await runOpsCheck(parseOpsCheckArgs(["--samples", "3"], {
      defaultApiBaseUrl: "https://api.example.test",
    }), {
      apiConfig: monitoringApiConfig(),
      fetchImpl,
      execFileImpl,
      sleepImpl: async () => undefined,
      logger: null,
      pnpmExecutable: "pnpm",
      rootDir: "/repo",
      requestId: "ops-check-test",
    });

    expect(result.status).toBe("passed");
    expect(result.checks.readyz.status).toBe("warning");
    expect(result.checks.readyz.readyCount).toBe(2);
    expect(result.warnings).toContain("API /readyz recovered after transient degraded samples.");
  });

  it("runs optional queue info checks with fake exec", async () => {
    const fetchImpl = vi.fn(async (url) => {
      const path = new URL(url).pathname;
      if (path === "/api/v1/health") return textResponse("ok");
      if (path === "/api/v1/readyz") return readyResponse();
      if (path === "/api/v1/openapi.json") return jsonResponse({ paths: { "/x": {} } });
      throw new Error(`Unexpected URL ${url}`);
    });
    const execFileImpl = vi.fn(async (_command, args) => {
      if (args.includes("deployments")) {
        return {
          stdout: JSON.stringify([
            {
              created_on: "2026-07-05T02:00:00Z",
              versions: [{ version_id: "api-version", percentage: 100 }],
            },
          ]),
        };
      }
      const queueName = args.at(-1);
      const producerLines = queueName.endsWith("-dlq")
        ? ["Number of Producers: 0"]
        : ["Number of Producers: 1", "Producers: worker:scalius-api"];
      return {
        stdout: [
          `Queue Name: ${queueName}`,
          "Queue ID: queue-id",
          ...producerLines,
          "Number of Consumers: 1",
          "Consumers: worker:scalius-api",
        ].join("\n"),
      };
    });

    const result = await runOpsCheck(parseOpsCheckArgs(["--samples", "1", "--queues"], {
      defaultApiBaseUrl: "https://api.example.test",
    }), {
      apiConfig: monitoringApiConfig(),
      fetchImpl,
      execFileImpl,
      sleepImpl: async () => undefined,
      logger: null,
      pnpmExecutable: "pnpm",
      rootDir: "/repo",
      requestId: "ops-check-test",
    });

    expect(result.checks.queues.queueCount).toBe(2);
    expect(result.checks.queues.queues[0]).toMatchObject({
      name: "payment-events",
      producers: ["worker:scalius-api"],
      consumers: ["worker:scalius-api"],
      expectedProducers: ["worker:scalius-api"],
      expectedConsumers: ["worker:scalius-api"],
    });
    expect(execFileImpl.mock.calls.map(([, args]) => args.join(" "))).toEqual([
      "--dir apps/api exec wrangler deployments list --json",
      "--dir apps/api exec wrangler queues info payment-events",
      "--dir apps/api exec wrangler queues info payment-events-dlq",
    ]);
  });
});
