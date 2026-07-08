import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminMcpServer } from "./mcp/admin/session-context";
import type { AdminMcpOptions } from "./mcp/admin/session-context";
import {
  DEFAULT_AGENT_PROFILE_URL,
  UCP_VERSION,
  createAgentWorker,
  createStorefrontCatalogMcpServer,
} from "./worker";
import type { FetchLike } from "./worker";

type TestMcpServer = {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
};

vi.mock("agents/mcp", async () => {
  const [{ Client: TestClient }, { InMemoryTransport: TestTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/inMemory.js"),
  ]);

  const rpcResponse = (id: unknown, result: unknown, status = 200) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });

  const rpcError = (id: unknown, code: number, message: string, status = 400) =>
    new Response(JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    }), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });

  const isTestRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

  return {
    createMcpHandler: (server: TestMcpServer) => async (request: Request) => {
      const body = await request.json();
      if (!isTestRecord(body)) return rpcError(null, -32700, "Invalid JSON-RPC request");

      if (body.method === "initialize") {
        const params = isTestRecord(body.params) ? body.params : {};
        return rpcResponse(body.id, {
          protocolVersion: typeof params.protocolVersion === "string"
            ? params.protocolVersion
            : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "test-mcp-handler", version: "0.0.0" },
        });
      }

      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }

      const [clientTransport, serverTransport] = TestTransport.createLinkedPair();
      const client = new TestClient(
        { name: "route-test-client", version: "1.0.0" },
        { capabilities: {} },
      );
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      try {
        if (body.method === "tools/list") {
          return rpcResponse(body.id, await client.listTools());
        }
        if (body.method === "tools/call") {
          const params = isTestRecord(body.params) ? body.params : {};
          return rpcResponse(body.id, await client.callTool({
            name: typeof params.name === "string" ? params.name : "",
            arguments: isTestRecord(params.arguments) ? params.arguments : {},
          }));
        }
        return rpcError(body.id, -32601, "Method not found", 404);
      } finally {
        await Promise.allSettled([
          client.close(),
          server.close(),
        ]);
      }
    },
  };
});

const BASE_TEST_ENV = {
  STOREFRONT_URL: "https://storefront.example.test",
  AGENT_PROFILE_URL: DEFAULT_AGENT_PROFILE_URL,
  AGENT_NAME: "test-catalog-agent",
  AGENT_VERSION: "0.1.0-test",
};

const ADMIN_COOKIE = "better-auth.session_token=signed-session";

const UNSAFE_TERMS = [
  "checkout",
  "cart",
  "order",
  "payment",
  "fulfillment",
  "customer",
  "recovery",
  "provider-secret",
];

const MCP_ACCEPT_HEADER = "application/json, text/event-stream";
const MCP_PROTOCOL_VERSION = "2025-06-18";

interface BootedClient {
  client: Client;
  server: McpServer;
}

const openClients: BootedClient[] = [];

type MockFetch = ReturnType<typeof vi.fn<FetchLike>>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function adminPermissionsBody(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      userId: "admin_123",
      isSuperAdmin: false,
      roles: [{ id: "role_manager", name: "Manager", ignored: "safe-to-drop" }],
      permissions: ["dashboard.view", "products.view"],
      overrides: { grants: ["orders.view"], denials: ["settings.edit"] },
      ...overrides,
    },
  };
}

function mockJsonFetch(body: unknown, status = 200): MockFetch {
  return vi.fn<FetchLike>().mockImplementation(() => Promise.resolve(json(body, status)));
}

function apiBinding(fetchImpl: FetchLike): Fetcher {
  return { fetch: fetchImpl } as Fetcher;
}

function createEnv(apiFetch: FetchLike = mockJsonFetch(adminPermissionsBody())): Env {
  return {
    ...BASE_TEST_ENV,
    API: apiBinding(apiFetch),
  };
}

async function boot(fetchImpl: FetchLike = vi.fn().mockResolvedValue(json({ ucp: { status: "success" } }))) {
  const server = createStorefrontCatalogMcpServer(createEnv(), { fetchImpl });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  openClients.push({ client, server });
  return { client, server };
}

async function bootAdmin(
  apiFetch: FetchLike = mockJsonFetch(adminPermissionsBody()),
  options: AdminMcpOptions = { cookie: ADMIN_COOKIE, userAgent: "vitest-admin-mcp" },
) {
  const server = createAdminMcpServer(createEnv(apiFetch), options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  openClients.push({ client, server });
  return { client, server };
}

function fetchCall(fetchImpl: FetchLike, index = 0): [RequestInfo | URL, RequestInit | undefined] {
  const mock = vi.mocked(fetchImpl);
  const call = mock.mock.calls[index];
  if (!call) throw new Error(`Missing fetch call ${index}`);
  return [call[0], call[1]];
}

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof URL ? input.toString() : String(input);
}

function parseRequestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") return {};
  return JSON.parse(init.body) as Record<string, unknown>;
}

function mcpRequest(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  return new Request("https://agent.example.test/mcp/admin", {
    method: "POST",
    headers: {
      Accept: MCP_ACCEPT_HEADER,
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function parseMcpJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  const contentType = response.headers.get("Content-Type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const dataLine = text.split(/\r?\n/).find((line) => line.startsWith("data:"));
    if (!dataLine) throw new Error(`Missing MCP event data: ${text}`);
    return JSON.parse(dataLine.slice("data:".length).trim()) as Record<string, unknown>;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function requireMcpResult(message: Record<string, unknown>): Record<string, unknown> {
  expect(message.error).toBeUndefined();
  expect(isRecord(message.result)).toBe(true);
  return message.result as Record<string, unknown>;
}

async function initializeAdminMcp(
  worker: ReturnType<typeof createAgentWorker>,
  env: Env,
  headers: Record<string, string>,
): Promise<{ sessionId: string | null; protocolVersion: string | null }> {
  const response = await worker.fetch(
    mcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "agent-test", version: "1.0.0" },
      },
    }, headers),
    env,
    createExecutionContext(),
  );

  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const result = requireMcpResult(await parseMcpJson(response));
  return {
    sessionId: response.headers.get("mcp-session-id"),
    protocolVersion: typeof result.protocolVersion === "string"
      ? result.protocolVersion
      : null,
  };
}

async function adminMcpRpc(
  worker: ReturnType<typeof createAgentWorker>,
  env: Env,
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await worker.fetch(
    mcpRequest(body, headers),
    env,
    createExecutionContext(),
  );
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return parseMcpJson(response);
}

function createExecutionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
    tracing: {
      enterSpan: (_name, callback, ...args) => callback({
        isTraced: false,
        setAttribute: () => undefined,
        end: () => undefined,
      }, ...args),
      startActiveSpan: (_name, callback, ...args) => callback({
        isTraced: false,
        setAttribute: () => undefined,
        end: () => undefined,
      }, ...args),
      Span: class {
        get isTraced() {
          return false;
        }

        setAttribute() {
          return undefined;
        }

        end() {
          return undefined;
        }
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstContentBlock(result: unknown): unknown {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    throw new Error("Expected MCP content array");
  }
  return result.content[0];
}

async function expectValidationToolError(resultPromise: Promise<unknown>): Promise<void> {
  const result = await resultPromise;
  expect(isRecord(result) ? result.isError : undefined).toBe(true);
  expect(firstContentBlock(result)).toMatchObject({
    type: "text",
    text: expect.stringMatching(/validation|Invalid arguments/i),
  });
}

afterEach(async () => {
  await Promise.allSettled(openClients.splice(0).map(async ({ client, server }) => {
    await client.close();
    await server.close();
  }));
  vi.restoreAllMocks();
});

describe("storefront catalog MCP server", () => {
  it("lists catalog-only read tools", async () => {
    const { client } = await boot();

    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "catalog_lookup",
      "catalog_product",
      "catalog_profile",
      "catalog_search",
    ]);

    for (const tool of result.tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
    }

    const serialized = JSON.stringify(result.tools).toLowerCase();
    for (const unsafeTerm of UNSAFE_TERMS) {
      expect(serialized).not.toContain(unsafeTerm);
    }
  });

  it("rejects unbounded catalog inputs before storefront fetches", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(json({ ucp: { status: "success" } }));
    const { client } = await boot(fetchImpl);

    await expectValidationToolError(client.callTool({
      name: "catalog_search",
      arguments: { query: "", limit: 5 },
    }));
    await expectValidationToolError(client.callTool({
      name: "catalog_search",
      arguments: { query: "khaki", limit: 11 },
    }));
    await expectValidationToolError(client.callTool({
      name: "catalog_lookup",
      arguments: { ids: Array.from({ length: 11 }, (_, index) => `prod_${index}`) },
    }));

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("calls storefront UCP search with bounded body and safe profile header", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(json({
      ucp: { status: "success", version: UCP_VERSION },
      products: [{ id: "gid://scalius/product/prod_1", title: "Khaki Shoes" }],
    }));
    const { client } = await boot(fetchImpl);

    const result = await client.callTool({
      name: "catalog_search",
      arguments: { query: "khaki", limit: 3, category: "shoes" },
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      products: [{ title: "Khaki Shoes" }],
    });
    const serialized = JSON.stringify(result).toLowerCase();
    for (const unsafeTerm of UNSAFE_TERMS) {
      expect(serialized).not.toContain(unsafeTerm);
    }

    const [input, init] = fetchCall(fetchImpl);
    expect(requestUrl(input)).toBe("https://storefront.example.test/ucp/catalog/search");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("UCP-Agent")).toBe(`profile="${DEFAULT_AGENT_PROFILE_URL}"`);
    expect(parseRequestBody(init)).toMatchObject({
      ucp: { version: UCP_VERSION },
      query: "khaki",
      pagination: { limit: 3 },
      filters: { categories: ["shoes"] },
    });
  });

  it("preserves UCP application errors as MCP tool errors", async () => {
    const body = {
      ucp: { status: "error", version: UCP_VERSION },
      messages: [{ type: "error", code: "not_found", content: "Product was not found." }],
    };
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(json(body));
    const { client } = await boot(fetchImpl);

    const result = await client.callTool({
      name: "catalog_product",
      arguments: { id: "missing-product" },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual(body);
    expect(firstContentBlock(result)).toMatchObject({
      type: "text",
      text: expect.stringContaining("not_found"),
    });

    const [input, init] = fetchCall(fetchImpl);
    expect(requestUrl(input)).toBe("https://storefront.example.test/ucp/catalog/product");
    expect(parseRequestBody(init)).toMatchObject({
      ucp: { version: UCP_VERSION },
      id: "missing-product",
    });
  });

  it("reads the storefront UCP profile with GET", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(json({
      ucp: {
        version: UCP_VERSION,
        capabilities: {
          "dev.ucp.shopping.catalog.search": [],
          "dev.ucp.shopping.catalog.lookup": [],
        },
      },
    }));
    const { client } = await boot(fetchImpl);

    const result = await client.callTool({
      name: "catalog_profile",
      arguments: {},
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ucp: { version: UCP_VERSION },
    });
    const [input, init] = fetchCall(fetchImpl);
    expect(requestUrl(input)).toBe("https://storefront.example.test/.well-known/ucp");
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("UCP-Agent")).toBe(`profile="${DEFAULT_AGENT_PROFILE_URL}"`);
  });
});

describe("agent Worker routes", () => {
  it("serves no-store health JSON", async () => {
    const worker = createAgentWorker();
    const response = await worker.fetch(
      new Request("https://agent.example.test/health"),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      success: true,
      status: "ok",
      service: "scalius-agent",
    });
  });

  it("returns no-store JSON for unknown routes", async () => {
    const worker = createAgentWorker();
    const response = await worker.fetch(
      new Request("https://agent.example.test/unknown"),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      success: false,
      error: "not_found",
    });
  });

  it("serves public catalog MCP responses with no-store cache headers", async () => {
    const worker = createAgentWorker();
    const response = await worker.fetch(
      new Request("https://agent.example.test/mcp", {
        method: "POST",
        headers: {
          Accept: MCP_ACCEPT_HEADER,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "agent-test", version: "1.0.0" },
          },
        }),
      }),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("admin MCP route", () => {
  it("fails closed with no-store 401 before MCP handling when Cookie is missing", async () => {
    const apiFetch = mockJsonFetch(adminPermissionsBody());
    const worker = createAgentWorker();
    const response = await worker.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
      createEnv(apiFetch),
      createExecutionContext(),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: "admin_session_required" },
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("does not accept bearer-only auth or call the API without a Cookie", async () => {
    const apiFetch = mockJsonFetch(adminPermissionsBody());
    const worker = createAgentWorker();
    const response = await worker.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }, {
        Authorization: "Bearer not-a-session",
      }),
      createEnv(apiFetch),
      createExecutionContext(),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "admin_session_required" },
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("preflights with Cookie only and never forwards Authorization", async () => {
    const apiFetch = mockJsonFetch(adminPermissionsBody());
    const worker = createAgentWorker();

    await initializeAdminMcp(worker, createEnv(apiFetch), {
      Cookie: ADMIN_COOKIE,
      Authorization: "Bearer must-not-forward",
      "User-Agent": "vitest-admin-client",
    });

    const [input, init] = fetchCall(apiFetch);
    expect(requestUrl(input)).toBe("http://api.internal/api/v1/admin/rbac/my-permissions");
    expect(init?.method).toBe("GET");
    const headers = new Headers(init?.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Cookie")).toBe(ADMIN_COOKIE);
    expect(headers.get("User-Agent")).toBe("vitest-admin-client");
    expect(headers.get("Authorization")).toBeNull();
    expect([...headers.keys()].sort()).toEqual(["accept", "cookie", "user-agent"]);
  });

  it("lists exactly the admin session context tool after cookie preflight", async () => {
    const apiFetch = mockJsonFetch(adminPermissionsBody());
    const worker = createAgentWorker();
    const env = createEnv(apiFetch);
    const init = await initializeAdminMcp(worker, env, { Cookie: ADMIN_COOKIE });
    const headers: Record<string, string> = { Cookie: ADMIN_COOKIE };
    if (init.sessionId) headers["Mcp-Session-Id"] = init.sessionId;
    if (init.protocolVersion) headers["MCP-Protocol-Version"] = init.protocolVersion;

    const message = await adminMcpRpc(worker, env, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }, headers);
    const result = requireMcpResult(message);
    expect(Array.isArray(result.tools)).toBe(true);
    const tools = result.tools as Array<Record<string, unknown>>;
    expect(tools.map((tool) => tool.name)).toEqual(["admin_session_context"]);
    expect(tools[0]?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
  });

  it("calls the RBAC endpoint for admin_session_context and returns compact structured content", async () => {
    const apiFetch = mockJsonFetch(adminPermissionsBody());
    const worker = createAgentWorker();
    const env = createEnv(apiFetch);
    const init = await initializeAdminMcp(worker, env, { Cookie: ADMIN_COOKIE });
    const headers: Record<string, string> = { Cookie: ADMIN_COOKIE };
    if (init.sessionId) headers["Mcp-Session-Id"] = init.sessionId;
    if (init.protocolVersion) headers["MCP-Protocol-Version"] = init.protocolVersion;

    const callsBeforeTool = apiFetch.mock.calls.length;
    const message = await adminMcpRpc(worker, env, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "admin_session_context",
        arguments: {},
      },
    }, headers);
    const result = requireMcpResult(message);

    expect(apiFetch.mock.calls.length).toBe(callsBeforeTool + 1);
    expect(requestUrl(fetchCall(apiFetch, apiFetch.mock.calls.length - 1)[0])).toBe(
      "http://api.internal/api/v1/admin/rbac/my-permissions",
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      adminSessionContext: {
        userId: "admin_123",
        isSuperAdmin: false,
        roles: [{ id: "role_manager", name: "Manager" }],
        permissions: ["dashboard.view", "products.view"],
        overrides: { grants: ["orders.view"], denials: ["settings.edit"] },
      },
    });
    expect(firstContentBlock(result)).toMatchObject({
      type: "text",
      text: expect.stringContaining("adminSessionContext"),
    });
  });

  it("keeps upstream admin auth failures fail-closed without leaking upstream bodies", async () => {
    const apiFetch = mockJsonFetch({
      success: false,
      error: {
        code: "forbidden",
        message: `raw upstream leak ${ADMIN_COOKIE} admin@example.test`,
      },
    }, 403);
    const worker = createAgentWorker();
    const response = await worker.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }, {
        Cookie: ADMIN_COOKIE,
      }),
      createEnv(apiFetch),
      createExecutionContext(),
    );

    const body = await response.text();
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toContain("admin_session_forbidden");
    expect(body).not.toContain(ADMIN_COOKIE);
    expect(body).not.toContain("admin@example.test");
    expect(body).not.toContain("raw upstream leak");
  });
});

describe("admin MCP server", () => {
  it("returns a safe MCP tool error when the permissions endpoint rejects the cookie", async () => {
    const apiFetch = mockJsonFetch({
      success: false,
      error: {
        code: "unauthorized",
        message: `raw upstream leak ${ADMIN_COOKIE}`,
      },
    }, 401);
    const { client } = await bootAdmin(apiFetch);

    const result = await client.callTool({
      name: "admin_session_context",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "admin_session_invalid",
        status: 401,
      },
    });
    expect(JSON.stringify(result)).not.toContain(ADMIN_COOKIE);
    expect(JSON.stringify(result)).not.toContain("raw upstream leak");
  });
});
