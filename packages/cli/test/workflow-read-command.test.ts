import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { indexOperations } from "../src/openapi.js";
import { runProgram } from "../src/program.js";
import type { OpenApiDocument } from "../src/types.js";
import { createTestRuntime, validToken } from "./helpers.js";

const DAILY_RESPONSES: Record<string, unknown> = {
  "dashboard.home.activity": {
    data: {
      dailyActivityData: [{
        date: "2026-08-18",
        orders: 4,
        revenue: 9_200,
        newCustomers: 2,
        buyerEmail: "must-not-escape@example.com",
      }],
    },
  },
  "dashboard.settings.currency_get": {
    data: { currencyCode: "BDT", currencySymbol: "৳", providerSecret: "must-not-escape" },
  },
  "dashboard.orders.list": {
    data: {
      orders: [],
      pagination: { page: 1, limit: 10, total: 0, totalPages: 0 },
    },
  },
  "dashboard.inventory_alerts.list": { data: { alerts: [] } },
  "dashboard.checkout.readiness_get": {
    data: {
      ready: true,
      hasActiveShippingMethod: true,
      hasActiveDeliveryHierarchy: true,
      customerSignInRequired: false,
      hasUsableCustomerSignIn: true,
      issues: [],
    },
  },
  "dashboard.payments.methods_get": {
    data: {
      enabledMethods: ["cod"],
      activeMethods: ["cod"],
      defaultMethod: "cod",
      activeDefaultMethod: "cod",
      gatewayStatus: {
        stripe: { configured: false, usable: false, checkoutVisible: false },
        sslcommerz: { configured: false, usable: false, checkoutVisible: false },
        polar: { configured: false, usable: false, checkoutVisible: false },
        cod: { configured: true, usable: true, checkoutVisible: true },
      },
    },
  },
  "dashboard.shipping_methods.list": {
    data: {
      shippingMethods: [],
      pagination: { page: 1, limit: 100, total: 0, totalPages: 0 },
    },
  },
};

describe("CLI workflow read command", () => {
  let document: OpenApiDocument;
  let operationByPath: Map<string, string>;

  beforeAll(async () => {
    const path = fileURLToPath(new URL("../../api-client/openapi.json", import.meta.url));
    document = JSON.parse(await readFile(path, "utf8")) as OpenApiDocument;
    operationByPath = new Map(indexOperations(document)
      .filter((operation) => Object.hasOwn(DAILY_RESPONSES, operation.id))
      .map((operation) => [operation.path, operation.id]));
  });

  it("answers the reviewed daily snapshot with one contract load and seven projected reads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-workflow-command-"));
    let contractLoads = 0;
    let active = 0;
    let maxActive = 0;
    const operationCalls: string[] = [];
    const runtime = createTestRuntime({
      directory,
      env: {
        SCALIUS_SERVER: "https://api.example.test",
        SCALIUS_TOKEN: validToken(),
      },
      fetch: (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v1/openapi.json") {
          contractLoads += 1;
          return Response.json(document);
        }
        const operationId = operationByPath.get(url.pathname);
        if (!operationId) return Response.json({ error: "unexpected request" }, { status: 404 });
        operationCalls.push(operationId);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, operationId.endsWith("activity") ? 4 : 1));
        active -= 1;
        return Response.json(DAILY_RESPONSES[operationId]);
      }) as typeof globalThis.fetch,
    });

    const exit = await runProgram(runtime, [
      "--output", "json",
      "workflow", "read",
      "dashboard.daily-operations-snapshot",
      "--surface", "dashboard",
    ]);

    expect(exit).toBe(0);
    expect(contractLoads).toBe(1);
    expect(operationCalls).toHaveLength(7);
    expect(new Set(operationCalls)).toEqual(new Set(Object.keys(DAILY_RESPONSES)));
    expect(maxActive).toBe(2);
    const result = JSON.parse(runtime.stdoutText()) as Record<string, unknown>;
    expect(result).toMatchObject({
      kind: "result",
      disposition: "execute",
      version: "3.0.0",
      workflowId: "operations.daily-snapshot.v1",
      outputs: {
        "activity.daily": {
          activity: [{ date: "2026-08-18", orders: 4, revenue: 9_200, newCustomers: 2 }],
        },
        "activity.currency": { currencyCode: "BDT", currencySymbol: "৳" },
      },
    });
    expect(JSON.stringify(result)).not.toContain("must-not-escape");
    expect(Buffer.byteLength(runtime.stdoutText())).toBeLessThan(64 * 1024);
  });

  it("returns a normal unavailable result without dispatch for an unsupported question", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-workflow-command-"));
    let operationCalls = 0;
    const runtime = createTestRuntime({
      directory,
      env: {
        SCALIUS_SERVER: "https://api.example.test",
        SCALIUS_TOKEN: validToken(),
      },
      fetch: (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v1/openapi.json") return Response.json(document);
        operationCalls += 1;
        return Response.json({});
      }) as typeof globalThis.fetch,
    });

    expect(await runProgram(runtime, [
      "--output", "json",
      "workflow", "read",
      "quantum aardvark unicycle",
      "--surface", "dashboard",
    ])).toBe(0);
    expect(JSON.parse(runtime.stdoutText())).toEqual({
      kind: "unavailable",
      disposition: "unavailable",
      classification: {
        code: "workflow_read_unavailable",
        reason: "The requested workflow read is unavailable.",
      },
    });
    expect(operationCalls).toBe(0);
  });
});
