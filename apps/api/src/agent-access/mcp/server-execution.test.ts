import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { AGENT_OPERATIONS } from "../../generated/agent-operations.gen";
import { AgentDispatchError, type AgentOperationResult } from "../dispatch";
import type { AgentPrincipal } from "../types";

const mocks = vi.hoisted(() => ({
  authorizeOperation: vi.fn(),
  dispatchAgentOperation: vi.fn(),
  resolvePrincipal: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock("agents/mcp/server", () => ({
  getMcpAuthContext: () => ({
    props: {
      grantId: `agr_${"a".repeat(20)}`,
      credentialId: `agc_${"b".repeat(20)}`,
      ownerUserId: "mcp-test-admin",
      resource: "dashboard",
      permissions: ["*"],
      riskCeiling: "security",
      audience: ["https://api.example.test/api/v1/mcp/dashboard"],
    },
  }),
}));

vi.mock("../backend", () => ({
  loadAgentAccessBackend: async () => ({
    authorizeOperation: mocks.authorizeOperation,
    resolvePrincipal: mocks.resolvePrincipal,
    writeAudit: mocks.writeAudit,
  }),
}));

vi.mock("../dispatch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../dispatch")>();
  return { ...actual, dispatchAgentOperation: mocks.dispatchAgentOperation };
});

import { writeAgentConfirmPolicy } from "./confirm";
import { AGENT_ERROR_MAX_BYTES } from "./errors";
import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { createAgentMcpServer, createAgentMcpServerForRequest, peekMcpMethod } from "./server";
import { selectPointers } from "./shape";

const principal: AgentPrincipal = {
  kind: "agent",
  grantId: `agr_${"a".repeat(20)}`,
  credentialId: `agc_${"b".repeat(20)}`,
  ownerUserId: "mcp-test-admin",
  isSuperAdmin: true,
  resource: "dashboard",
  grantKind: "oauth",
  preset: "full",
  permissions: new Set(["*"]),
  riskCeiling: "security",
  authorityRevision: 1,
  expiresAt: new Date("2099-01-01T00:00:00.000Z"),
};

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

function result(operationId: string, status: number, data: unknown, extra: Partial<AgentOperationResult> = {}): AgentOperationResult {
  return {
    operationId,
    status,
    ok: status >= 200 && status < 300,
    requestId: `request-${operationId}`,
    contentType: "application/json",
    data,
    ...extra,
  };
}

const parallelRead = AGENT_OPERATIONS.find((operation) =>
  operation.surface === "dashboard" && operation.exposure === "execute" && operation.risk === "read" &&
  operation.batch === "parallel" && operation.transport === "json")!;
const sequentialWrite = AGENT_OPERATIONS.find((operation) =>
  operation.surface === "dashboard" && operation.exposure === "execute" && operation.risk === "write" &&
  operation.batch === "sequential" && operation.transport === "json" && operation.idempotency === "none")!;
const destructive = AGENT_OPERATIONS.find((operation) => operation.operationId === "dashboard.analytics.trash")!;

type ToolHandler = (args: Record<string, unknown>, ctx?: unknown) => Promise<{
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<Record<string, unknown>>;
  resultType?: string;
  requestState?: string;
  inputRequests?: Record<string, unknown>;
}>;

describe("MCP surface v2 execution", () => {
  let sqlite: DatabaseSync;
  let env: Env;
  let tool: (name: string) => ToolHandler;

  beforeEach(() => {
    mocks.authorizeOperation.mockReset().mockResolvedValue(true);
    mocks.resolvePrincipal.mockReset().mockResolvedValue(principal);
    mocks.dispatchAgentOperation.mockReset();
    mocks.writeAudit.mockReset().mockResolvedValue(undefined);
    const harness = createSqliteD1Database();
    sqlite = harness.sqlite;
    env = {
      DB: harness.binding,
      PUBLIC_API_BASE_URL: "https://api.example.test",
      AGENT_TOKEN_PEPPER: "server-execution-test-pepper",
      RL_STANDARD: { limit: async () => ({ success: true }) },
    } as unknown as Env;
    const server = createAgentMcpServer({ surface: "dashboard", env, ctx: {} as ExecutionContext });
    tool = (name) => Reflect.get(server, "_registeredTools")[name].handler as ToolHandler;
  });

  afterEach(() => {
    sqlite.close();
    vi.restoreAllMocks();
  });

  it("ranks the reviewed plan first and inlines it without dispatching", async () => {
    const output = await tool("scalius_search")({ query: "What are today's booked sales and order count?" });
    expect(output.isError).toBeUndefined();
    const hits = output.structuredContent!.hits as Array<Record<string, unknown>>;
    expect(hits[0]).toMatchObject({
      id: "dashboard.sales-today",
      kind: "workflow",
      operationIds: ["dashboard.home.activity"],
    });
    expect(hits.length).toBeLessThanOrEqual(6);
    expect(bytes(output.structuredContent)).toBeLessThan(6 * 1024);
    for (const hit of hits) expect(String(hit.summary).length).toBeLessThanOrEqual(160);
    expect(mocks.dispatchAgentOperation).not.toHaveBeenCalled();
  });

  it("finds operations the resolver has no route for", async () => {
    const output = await tool("scalius_search")({ query: "gift card balance summary", limit: 3 });
    const hits = output.structuredContent!.hits as Array<{ id: string; kind: string }>;
    expect(hits.some((hit) => hit.kind === "operation" && hit.id.startsWith("dashboard.gift_cards."))).toBe(true);
    expect(hits.length).toBeLessThanOrEqual(3);
  });

  it("describes compactly with an example input, never larger than the full schema", async () => {
    const output = await tool("scalius_describe")({ ids: ["dashboard.products.create", "dashboard.orders.refund", "dashboard.nope"] });
    const operations = output.structuredContent!.operations as Array<Record<string, unknown>>;
    expect(operations[0]).toMatchObject({ operationId: "dashboard.products.create", risk: "write", example: { body: expect.any(Object) } });
    expect(operations[1]).toMatchObject({
      operationId: "dashboard.orders.refund",
      risk: "financial",
      dryRun: "none",
      rules: expect.arrayContaining([expect.stringContaining("confirmToken")]),
      inputs: { path: ["id!:string"] },
    });
    expect(operations[2]).toMatchObject({ operationId: "dashboard.nope", error: { code: "operation_not_found" } });
    const full = await tool("scalius_describe")({ ids: ["dashboard.products.create"], detail: "full" });
    expect(bytes(operations[0])).toBeLessThanOrEqual(bytes((full.structuredContent!.operations as unknown[])[0]));
    expect(bytes(operations[0])).toBeLessThanOrEqual(8 * 1024);
  });

  it("answers a reviewed daily data workflow in one projected call", async () => {
    mocks.dispatchAgentOperation.mockImplementation(async ({ operation }) => result(operation.operationId, 200, {
      data: operation.operationId === "dashboard.settings.currency_get"
        ? { currencyCode: "BDT", currencySymbol: "৳", secret: "must-not-escape" }
        : operation.operationId === "dashboard.home.activity"
          ? { dailyActivityData: [{ date: "2026-08-18", orders: 4, revenue: 9_200, newCustomers: 2, buyerEmail: "x@example.com" }] }
          : operation.operationId === "dashboard.orders.payment_recovery_list"
            ? { orders: [], pagination: { page: 1, limit: 1, total: 3, totalPages: 3 } }
            : operation.operationId === "dashboard.checkout.readiness_get"
              ? { status: "ready", hasActiveShippingMethod: true, hasActiveDeliveryHierarchy: true, customerSignInRequired: false, hasUsableCustomerSignIn: true, issues: [] }
              : operation.operationId === "dashboard.payments.methods_get"
                ? { enabledMethods: ["cod"], activeMethods: ["cod"], defaultMethod: "cod", activeDefaultMethod: "cod", gatewayStatus: { stripe: { configured: false, usable: false, checkoutVisible: false }, sslcommerz: { configured: false, usable: false, checkoutVisible: false }, cod: { configured: true, usable: true, checkoutVisible: true } } }
                : operation.operationId === "dashboard.shipping_methods.list"
                  ? { zones: [], pickup: { revision: 0, rates: [] } }
                  : operation.operationId === "dashboard.inventory_alerts.list"
                    ? { alerts: [] }
                    : { orders: [], pagination: { page: 1, limit: 10, total: 0, totalPages: 0 } },
    }));
    const output = await tool("scalius_answer")({ question: "dashboard.daily-operations-snapshot" });
    expect(output.structuredContent).toMatchObject({
      ok: true,
      kind: "result",
      workflowId: "operations.daily-snapshot.v1",
      outputs: { "activity.currency": { currencyCode: "BDT", currencySymbol: "৳" } },
    });
    expect(JSON.stringify(output)).not.toContain("must-not-escape");
  });

  it("returns the top search hits inline when a question has no curated answer", async () => {
    const output = await tool("scalius_answer")({ question: "list gift cards" });
    expect(output.structuredContent).toMatchObject({ ok: true, kind: "unavailable" });
    expect((output.structuredContent!.hits as unknown[]).length).toBeLessThanOrEqual(3);
  });

  it("rejects cross-risk operations before dispatch with a hint naming the right tool", async () => {
    const read = await tool("scalius_read")({ operationId: sequentialWrite.operationId });
    expect(read).toMatchObject({ isError: true, structuredContent: { ok: false, error: { code: "operation_risk_mismatch", retryable: false, hint: expect.stringContaining("scalius_write") } } });
    const write = await tool("scalius_write")({ operationId: parallelRead.operationId });
    expect(write.structuredContent).toMatchObject({ error: { code: "operation_risk_mismatch" } });
    expect(mocks.dispatchAgentOperation).not.toHaveBeenCalled();
  });

  it("keeps a list within the 8 KB read budget and pages a cursor list by its own cursor", async () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({ id: `ord_${index}`, number: 1000 + index, customerName: "Rahim Uddin", note: "n".repeat(300), status: "pending" }));
    mocks.dispatchAgentOperation.mockImplementation(async ({ operation }) => {
      return result(operation.operationId, 200, { success: true, data: { orders: rows, nextCursor: "c2" } });
    });
    const first = await tool("scalius_read")({ operationId: "dashboard.resources.orders.list" });
    const value = first.structuredContent as { data: { orders: unknown[] }; meta: Record<string, unknown> };
    expect(bytes(value.data)).toBeLessThanOrEqual(8 * 1024);
    expect(value.meta).toMatchObject({ truncated: true, pageRows: 50, hasMore: true, nextCursor: "c2", hint: expect.stringContaining("select") });
    expect(value.data.orders.length).toBe(value.meta.returned);
    await tool("scalius_read")({ operationId: "dashboard.resources.orders.list", cursor: value.meta.nextCursor });
    expect(mocks.dispatchAgentOperation.mock.calls[1]![0].input.query).toMatchObject({ cursor: "c2" });
    await tool("scalius_read")({ operationId: "dashboard.resources.orders.list", limit: 5 });
    expect(mocks.dispatchAgentOperation.mock.calls[2]![0].input.query.limit).toBe(5);
  });

  it("returns only the selected fields, within the projected bytes", async () => {
    const page = {
      orders: Array.from({ length: 30 }, (_, index) => ({ id: `ord_${index}`, number: index, customerName: "Karim", items: [{ sku: "A", note: "x".repeat(200) }] })),
      pagination: { page: 1, limit: 30, total: 30, totalPages: 1 },
    };
    mocks.dispatchAgentOperation.mockResolvedValue(result("dashboard.orders.list", 200, { success: true, data: page }));
    const select = ["/orders/*/id", "/orders/*/number", "/pagination/total"];
    const output = await tool("scalius_read")({ operationId: "dashboard.orders.list", select });
    const projected = selectPointers(page, select);
    const value = output.structuredContent as { data: unknown; meta: Record<string, unknown> };
    expect(value.data).toEqual(projected);
    expect(bytes(value.data)).toBeLessThanOrEqual(bytes(projected));
    expect(value.data).toMatchObject({ orders: expect.arrayContaining([{ id: "ord_0", number: 0 }]), pagination: { total: 30 } });
    // A page-numbered list carries its own pagination; the tool reports no cursor for it.
    expect(value.meta).not.toHaveProperty("nextCursor");
    expect(value.meta).not.toHaveProperty("truncated");
  });

  it("returns read steps in order within the two-lane bound and resolves $step references", async () => {
    const releases = new Map<string, () => void>();
    const inputs = new Map<string, unknown>();
    let active = 0;
    let maxActive = 0;
    mocks.dispatchAgentOperation.mockImplementation(async ({ operation, input }) => {
      const label = String(input.query?.label ?? "");
      inputs.set(label, input);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.set(label, resolve));
      active -= 1;
      return result(operation.operationId, 200, { success: true, data: { label } });
    });
    const pending = tool("scalius_read")({
      steps: [
        { id: "first", operationId: parallelRead.operationId, input: { query: { label: "first" } } },
        { id: "second", operationId: parallelRead.operationId, input: { query: { label: "second" } } },
        { id: "third", operationId: parallelRead.operationId, input: { query: { label: "third", dependency: { $step: "first", pointer: "/data/label" } } } },
      ],
    });
    await vi.waitFor(() => expect(releases.size).toBe(2));
    expect(mocks.dispatchAgentOperation).toHaveBeenCalledTimes(2);
    releases.get("second")!();
    releases.get("first")!();
    await vi.waitFor(() => expect(releases.has("third")).toBe(true));
    releases.get("third")!();
    const output = await pending;
    const steps = (output.structuredContent as { steps: Array<{ id: string; data: { label: string } }> }).steps;
    expect(steps.map((step) => step.id)).toEqual(["first", "second", "third"]);
    expect(steps.map((step) => step.data.label)).toEqual(["first", "second", "third"]);
    expect(inputs.get("third")).toMatchObject({ query: { dependency: "first" } });
    expect(maxActive).toBe(2);
  });

  it("runs write steps in order, resolves earlier steps and stops on the first failure", async () => {
    const bodies: unknown[] = [];
    mocks.dispatchAgentOperation.mockImplementation(async ({ operation, input }) => {
      bodies.push(input.body);
      return bodies.length === 1
        ? result(operation.operationId, 200, { success: true, data: { value: "resolved-value" } })
        : result(operation.operationId, 409, { success: false, error: { code: "CONFLICT", message: "Conflict" } });
    });
    const output = await tool("scalius_write")({
      steps: [
        { id: "create", operationId: sequentialWrite.operationId, input: { body: { value: "initial" } } },
        { id: "update", operationId: sequentialWrite.operationId, input: { body: { $step: "create", pointer: "/data/value" } } },
        { id: "never", operationId: sequentialWrite.operationId, input: { body: { value: "must-not-run" } } },
      ],
    });
    const value = output.structuredContent as { ok: boolean; steps: Array<{ id: string; ok: boolean; error?: Record<string, unknown> }> };
    expect(value.ok).toBe(false);
    expect(value.steps.map((step) => [step.id, step.ok])).toEqual([["create", true], ["update", false]]);
    expect(value.steps[1]!.error).toMatchObject({ code: "CONFLICT", status: 409, current: null });
    expect(bodies).toEqual([{ value: "initial" }, "resolved-value"]);
  });

  it("preflights every write step before the first mutation", async () => {
    mocks.authorizeOperation.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const output = await tool("scalius_write")({
      steps: [
        { id: "allowed", operationId: sequentialWrite.operationId },
        { id: "denied", operationId: sequentialWrite.operationId },
      ],
    });
    expect(output.structuredContent).toMatchObject({ ok: false, error: { code: "operation_not_found" } });
    expect(mocks.dispatchAgentOperation).not.toHaveBeenCalled();
  });

  describe("error envelope over seeded failure kinds", () => {
    const routeError = (status: number, code: string, details?: unknown, extra: Partial<AgentOperationResult> = {}) =>
      async () => { mocks.dispatchAgentOperation.mockResolvedValue(result(sequentialWrite.operationId, status, { success: false, error: { code, message: `${code} happened`, details } }, extra)); };
    const thrown = (error: AgentDispatchError) => async () => { mocks.dispatchAgentOperation.mockRejectedValue(error); };
    const kinds: Array<[string, () => Promise<void>, Record<string, unknown>]> = [
      ["inactive grant", async () => { mocks.resolvePrincipal.mockResolvedValue(null); }, { code: "unauthorized", status: 401, retryable: false }],
      ["unauthorized operation", async () => { mocks.authorizeOperation.mockResolvedValue(false); }, { code: "operation_not_found", status: 404 }],
      ["route forbidden", routeError(403, "FORBIDDEN"), { code: "FORBIDDEN", status: 403, retryable: false }],
      ["missing resource", routeError(404, "NOT_FOUND"), { code: "NOT_FOUND", status: 404, retryable: false }],
      ["stale revision", routeError(409, "PRODUCT_REVISION_CONFLICT", { expectedRevision: 7, currentRevision: 9 }), { code: "PRODUCT_REVISION_CONFLICT", status: 409, retryable: true, current: { revision: 9 } }],
      ["idempotency in progress", routeError(409, "idempotency_in_progress"), { code: "idempotency_in_progress", status: 409, retryable: true, retryAfterMs: 2000, current: null }],
      ["state conflict", routeError(409, "CONFLICT"), { code: "CONFLICT", status: 409, retryable: false, current: null }],
      ["validation", routeError(400, "VALIDATION_ERROR", { issues: [{ path: ["name"], message: "Required", expected: "string", received: "undefined" }] }), { code: "VALIDATION_ERROR", status: 400, field: "body.name" }],
      ["reused idempotency key", routeError(422, "idempotency_key_reused"), { code: "idempotency_key_reused", status: 422, field: "idempotencyKey" }],
      ["route rate limit", routeError(429, "RATE_LIMIT", { retryAfterSeconds: 30 }, { retryAfterMs: 30_000 }), { code: "RATE_LIMIT", status: 429, retryable: true, retryAfterMs: 30_000 }],
      ["store busy", routeError(503, "SERVICE_UNAVAILABLE"), { code: "SERVICE_UNAVAILABLE", status: 503, retryable: true }],
      ["unknown body property", thrown(new AgentDispatchError("unknown_body_property", "Unknown body property 'colour'. Allowed properties: name.")), { code: "unknown_body_property", status: 400, field: "body.colour" }],
      ["oversized body", thrown(new AgentDispatchError("body_too_large", "Operation body exceeds the 1 MiB limit", 413)), { code: "body_too_large", status: 413, retryable: false }],
      ["dispatch unavailable", thrown(new AgentDispatchError("operation_dispatch_failed", "Operation dispatch is temporarily unavailable", 502)), { code: "operation_dispatch_failed", status: 502, retryable: true }],
      ["grant rate limit", thrown(new AgentDispatchError("rate_limited", "Operation rate limit exceeded", 429)), { code: "rate_limited", status: 429, retryable: true, retryAfterMs: 60_000 }],
    ];

    it.each(kinds)("%s", async (_label, seed, expected) => {
      await seed();
      const output = await tool("scalius_write")({ operationId: sequentialWrite.operationId, input: { body: { name: "x" } } });
      expect(output.isError).toBe(true);
      const error = (output.structuredContent as { error: Record<string, unknown> }).error;
      expect(error).toMatchObject(expected);
      expect(typeof error.code).toBe("string");
      expect(typeof error.retryable).toBe("boolean");
      expect(String(error.hint).length).toBeGreaterThan(10);
      if (error.status === 409) expect(error).toHaveProperty("current");
      expect(bytes(output.structuredContent)).toBeLessThanOrEqual(AGENT_ERROR_MAX_BYTES);
      expect(JSON.parse(String(output.content![0]!.text))).toEqual(output.structuredContent);
    });

    it("bounds an error with a huge route message to 600 bytes", async () => {
      await routeError(409, "CONFLICT", { currentRevision: 3, currentState: "x".repeat(5000) })();
      mocks.dispatchAgentOperation.mockResolvedValue(result(sequentialWrite.operationId, 409, { success: false, error: { code: "CATEGORY_REVISION_CONFLICT", message: "বাংলা ".repeat(400), details: { currentRevision: 3 } } }));
      const output = await tool("scalius_write")({ operationId: sequentialWrite.operationId });
      expect(bytes(output.structuredContent)).toBeLessThanOrEqual(AGENT_ERROR_MAX_BYTES);
      expect((output.structuredContent as { error: Record<string, unknown> }).error).toMatchObject({ current: { revision: 3 }, retryable: true });
    });
  });

  describe("confirmation of destructive and financial writes", () => {
    const refund = { operationId: "dashboard.orders.refund", input: { path: { id: "ord_1042" }, body: { amount: 500, reason: "damaged" } } };

    it("refuses without a confirmation, audits it, then runs exactly once with the token", async () => {
      mocks.dispatchAgentOperation.mockImplementation(async ({ operation }) => result(operation.operationId, 200, { success: true, data: { amount: 500 } }));
      const refused = await tool("scalius_write")(refund);
      expect(refused.isError).toBe(true);
      const value = refused.structuredContent as { error: Record<string, unknown>; confirmation: { summary: string; confirmToken: string; expiresAt: string } };
      expect(value.error).toMatchObject({ code: "confirmation_required", retryable: true });
      expect(value.confirmation.summary).toBe("Process order refund: id=ord_1042, amount=500, reason=damaged");
      expect(value.confirmation.confirmToken).toMatch(/^sct_/);
      expect(mocks.dispatchAgentOperation).not.toHaveBeenCalled();
      expect(mocks.writeAudit).toHaveBeenCalledWith(expect.objectContaining({
        operationId: "dashboard.orders.refund",
        outcome: "denied",
        errorClass: "confirmation_required",
      }), env);

      const confirmed = await tool("scalius_write")({ ...refund, confirmToken: value.confirmation.confirmToken });
      expect(confirmed.isError).toBeUndefined();
      expect(confirmed.structuredContent).toMatchObject({ ok: true, data: { amount: 500 } });
      expect(mocks.dispatchAgentOperation).toHaveBeenCalledTimes(1);
      expect(mocks.dispatchAgentOperation.mock.calls[0]![0]).toMatchObject({ confirmedBy: "token" });

      const replay = await tool("scalius_write")({ ...refund, confirmToken: value.confirmation.confirmToken });
      expect(replay.structuredContent).toMatchObject({ error: { code: "confirm_token_used", status: 409, current: null } });
      expect(mocks.dispatchAgentOperation).toHaveBeenCalledTimes(1);
    });

    it("binds the token to the exact input", async () => {
      const dryRun = await tool("scalius_write")({ ...refund, dryRun: true });
      expect(dryRun.structuredContent).toMatchObject({ ok: true, dryRun: true, written: false, operationId: "dashboard.orders.refund", support: "none", validated: true, verifyWith: "dashboard.orders.get" });
      const token = (dryRun.structuredContent as { confirmation: { confirmToken: string } }).confirmation.confirmToken;
      const changed = await tool("scalius_write")({ ...refund, input: { ...refund.input, body: { amount: 5000, reason: "damaged" } }, confirmToken: token });
      expect(changed.structuredContent).toMatchObject({ error: { code: "confirm_token_invalid" } });
      expect(mocks.dispatchAgentOperation).not.toHaveBeenCalled();
    });

    it("lets a grant with confirmation turned off run without a token", async () => {
      await writeAgentConfirmPolicy(env, principal.grantId, "none");
      mocks.dispatchAgentOperation.mockResolvedValue(result(destructive.operationId, 200, { success: true, data: { trashed: true } }));
      const output = await tool("scalius_write")({ operationId: destructive.operationId, input: { path: { id: "ana_1" } } });
      expect(output.structuredContent).toMatchObject({ ok: true, data: { trashed: true } });
      expect(mocks.dispatchAgentOperation.mock.calls[0]![0]).not.toHaveProperty("confirmedBy");
    });

    it("asks a 2026-07-28 client's native dialog and runs once after it is accepted", async () => {
      mocks.dispatchAgentOperation.mockResolvedValue(result("dashboard.orders.refund", 200, { success: true, data: { amount: 500 } }));
      const envelope = { "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } } };
      const asked = await tool("scalius_write")(refund, { mcpReq: { envelope, requestState: () => undefined } });
      expect(asked).toMatchObject({ resultType: "input_required", inputRequests: { confirm: { method: "elicitation/create" } } });
      expect(mocks.dispatchAgentOperation).not.toHaveBeenCalled();
      const accepted = await tool("scalius_write")(refund, {
        mcpReq: {
          envelope,
          requestState: () => asked.requestState,
          inputResponses: { confirm: { action: "accept", content: { confirm: true } } },
        },
      });
      expect(accepted.structuredContent).toMatchObject({ ok: true });
      expect(mocks.dispatchAgentOperation.mock.calls[0]![0]).toMatchObject({ confirmedBy: "elicitation" });
      const declined = await tool("scalius_write")(refund, {
        mcpReq: { envelope, requestState: () => asked.requestState, inputResponses: { confirm: { action: "decline" } } },
      });
      expect(declined.structuredContent).toMatchObject({ error: { code: "confirmation_declined" } });
      expect(mocks.dispatchAgentOperation).toHaveBeenCalledTimes(1);
    });

    it("confirms a batch with gated steps as one unit", async () => {
      mocks.dispatchAgentOperation.mockImplementation(async ({ operation }) => result(operation.operationId, 200, { success: true, data: {} }));
      const steps = [
        { id: "note", operationId: sequentialWrite.operationId, input: { body: { value: 1 } } },
        { id: "trash", operationId: destructive.operationId, input: { path: { id: "ana_1" } } },
      ];
      const refused = await tool("scalius_write")({ steps });
      const token = (refused.structuredContent as { confirmation: { confirmToken: string; summary: string } }).confirmation;
      expect(token.summary).toContain("id=ana_1");
      expect(mocks.dispatchAgentOperation).not.toHaveBeenCalled();
      const confirmed = await tool("scalius_write")({ steps, confirmToken: token.confirmToken });
      expect(confirmed.structuredContent).toMatchObject({ ok: true });
      expect(mocks.dispatchAgentOperation.mock.calls.map(([options]) => options.confirmedBy)).toEqual([undefined, "token"]);
    });
  });

  it("validates a dry run's input without sending it", async () => {
    const output = await tool("scalius_write")({ operationId: sequentialWrite.operationId, input: { path: { nope: "x" } }, dryRun: true });
    expect(output.structuredContent).toMatchObject({ ok: false, error: { code: "unknown_path_parameter", field: "path.nope" } });
    expect(mocks.dispatchAgentOperation).not.toHaveBeenCalled();
  });

  describe("store context in the handshake", () => {
    async function initialize(method: string | null) {
      const server = await createAgentMcpServerForRequest({ surface: "dashboard", env, ctx: {} as ExecutionContext }, method);
      const [client, transport] = InMemoryTransport.createLinkedPair();
      const response = new Promise<{ result: { instructions: string } }>((resolve) => {
        client.onmessage = (message) => resolve(message as never);
      });
      await client.start();
      await server.connect(transport);
      await client.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "context-test", version: "1" } },
      } as JSONRPCMessage);
      const { result } = await response;
      await client.close();
      await server.close();
      return result.instructions;
    }

    it("adds the store name, currency, markets and what is not set up, read through the grant", async () => {
      mocks.dispatchAgentOperation.mockImplementation(async ({ operation }) => result(operation.operationId, 200, {
        success: true,
        data: operation.operationId === "dashboard.settings.store_setup_get"
          ? { needed: false, done: "has_orders", currencyLocked: true, current: { storeName: "Dhaka Panjabi House", countryCode: "BD", currencyCode: "BDT", locale: "bn", timeZone: "Asia/Dhaka", unitSystem: "metric", weightUnit: "kg" } }
          : operation.operationId === "dashboard.markets.list"
            ? { items: [{ name: "Bangladesh", status: "active", isBackup: true, currencyCode: "BDT", countries: ["BD"] }, { name: "Draft EU", status: "draft", currencyCode: "EUR", countries: ["DE"] }] }
            : { status: "incomplete", issues: [{ code: "no_shipping", message: "No active shipping method" }], hasActiveShippingMethod: false, hasActiveDeliveryHierarchy: true, customerSignInRequired: false, hasUsableCustomerSignIn: true },
      }));
      const instructions = await initialize("initialize");
      expect(instructions).toContain("Store: Dhaka Panjabi House · BDT · Asia/Dhaka · markets: Bangladesh (BDT) · checkout incomplete · not set up: No active shipping method.");
      expect(instructions).not.toContain("Draft EU");
      expect(new TextEncoder().encode(instructions).byteLength).toBeLessThanOrEqual(600);
      expect(mocks.dispatchAgentOperation.mock.calls.map(([options]) => options.operation.operationId).sort()).toEqual([
        "dashboard.checkout.readiness_get",
        "dashboard.markets.list",
        "dashboard.settings.store_setup_get",
      ]);
    });

    it("reports the currency's decimal places for the store resource", async () => {
      const { loadStoreContext } = await import("./context");
      const principalOf = (currencyCode: string) => {
        mocks.dispatchAgentOperation.mockImplementation(async ({ operation }) => result(operation.operationId, 200, {
          success: true,
          data: operation.operationId === "dashboard.settings.store_setup_get"
            ? { needed: false, current: { storeName: "Shop", currencyCode } }
            : { items: [] },
        }));
        return loadStoreContext({ surface: "dashboard", principal: {} as AgentPrincipal, env, ctx: {} as ExecutionContext });
      };
      expect(await principalOf("BDT")).toMatchObject({ currency: "BDT", decimals: 2 });
      expect(await principalOf("JPY")).toMatchObject({ currency: "JPY", decimals: 0 });
      expect(await principalOf("KWD")).toMatchObject({ currency: "KWD", decimals: 3 });
    });

    it("leaves out facts the grant cannot read and reads nothing for other methods", async () => {
      mocks.authorizeOperation.mockResolvedValue(false);
      expect(await initialize("initialize")).toBe((await initialize("tools/call")));
      mocks.authorizeOperation.mockResolvedValue(true);
      mocks.dispatchAgentOperation.mockReset();
      await initialize("tools/call");
      expect(mocks.dispatchAgentOperation).not.toHaveBeenCalled();
    });

    it("peeks the method from the header or a small handshake body only", async () => {
      const post = (body: string, headers: Record<string, string> = {}) => new Request("https://api.example.test/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": String(body.length), ...headers },
        body,
      });
      expect(await peekMcpMethod(post("{}", { "Mcp-Method": "server/discover" }))).toBe("server/discover");
      const handshake = post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
      expect(await peekMcpMethod(handshake)).toBe("initialize");
      expect(await handshake.json()).toMatchObject({ method: "initialize" });
      expect(await peekMcpMethod(post(JSON.stringify({ method: "tools/call", params: { x: "y".repeat(9000) } })))).toBeNull();
      expect(await peekMcpMethod(post("not json"))).toBeNull();
    });
  });
});
