import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { CompiledWorkflowRead } from "../src/generated/workflow-resolver-core.gen.js";
import type { OpenApiDocument, ResolvedProfile } from "../src/types.js";
import {
  executeCompiledWorkflowRead,
  workflowReadUnavailable,
} from "../src/workflow-read.js";
import { createTestRuntime, validToken } from "./helpers.js";

function readOperation(
  operationId: string,
  path: string,
  batch: "parallel" | "sequential" = "parallel",
) {
  return {
    path,
    operation: {
      operationId,
      summary: operationId,
      parameters: [{
        in: "query",
        name: "view",
        required: false,
        schema: { type: "string" },
      }],
      responses: { "200": { description: "Projected read" } },
      "x-scalius-agent": {
        surface: "dashboard",
        exposure: "execute",
        principals: ["admin"],
        risk: "read",
        openWorld: false,
        idempotency: "none",
        revision: "none",
        batch,
        transport: "json",
        maximumResponseBytes: 128 * 1024,
        maxRequestBytes: 16 * 1024,
        sensitiveOutput: false,
        oneTimeSecretOutput: false,
      },
    },
  };
}

function document(): OpenApiDocument {
  const reads = [
    readOperation("dashboard.test.first", "/api/v1/admin/test/first"),
    readOperation("dashboard.test.second", "/api/v1/admin/test/second"),
    readOperation("dashboard.test.third", "/api/v1/admin/test/third", "sequential"),
  ];
  return {
    openapi: "3.1.0",
    paths: Object.fromEntries(reads.map(({ path, operation }) => [path, { get: operation }])),
  };
}

function compiled(): CompiledWorkflowRead {
  return {
    version: "3.0.0",
    workflowId: "test.projected-read.v1",
    rules: ["Treat the returned values as bounded current snapshots."],
    phases: [
      {
        id: "parallel",
        steps: [
          {
            namespace: "parallel.first",
            operationId: "dashboard.test.first",
            input: { query: { view: "today" } },
            output: {
              selectors: [{
                pointer: "/data/items",
                alias: "items",
                maxItems: 2,
                fields: [{ pointer: "/id", alias: "id" }],
              }],
            },
          },
          {
            namespace: "parallel.second",
            operationId: "dashboard.test.second",
            input: {},
            output: { selectors: [{ pointer: "/data/count", alias: "count" }] },
          },
        ],
      },
      {
        id: "after",
        steps: [{
          namespace: "after.third",
          operationId: "dashboard.test.third",
          input: {},
          output: { selectors: [{ pointer: "/data/ready", alias: "ready" }] },
        }],
      },
    ],
  };
}

const profile: ResolvedProfile = {
  name: "test",
  server: "https://api.example.test",
  token: validToken(),
  tokenSource: "environment",
};

describe("CLI projected workflow execution", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "scalius-workflow-read-"));
  });

  it("preflights the plan, uses two lanes and phase barriers, and emits projections only", async () => {
    let active = 0;
    let maxActive = 0;
    const starts: string[] = [];
    const fetch = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const name = url.pathname.split("/").at(-1)!;
      starts.push(name);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, name === "first" ? 5 : 1));
      active -= 1;
      if (name === "first") {
        expect(url.searchParams.get("view")).toBe("today");
        return Response.json({
          data: { items: [{ id: "one", buyerEmail: "hidden@example.com" }] },
          requestId: "hidden-request",
        });
      }
      if (name === "second") return Response.json({ data: { count: 7, secret: "hidden" } });
      return Response.json({ data: { ready: true, privateToken: "hidden" } });
    };
    const runtime = createTestRuntime({ directory, fetch: fetch as typeof globalThis.fetch });

    const result = await executeCompiledWorkflowRead(
      runtime,
      profile,
      document(),
      "dashboard",
      compiled(),
    );

    expect(maxActive).toBe(2);
    expect(starts.slice(0, 2)).toEqual(["first", "second"]);
    expect(starts[2]).toBe("third");
    expect(result).toEqual({
      kind: "result",
      disposition: "execute",
      version: "3.0.0",
      workflowId: "test.projected-read.v1",
      rules: ["Treat the returned values as bounded current snapshots."],
      outputs: {
        "parallel.first": { items: [{ id: "one" }] },
        "parallel.second": { count: 7 },
        "after.third": { ready: true },
      },
    });
    const serialized = JSON.stringify(result);
    for (const hidden of ["hidden@example.com", "hidden-request", "privateToken", "secret"]) {
      expect(serialized).not.toContain(hidden);
    }
  });

  it("rejects the whole plan before dispatch when a live operation is no longer a closed read", async () => {
    const contract = document();
    const second = contract.paths!["/api/v1/admin/test/second"]!.get as Record<string, unknown>;
    (second["x-scalius-agent"] as Record<string, unknown>).openWorld = true;
    let fetches = 0;
    const runtime = createTestRuntime({
      directory,
      fetch: (async () => {
        fetches += 1;
        return Response.json({});
      }) as typeof globalThis.fetch,
    });

    await expect(executeCompiledWorkflowRead(
      runtime,
      profile,
      contract,
      "dashboard",
      compiled(),
    )).resolves.toEqual(workflowReadUnavailable());
    expect(fetches).toBe(0);
  });

  it("rejects malformed compiled rules before dispatch", async () => {
    let fetches = 0;
    const runtime = createTestRuntime({
      directory,
      fetch: (async () => {
        fetches += 1;
        return Response.json({});
      }) as typeof globalThis.fetch,
    });
    for (const rules of [
      [],
      ["duplicate", "duplicate"],
      [" padded"],
      ["x".repeat(301)],
      Array.from({ length: 7 }, (_, index) => `rule ${index}`),
    ]) {
      const malformed = compiled();
      malformed.rules = rules;
      await expect(executeCompiledWorkflowRead(
        runtime,
        profile,
        document(),
        "dashboard",
        malformed,
      )).resolves.toEqual(workflowReadUnavailable());
    }
    expect(fetches).toBe(0);
  });

  it("fails closed on projection drift and returns unavailable above 64 KiB", async () => {
    const projectionDrift = createTestRuntime({
      directory,
      fetch: (async (input: string | URL | Request) => {
        const name = new URL(String(input)).pathname.split("/").at(-1);
        return name === "first"
          ? Response.json({ data: { items: [{ wrong: "shape" }] } })
          : Response.json({ data: { count: 1, ready: true } });
      }) as typeof globalThis.fetch,
    });
    await expect(executeCompiledWorkflowRead(
      projectionDrift,
      profile,
      document(),
      "dashboard",
      compiled(),
    )).rejects.toMatchObject({
      errorCode: "workflow_projection_failed",
    });

    const oversized = compiled();
    oversized.phases = [{
      id: "one",
      steps: [{
        namespace: "one.first",
        operationId: "dashboard.test.first",
        input: {},
        output: { selectors: [{ pointer: "/data/value", alias: "value" }] },
      }],
    }];
    const oversizedRuntime = createTestRuntime({
      directory,
      fetch: (async () => Response.json({ data: { value: "x".repeat(70 * 1024) } })) as typeof globalThis.fetch,
    });
    await expect(executeCompiledWorkflowRead(
      oversizedRuntime,
      profile,
      document(),
      "dashboard",
      oversized,
    )).resolves.toEqual(workflowReadUnavailable());
  });
});
