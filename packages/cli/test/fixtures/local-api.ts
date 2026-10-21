import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer, createMcpHandler, fromJsonSchema, inputRequired } from "@modelcontextprotocol/server";

// A local Scalius API for CLI tests: CLI device pairing, the protected
// resource metadata, the OpenAPI contract, and a real MCP endpoint (the
// official SDK's `createMcpHandler`, serving 2026-07-28 and 2025 stateless
// traffic) whose five scalius_* tools answer like the S1 surface over a tiny
// in-memory store.

export interface RecordedRequest {
  method: string;
  path: string;
  body: string;
  headers: Record<string, string>;
  rpcMethod?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
}

export interface LocalApi {
  origin: string;
  token: string;
  requests: RecordedRequest[];
  state: {
    refunds: Array<{ input: unknown; idempotencyKey?: string }>;
    products: Array<{ input: unknown; idempotencyKey?: string }>;
    /** Approval requests the server sent (the merchant answers them by setting "approved"). */
    approvals: Map<string, "pending" | "approved" | "used">;
    /** Native dialogs the server asked a terminal client for. */
    dialogs: number;
    /** The grant's owner turned approval off: gated changes run directly. */
    approvalOff: boolean;
    failNextProductCreate: number;
    orders: Array<{ id: string; number: number }>;
    /** Every bulk write the server accepted (not dry runs): what it got, with the Idempotency-Key and confirm token. */
    bulkWrites: Array<{ operationId: string; input: Value; idempotencyKey?: string; approvalId?: string }>;
    /** Bulk dry runs the server saw. */
    bulkDryRuns: Array<{ operationId: string; input: Value }>;
    /** Times bulk_runs.get was read; the second read finds the run done. */
    bulkRunReads: number;
    /** The SKU codes each variants.lookup read asked for. */
    skuLookups: string[][];
    batchWrites: number;
    /** The `scalius://store` resource body (currency and, when the store reports them, its decimal places). */
    store: { name: string; currency: string; decimals?: number; timeZone: string };
  };
  close: () => Promise<void>;
}

export const LOCAL_TOKEN = `sc_cli_agc_${"L".repeat(20)}_${"T".repeat(43)}`;
export const PAGE_SIZE = 3;

function operation(id: string, method: string, risk: string, extra: Record<string, unknown> = {}) {
  return {
    [method]: {
      operationId: id,
      summary: id,
      parameters: [],
      responses: { "200": { description: "ok" } },
      ...extra,
      "x-scalius-agent": {
        surface: "dashboard",
        exposure: "execute",
        principals: ["admin"],
        risk,
        openWorld: false,
        idempotency: "none",
        revision: "none",
        batch: risk === "read" ? "parallel" : "sequential",
        transport: "json",
        maxRequestBytes: 1024 * 1024,
        ...((extra["x-scalius-agent"] as Record<string, unknown> | undefined) ?? {}),
      },
    },
  };
}

export function localSpec(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    paths: {
      "/api/v1/admin/orders": operation("dashboard.orders.list", "get", "read", {
        parameters: [
          { in: "query", name: "limit", schema: { type: "integer", maximum: 100 } },
          { in: "query", name: "page", schema: { type: "integer" } },
          { in: "query", name: "view", schema: { type: "string" } },
        ],
      }),
      "/api/v1/admin/orders/{id}/refund": operation("dashboard.orders.refund", "post", "financial", {
        summary: "Process order refund",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
        requestBody: { content: { "application/json": { schema: { type: "object" } } } },
      }),
      "/api/v1/admin/resources/variants/bulk-set-prices": operation("dashboard.resources.variants.bulk_set_prices", "post", "write", {
        summary: "Change many SKU prices at once",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        "x-scalius-agent": { idempotency: "supported", confirmation: "required" },
      }),
      "/api/v1/admin/resources/variants/bulk-set-stock": operation("dashboard.resources.variants.bulk_set_stock", "post", "write", {
        summary: "Set many SKUs' on-hand quantities",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        "x-scalius-agent": { idempotency: "supported" },
      }),
      "/api/v1/admin/resources/variants/lookup": operation("dashboard.resources.variants.lookup", "post", "read", {
        summary: "Find SKUs by their codes",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
      }),
      "/api/v1/admin/resources/customers/bulk-tag": operation("dashboard.resources.customers.bulk_tag", "post", "write", {
        summary: "Add or remove tags on many customers",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        "x-scalius-agent": { idempotency: "supported" },
      }),
      "/api/v1/admin/resources/bulk-runs/{id}": operation("dashboard.resources.bulk_runs.get", "get", "read", {
        summary: "Get a bulk run's progress",
        parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
      }),
      "/api/v1/admin/products": operation("dashboard.products.create", "post", "write", {
        summary: "Create a product",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        "x-scalius-agent": { idempotency: "required" },
      }),
    },
  };
}

export const DEFAULT_STORE = { name: "Demo Store", currency: "BDT", decimals: 2, timeZone: "Asia/Dhaka" };

/** The SKUs this store has: code (lower case) to id. */
const SKU_IDS: Record<string, string> = { "ts-red-m": "var_1", "ts-red-l": "var_2" };
const KNOWN_SKU_IDS = new Set(Object.values(SKU_IDS));

/** A stock run over the body's items: an id this store has changes, any other is not_found. */
function stockRun(body: Value, dryRun: boolean): Value {
  const items = Array.isArray(body.items) ? body.items as Array<{ variantId?: unknown }> : [];
  const failures = items.filter((item) => !KNOWN_SKU_IDS.has(String(item.variantId))).map((item) => ({ id: String(item.variantId), code: "not_found" }));
  return { id: dryRun ? null : "bulk_bbbb", kind: "variants.set_stock", status: dryRun ? "preview" : "done", dryRun, total: items.length, processed: items.length, changed: items.length - failures.length, unchanged: 0, failed: failures.length, sample: [], failures };
}

const ORDERS = Array.from({ length: 7 }, (_, index) => ({ id: `ord_${index + 1}`, number: 1040 + index }));

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== "string" || !cursor.startsWith("sc1.")) return 1;
  const parsed = JSON.parse(Buffer.from(cursor.slice(4), "base64url").toString("utf8")) as { page?: number };
  return parsed.page ?? 1;
}

function encodeCursor(page: number): string {
  return `sc1.${Buffer.from(JSON.stringify({ page })).toString("base64url")}`;
}

type Value = Record<string, unknown>;

function result(value: Value) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
}

function failure(error: Value, extra: Value = {}) {
  const value = { ok: false, error, ...extra };
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
}

const anyObject = fromJsonSchema<Value>({ type: "object" });

function buildMcpServer(api: LocalApi): McpServer {
  const server = new McpServer({ name: "scalius-dashboard", title: "Scalius dashboard", version: "2.0.0" }, {
    instructions: "Scalius tools: scalius_search a goal, scalius_describe ids, then scalius_read or scalius_write.",
  });
  server.registerTool("scalius_search", { description: "search", inputSchema: anyObject }, async (args) => result({
    ok: true,
    hits: [{ id: "dashboard.order-refund", kind: "workflow", title: `Refund (${String(args.query)})`, summary: "Refund an order", score: 0.9, operationIds: ["dashboard.orders.payments", "dashboard.orders.refund"] }],
  }));
  server.registerTool("scalius_describe", { description: "describe", inputSchema: anyObject }, async (args) => result({
    ok: true,
    operations: (args.ids as string[]).map((id) => ({ operationId: id, purpose: id, risk: id.endsWith("refund") ? "financial" : "read", inputs: {}, example: {} })),
  }));
  server.registerTool("scalius_answer", { description: "answer", inputSchema: anyObject }, async () => result({
    ok: true,
    kind: "result",
    workflowId: "operations.sales-today.v1",
    outputs: { sales: { orders: 4, gross: "6000.00" } },
  }));
  server.registerTool("scalius_read", { description: "read", inputSchema: anyObject }, async (args) => {
    if (args.operationId === "dashboard.resources.bulk_runs.get") {
      const id = ((args.input as Value | undefined)?.path as Value | undefined)?.id;
      api.state.bulkRunReads += 1;
      const done = api.state.bulkRunReads >= 2;
      return result({
        ok: true,
        data: { run: { id, kind: "variants.set_prices", status: done ? "done" : "running", dryRun: false, total: 300, processed: done ? 300 : 90, changed: done ? 298 : 90, unchanged: 0, failed: done ? 2 : 0, sample: [], failures: [] } },
        meta: { operationId: args.operationId, status: 200 },
      });
    }
    if (args.operationId === "dashboard.resources.variants.lookup") {
      const skus = (((args.input as Value | undefined)?.body as Value | undefined)?.skus ?? []) as string[];
      api.state.skuLookups.push(skus);
      const variants = skus.flatMap((sku) => {
        const id = SKU_IDS[sku.trim().toLowerCase()];
        return id ? [{ id, productId: "prod_1", sku: sku.trim().toUpperCase(), trackInventory: true, onHand: 3, levels: [], stockVersion: 1, updatedAt: "2026-10-22T00:00:00.000Z" }] : [];
      });
      return result({ ok: true, data: { variants }, meta: { operationId: args.operationId, status: 200 } });
    }
    if (args.operationId !== "dashboard.orders.list") {
      return failure({ code: "operation_not_found", status: 404, message: "Operation is unavailable or not authorized", retryable: false, hint: "scalius_search" });
    }
    const limit = typeof args.limit === "number" ? args.limit : PAGE_SIZE;
    const page = decodeCursor(args.cursor);
    const totalPages = Math.ceil(ORDERS.length / limit);
    const items = ORDERS.slice((page - 1) * limit, page * limit);
    const hasMore = page < totalPages;
    return result({
      ok: true,
      data: { items, pagination: { page, totalPages, total: ORDERS.length } },
      meta: { operationId: args.operationId, requestId: `req_${page}`, status: 200, total: ORDERS.length, hasMore, nextCursor: hasMore ? encodeCursor(page + 1) : null },
    });
  });
  server.registerTool("scalius_write", { description: "write", inputSchema: anyObject }, async (args, ctx) => {
    const bulkRuns = new Set(["dashboard.resources.variants.bulk_set_prices", "dashboard.resources.variants.bulk_set_stock", "dashboard.resources.customers.bulk_tag"]);
    const steps = Array.isArray(args.steps) ? args.steps as Array<{ id: string; operationId: string; input?: Value }> : undefined;
    const gated = args.operationId === "dashboard.orders.refund" || args.operationId === "dashboard.resources.variants.bulk_set_prices"
      || (steps?.some((step) => step.operationId === "dashboard.orders.refund") ?? false);
    const confirmation = { summary: "Process order refund: id=ord_1, amount=500" };
    // A person approves a gated change: a terminal client's dialog, or the dashboard link.
    const request = (ctx as { mcpReq?: { envelope?: Value; inputResponses?: Record<string, unknown>; requestState?: () => unknown } }).mcpReq;
    const gate = (summary: string) => {
      if (api.state.approvalOff) return null;
      const capabilities = request?.envelope?.["io.modelcontextprotocol/clientCapabilities"] as Value | undefined;
      if (capabilities?.elicitation && typeof args.approvalId !== "string") {
        const answer = request?.inputResponses?.confirm as { action?: string; content?: { confirm?: unknown } } | undefined;
        if (request?.requestState?.() === "dialog-state" && answer?.action === "accept" && answer.content?.confirm === true) return null;
        if (request?.inputResponses) return failure({ code: "confirmation_declined", status: 403, message: "The merchant did not approve this change.", retryable: false, hint: "Do not retry" });
        api.state.dialogs += 1;
        return inputRequired({
          inputRequests: { confirm: inputRequired.elicit({ message: `Approve: ${summary}`, requestedSchema: { type: "object", properties: { confirm: { type: "boolean" } }, required: ["confirm"] } }) },
          requestState: "dialog-state",
        });
      }
      const pending = (approvalId: string) => failure(
        { code: "confirmation_required", status: 428, message: "This change needs a person's approval before it runs.", retryable: true, hint: "Give the merchant the link" },
        { confirmation: { summary, approvalId, approvalUrl: `${api.origin}/admin/settings/agent-access/approve/${approvalId}`, expiresAt: "2026-08-13T00:10:00.000Z" } },
      );
      if (typeof args.approvalId !== "string") {
        const approvalId = `abh_${String(api.state.approvals.size + 1).padStart(20, "0")}`;
        api.state.approvals.set(approvalId, "pending");
        return pending(approvalId);
      }
      const status = api.state.approvals.get(args.approvalId);
      if (status === "pending") return pending(args.approvalId);
      if (status !== "approved") return failure({ code: "approval_invalid", status: 400, message: "This approval is not valid", retryable: false, hint: "Repeat without it" });
      api.state.approvals.set(args.approvalId, "used");
      return null;
    };
    if (args.dryRun === true) {
      if (typeof args.operationId === "string" && bulkRuns.has(args.operationId)) {
        const body = (args.input as Value | undefined)?.body as Value | undefined;
        api.state.bulkDryRuns.push({ operationId: args.operationId, input: body ?? {} });
        if (args.operationId === "dashboard.resources.variants.bulk_set_stock") {
          // The server's native preview, shaped as scalius_write's dry run carries it.
          return result({ ok: true, dryRun: true, written: false, operationId: args.operationId, support: "native", preview: { data: { run: stockRun(body ?? {}, true) } } });
        }
        return result({ ok: true, dryRun: true, written: false, id: null, status: "preview", total: 2, changed: 2, ...(gated ? { confirmation: { ...confirmation, approvalRequired: true } } : {}) });
      }
      return result({ ok: true, dryRun: true, written: false, operationId: args.operationId, support: "none", validated: true, ...(gated ? { confirmation: { ...confirmation, approvalRequired: true } } : {}) });
    }
    const input = args.input as Value | undefined;
    if (steps && gated) {
      const refused = gate("Process order refund: id=ord_1, amount=500");
      if (refused) return refused;
      api.state.batchWrites += 1;
      return result({ ok: true, steps: steps.map((step) => ({ id: step.id, ok: true, data: { operationId: step.operationId } })) });
    }
    if (typeof args.operationId === "string" && bulkRuns.has(args.operationId)) {
      if (gated) {
        const refused = gate("Change the price of 2 SKUs by 5%");
        if (refused) return refused;
      }
      const body = (input?.body ?? {}) as Value;
      // One run per Idempotency-Key: a repeat gets the first run back.
      const replayed = typeof args.idempotencyKey === "string" && api.state.bulkWrites.some((write) => write.idempotencyKey === args.idempotencyKey);
      if (!replayed) {
        api.state.bulkWrites.push({
          operationId: args.operationId,
          input: body,
          ...(typeof args.idempotencyKey === "string" ? { idempotencyKey: args.idempotencyKey } : {}),
          ...(typeof args.approvalId === "string" ? { approvalId: args.approvalId } : {}),
        });
      }
      // A filter selects an unknown number of SKUs: this store's run is over 250, so it runs on after the response (202).
      const large = body.filter !== undefined;
      if (args.operationId === "dashboard.resources.variants.bulk_set_stock") {
        return result({ ok: true, data: { run: stockRun(body, false) }, meta: { operationId: args.operationId, requestId: "req_bulk", status: 200 } });
      }
      return result({
        ok: true,
        data: { run: { id: large ? "bulk_aaaa" : "bulk_bbbb", kind: "variants.set_prices", status: large ? "running" : "done", dryRun: false, total: large ? 300 : 2, processed: large ? 90 : 2, changed: large ? 90 : 2, unchanged: 0, failed: 0, sample: [], failures: [] } },
        meta: { operationId: args.operationId, requestId: "req_bulk", status: large ? 202 : 200, ...(replayed ? { replayed: true } : {}), ...(typeof args.idempotencyKey === "string" ? { idempotencyKey: args.idempotencyKey } : {}) },
      });
    }
    if (gated) {
      const refused = gate(confirmation.summary);
      if (refused) return refused;
      api.state.refunds.push({ input });
      return result({ ok: true, data: { refundId: "rfd_1", amount: 500 }, meta: { operationId: args.operationId, requestId: "req_refund", status: 200 } });
    }
    if (args.operationId === "dashboard.products.create") {
      const idempotencyKey = typeof args.idempotencyKey === "string" ? args.idempotencyKey : undefined;
      api.state.products.push({ input, idempotencyKey });
      if (api.state.failNextProductCreate > 0) {
        api.state.failNextProductCreate -= 1;
        return failure({ code: "temporarily_unavailable", status: 503, message: "Try again", retryable: true, hint: "Retry", retryAfterMs: 1 });
      }
      return result({ ok: true, data: { id: "prod_1" }, meta: { operationId: args.operationId, requestId: "req_product", status: 201, idempotencyKey } });
    }
    return failure({ code: "operation_not_found", status: 404, message: "Operation is unavailable", retryable: false, hint: "scalius_search" });
  });
  server.registerResource("store", "scalius://store", { mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(api.state.store) }],
  }));
  return server;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startLocalApi(): Promise<LocalApi> {
  const api = {
    origin: "",
    token: LOCAL_TOKEN,
    requests: [] as RecordedRequest[],
    state: { refunds: [], products: [], approvals: new Map(), dialogs: 0, approvalOff: false, failNextProductCreate: 0, orders: ORDERS, bulkWrites: [], bulkDryRuns: [], bulkRunReads: 0, skuLookups: [], batchWrites: 0, store: { ...DEFAULT_STORE } },
    close: async () => undefined,
  } as LocalApi;
  const handler = createMcpHandler(() => buildMcpServer(api));
  const server: Server = createServer(async (request, response) => {
    const body = await readBody(request);
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, String(value)]));
    const recorded: RecordedRequest = { method: request.method ?? "GET", path, body, headers };
    if (body && path.startsWith("/api/v1/mcp/")) {
      try {
        const message = JSON.parse(body) as { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
        recorded.rpcMethod = message.method;
        if (message.method === "tools/call") {
          recorded.tool = message.params?.name;
          recorded.arguments = message.params?.arguments;
        }
      } catch {
        // Recorded as is.
      }
    }
    api.requests.push(recorded);
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (path === "/api/v1/agent-auth/device/start") {
      return json(200, { deviceCode: "dev_local", userCode: "ABCD-EFGH", verificationUri: `${api.origin}/connect`, intervalSeconds: 1, expiresInSeconds: 600, resource: "dashboard" });
    }
    if (path === "/api/v1/agent-auth/device/token") {
      return json(200, { status: "approved", token: api.token, credentialId: `agc_${"L".repeat(20)}`, expiresAt: "2026-11-01T00:00:00.000Z", resource: "dashboard" });
    }
    if (path === "/api/v1/agent-auth/device/ack") return json(200, { ok: true });
    if (path === "/.well-known/oauth-protected-resource/api/v1/mcp/dashboard") {
      return json(200, { resource: `${api.origin}/api/v1/mcp/dashboard`, authorization_servers: [api.origin] });
    }
    if (path === "/api/v1/openapi.json") return json(200, localSpec());
    if (path === "/api/v1/mcp/dashboard") {
      if (request.headers.authorization !== `Bearer ${api.token}`) return json(401, { error: "unauthorized" });
      const forwarded = await handler.fetch(new Request(`${api.origin}${request.url}`, {
        method: request.method,
        headers: Object.entries(request.headers).flatMap(([key, value]) => typeof value === "string" ? [[key, value] as [string, string]] : []),
        ...(body ? { body } : {}),
      }));
      response.writeHead(forwarded.status, Object.fromEntries(forwarded.headers.entries()));
      if (!forwarded.body) {
        response.end();
        return;
      }
      // Stream as the SDK writes it: a subscription stream stays open.
      const reader = forwarded.body.getReader();
      response.on("close", () => void reader.cancel().catch(() => undefined));
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          response.write(Buffer.from(chunk.value));
        }
      } catch {
        // The client went away.
      }
      response.end();
      return;
    }
    json(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  api.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  api.close = () => new Promise((resolve) => server.close(() => resolve()));
  return api;
}
