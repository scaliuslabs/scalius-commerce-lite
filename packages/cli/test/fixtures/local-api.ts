import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer, createMcpHandler, fromJsonSchema } from "@modelcontextprotocol/server";

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
    usedTokens: Set<string>;
    failNextProductCreate: number;
    orders: Array<{ id: string; number: number }>;
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
      "/api/v1/admin/products": operation("dashboard.products.create", "post", "write", {
        summary: "Create a product",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        "x-scalius-agent": { idempotency: "required" },
      }),
    },
  };
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
  server.registerTool("scalius_write", { description: "write", inputSchema: anyObject }, async (args) => {
    const gated = args.operationId === "dashboard.orders.refund";
    const confirmation = { summary: "Process order refund: id=ord_1, amount=500", confirmToken: `sct_${api.state.usedTokens.size + 1}`, expiresAt: "2026-08-13T00:10:00.000Z" };
    if (args.dryRun === true) {
      return result({ ok: true, dryRun: true, written: false, operationId: args.operationId, support: "none", validated: true, ...(gated ? { confirmation } : {}) });
    }
    const input = args.input as Value | undefined;
    if (gated) {
      if (typeof args.confirmToken !== "string") {
        return failure({ code: "confirmation_required", status: 428, message: "This change needs the merchant's approval before it runs.", retryable: false, hint: "Show the summary" }, { confirmation });
      }
      if (api.state.usedTokens.has(args.confirmToken)) {
        return failure({ code: "confirm_token_used", status: 409, message: "This confirmToken was already used", retryable: false, hint: "Read to verify" });
      }
      api.state.usedTokens.add(args.confirmToken);
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
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ name: "Demo Store", currency: "BDT", timeZone: "Asia/Dhaka" }) }],
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
    state: { refunds: [], products: [], usedTokens: new Set<string>(), failNextProductCreate: 0, orders: ORDERS },
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
      response.end(Buffer.from(await forwarded.arrayBuffer()));
      return;
    }
    json(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  api.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  api.close = () => new Promise((resolve) => server.close(() => resolve()));
  return api;
}
