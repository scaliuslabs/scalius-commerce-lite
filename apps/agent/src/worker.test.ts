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
  "order",
  "payment",
  "fulfillment",
  "customer",
  "private",
  "recovery",
  "provider-secret",
  "admin",
  "mutation",
];

const ADMIN_MCP_FORBIDDEN_MUTATION_TERMS = [
  "browser",
  "click",
  "submit",
  "save",
  "delete",
  "refund",
  "credential",
  "secret",
  "provider",
  "mutation",
  "mutate",
  "write",
];

const MCP_ACCEPT_HEADER = "application/json, text/event-stream";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const INTERNAL_ADMIN_MCP_URL = "http://agent.internal/mcp/admin";
const PUBLIC_ADMIN_MCP_URL = "https://agent.example.test/mcp/admin";

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

async function boot(
  fetchImpl: FetchLike = vi.fn().mockResolvedValue(json({ ucp: { status: "success" } })),
  env: Env = createEnv(),
) {
  const server = createStorefrontCatalogMcpServer(env, { fetchImpl });
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
  url = INTERNAL_ADMIN_MCP_URL,
): Request {
  return new Request(url, {
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

function adminNavigationContext(result: Record<string, unknown>): Record<string, unknown> {
  const structuredContent = result.structuredContent;
  if (!isRecord(structuredContent) || !isRecord(structuredContent.adminNavigationContext)) {
    throw new Error("Expected adminNavigationContext structured content");
  }
  return structuredContent.adminNavigationContext;
}

function adminProductSearchContext(result: Record<string, unknown>): Record<string, unknown> {
  const structuredContent = result.structuredContent;
  if (!isRecord(structuredContent) || !isRecord(structuredContent.adminProductSearch)) {
    throw new Error("Expected adminProductSearch structured content");
  }
  return structuredContent.adminProductSearch;
}

function adminCategorySearchContext(result: Record<string, unknown>): Record<string, unknown> {
  const structuredContent = result.structuredContent;
  if (!isRecord(structuredContent) || !isRecord(structuredContent.adminCategorySearch)) {
    throw new Error("Expected adminCategorySearch structured content");
  }
  return structuredContent.adminCategorySearch;
}

function adminCollectionSearchContext(result: Record<string, unknown>): Record<string, unknown> {
  const structuredContent = result.structuredContent;
  if (!isRecord(structuredContent) || !isRecord(structuredContent.adminCollectionSearch)) {
    throw new Error("Expected adminCollectionSearch structured content");
  }
  return structuredContent.adminCollectionSearch;
}

function adminPageSearchContext(result: Record<string, unknown>): Record<string, unknown> {
  const structuredContent = result.structuredContent;
  if (!isRecord(structuredContent) || !isRecord(structuredContent.adminPageSearch)) {
    throw new Error("Expected adminPageSearch structured content");
  }
  return structuredContent.adminPageSearch;
}

function adminOrderSearchContext(result: Record<string, unknown>): Record<string, unknown> {
  const structuredContent = result.structuredContent;
  if (!isRecord(structuredContent) || !isRecord(structuredContent.adminOrderSearch)) {
    throw new Error("Expected adminOrderSearch structured content");
  }
  return structuredContent.adminOrderSearch;
}

function adminMediaSearchContext(result: Record<string, unknown>): Record<string, unknown> {
  const structuredContent = result.structuredContent;
  if (!isRecord(structuredContent) || !isRecord(structuredContent.adminMediaSearch)) {
    throw new Error("Expected adminMediaSearch structured content");
  }
  return structuredContent.adminMediaSearch;
}

function adminInventoryLookupContext(result: Record<string, unknown>): Record<string, unknown> {
  const structuredContent = result.structuredContent;
  if (!isRecord(structuredContent) || !isRecord(structuredContent.adminInventoryLookup)) {
    throw new Error("Expected adminInventoryLookup structured content");
  }
  return structuredContent.adminInventoryLookup;
}

function adminDashboardSummaryContext(result: Record<string, unknown>): Record<string, unknown> {
  const structuredContent = result.structuredContent;
  if (!isRecord(structuredContent) || !isRecord(structuredContent.adminDashboardSummary)) {
    throw new Error("Expected adminDashboardSummary structured content");
  }
  return structuredContent.adminDashboardSummary;
}

function adminSettingsSummaryContext(result: Record<string, unknown>): Record<string, unknown> {
  const structuredContent = result.structuredContent;
  if (!isRecord(structuredContent) || !isRecord(structuredContent.adminSettingsSummary)) {
    throw new Error("Expected adminSettingsSummary structured content");
  }
  return structuredContent.adminSettingsSummary;
}

function catalogCategoriesContext(result: Record<string, unknown>): Record<string, unknown> {
  const structuredContent = result.structuredContent;
  if (!isRecord(structuredContent) || !isRecord(structuredContent.catalogCategories)) {
    throw new Error("Expected catalogCategories structured content");
  }
  return structuredContent.catalogCategories;
}

function adminNavigationPaths(context: Record<string, unknown>): string[] {
  const sections = Array.isArray(context.sections) ? context.sections : [];
  return sections.flatMap((section) => {
    if (!isRecord(section) || !Array.isArray(section.pages)) return [];
    return section.pages.flatMap((page) => {
      if (!isRecord(page) || typeof page.path !== "string") return [];
      return [page.path];
    });
  });
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
  it("lists storefront catalog and read-only cart validation tools", async () => {
    const { client } = await boot();

    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "cart_validate",
      "catalog_categories",
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

  it("rejects unbounded catalog and cart validation inputs before storefront fetches", async () => {
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
    await expectValidationToolError(client.callTool({
      name: "cart_validate",
      arguments: {
        items: Array.from({ length: 11 }, (_, index) => ({
          productId: `prod_${index}`,
          quantity: 1,
          unitPrice: 100,
        })),
      },
    }));
    await expectValidationToolError(client.callTool({
      name: "cart_validate",
      arguments: {
        items: [{
          productId: "prod_1",
          quantity: 1,
          unitPrice: 100,
          customerPhone: "+8801700000000",
          discountCode: "SAVE20",
        }],
      },
    }));

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects unbounded or private catalog category inputs before API fetches", async () => {
    const storefrontFetch = vi.fn<FetchLike>().mockResolvedValue(json({ ucp: { status: "success" } }));
    const apiFetch = mockJsonFetch({
      success: true,
      data: { categories: [] },
    });
    const { client } = await boot(storefrontFetch, createEnv(apiFetch));

    await expectValidationToolError(client.callTool({
      name: "catalog_categories",
      arguments: { limit: 0 },
    }));
    await expectValidationToolError(client.callTool({
      name: "catalog_categories",
      arguments: { limit: 51 },
    }));
    await expectValidationToolError(client.callTool({
      name: "catalog_categories",
      arguments: { slug: "x".repeat(101) },
    }));
    await expectValidationToolError(client.callTool({
      name: "catalog_categories",
      arguments: {
        limit: 5,
        includePrivate: true,
        includeProducts: true,
        Authorization: "Bearer must-not-forward",
        customerEmail: "customer@example.test",
        paymentToken: "secret",
      },
    }));

    expect(storefrontFetch).not.toHaveBeenCalled();
    expect(apiFetch).not.toHaveBeenCalled();
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

  it("calls the public categories API binding with safe GET headers and compact output", async () => {
    const storefrontFetch = vi.fn<FetchLike>().mockResolvedValue(json({ ucp: { status: "success" } }));
    const apiFetch = vi.fn<FetchLike>().mockResolvedValue(json({
      success: true,
      data: {
        categories: [
          {
            id: "cat_drinks",
            name: "Drinks",
            slug: "drinks",
            description: "<p>Cold &amp; fizzy</p><script>checkout payment customer@example.test</script>",
            canonicalPath: "/categories/beverages",
            noIndex: true,
            excludeFromSitemap: false,
            updatedAt: "2026-07-07T10:30:00.000Z",
            imageUrl: "https://cdn.example.test/private-category.jpg",
            metaTitle: "must-not-leak",
            metaDescription: "must-not-leak",
            createdAt: "must-not-leak",
            customerEmail: "customer@example.test",
            orderCount: 12,
            paymentStatus: "paid",
            privateNote: "must-not-leak",
          },
          {
            id: "cat_over_limit",
            name: "Over Limit",
            slug: "over-limit",
          },
        ],
        ignored: "must-not-leak",
      },
      rawMessage: "must-not-leak",
    }));
    const { client } = await boot(storefrontFetch, createEnv(apiFetch));

    const result = await client.callTool({
      name: "catalog_categories",
      arguments: { limit: 1 },
    });

    expect(storefrontFetch).not.toHaveBeenCalled();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetchCall(apiFetch);
    expect(requestUrl(input)).toBe("http://api.internal/api/v1/categories");
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Cookie")).toBeNull();
    expect(headers.get("Authorization")).toBeNull();
    expect([...headers.keys()].sort()).toEqual(["accept"]);

    expect(result.isError).toBeUndefined();
    const context = catalogCategoriesContext(result as Record<string, unknown>);
    expect(context).toEqual({
      categories: [{
        id: "cat_drinks",
        name: "Drinks",
        slug: "drinks",
        path: "/categories/beverages",
        url: "https://storefront.example.test/categories/beverages",
        description: "Cold & fizzy",
        updatedAt: "2026-07-07T10:30:00.000Z",
        discovery: {
          noIndex: true,
          excludeFromSitemap: false,
        },
      }],
    });
    const category = (context.categories as Array<Record<string, unknown>>)[0];
    expect(Object.keys(category ?? {}).sort()).toEqual([
      "description",
      "discovery",
      "id",
      "name",
      "path",
      "slug",
      "updatedAt",
      "url",
    ]);
    const serialized = JSON.stringify(result).toLowerCase();
    for (const unsafeTerm of UNSAFE_TERMS) {
      expect(serialized).not.toContain(unsafeTerm);
    }
    expect(serialized).not.toContain("imageurl");
    expect(serialized).not.toContain("cdn.example.test");
    expect(serialized).not.toContain("meta");
    expect(serialized).not.toContain("must-not-leak");
  });

  it("reads a single category slug through the public category API route", async () => {
    const apiFetch = vi.fn<FetchLike>().mockResolvedValue(json({
      success: true,
      data: {
        category: {
          id: "cat_summer",
          name: "Summer Sale",
          slug: "summer-sale",
          description: "Seasonal picks",
          canonicalPath: "https://evil.example.test/categories/summer-sale",
          noIndex: false,
          excludeFromSitemap: true,
          updatedAt: "2026-07-08T08:00:00.000Z",
        },
      },
    }));
    const { client } = await boot(undefined, createEnv(apiFetch));

    const result = await client.callTool({
      name: "catalog_categories",
      arguments: { slug: "summer-sale" },
    });

    const [input, init] = fetchCall(apiFetch);
    expect(requestUrl(input)).toBe("http://api.internal/api/v1/categories/summer-sale");
    expect(init?.method).toBe("GET");
    const headers = new Headers(init?.headers);
    expect([...headers.keys()].sort()).toEqual(["accept"]);

    const context = catalogCategoriesContext(result as Record<string, unknown>);
    expect(context).toEqual({
      categories: [{
        id: "cat_summer",
        name: "Summer Sale",
        slug: "summer-sale",
        path: "/categories/summer-sale",
        url: "https://storefront.example.test/categories/summer-sale",
        description: "Seasonal picks",
        updatedAt: "2026-07-08T08:00:00.000Z",
        discovery: {
          noIndex: false,
          excludeFromSitemap: true,
        },
      }],
    });
  });

  it("keeps catalog_categories upstream failures sanitized without leaking bodies", async () => {
    const leak = "raw upstream checkout order payment customer@example.test private receipt token";
    const cases: Array<() => Response> = [
      () => json({ success: false, error: { code: "server_error", message: leak } }, 500),
      () => json({ success: false, error: { code: "not_found", message: leak } }, 404),
      () => new Response(`not json ${leak}`, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
      () => json({ success: true, data: { categories: "not-an-array", message: leak } }),
    ];

    for (const makeResponse of cases) {
      const apiFetch = vi.fn<FetchLike>().mockImplementation(() => Promise.resolve(makeResponse()));
      const { client } = await boot(undefined, createEnv(apiFetch));

      const result = await client.callTool({
        name: "catalog_categories",
        arguments: { limit: 5 },
      });

      expect(apiFetch).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        catalogCategories: {
          categories: [],
        },
        error: {
          code: "temporarily_unavailable",
          message: "Storefront categories are temporarily unavailable.",
        },
      });
      const serialized = JSON.stringify(result).toLowerCase();
      expect(serialized).not.toContain(leak);
      expect(serialized).not.toContain("customer@example.test");
      expect(serialized).not.toContain("receipt");
      for (const unsafeTerm of UNSAFE_TERMS) {
        expect(serialized).not.toContain(unsafeTerm);
      }
    }
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

  it("allows a safe catalog-only storefront UCP profile with GET", async () => {
    const safeProfile = {
      ucp: {
        version: UCP_VERSION,
        capabilities: {
          "dev.ucp.shopping.catalog.search": [{
            version: UCP_VERSION,
            description: "Catalog-only discovery with no checkout or payment support.",
          }],
          "dev.ucp.shopping.catalog.lookup": [{ version: UCP_VERSION }],
          "dev.ucp.shopping.catalog.product": [{ version: UCP_VERSION }],
        },
      },
      signing_keys: [{ kid: "catalog-key", use: "sig" }],
    };
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(json(safeProfile));
    const { client } = await boot(fetchImpl);

    const result = await client.callTool({
      name: "catalog_profile",
      arguments: {},
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ucp: { version: UCP_VERSION },
    });
    expect(result.structuredContent).toEqual(safeProfile);
    const [input, init] = fetchCall(fetchImpl);
    expect(requestUrl(input)).toBe("https://storefront.example.test/.well-known/ucp");
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("UCP-Agent")).toBe(`profile="${DEFAULT_AGENT_PROFILE_URL}"`);
  });

  it("fails catalog_profile closed when the upstream UCP profile advertises transaction capabilities", async () => {
    const unsafeProfiles = [
      {
        profile: {
          ucp: {
            version: UCP_VERSION,
            capabilities: {
              "dev.ucp.shopping.catalog.search": [{ version: UCP_VERSION }],
              "dev.ucp.shopping.cart.mutation": [{ version: UCP_VERSION }],
              "dev.ucp.shopping.checkout": [{ version: UCP_VERSION }],
              "dev.ucp.shopping.order": [{ version: UCP_VERSION }],
            },
          },
        },
        leakedTerms: [
          "dev.ucp.shopping.cart.mutation",
          "dev.ucp.shopping.checkout",
          "dev.ucp.shopping.order",
        ],
      },
      {
        profile: {
          ucp: {
            version: UCP_VERSION,
            capabilities: {
              "dev.ucp.shopping.catalog.search": [{ version: UCP_VERSION }],
            },
            payment_handlers: {
              "com.example.unsafe": [{
                id: "sslcommerz_payment_handler",
                available_instruments: [{ type: "card" }],
              }],
            },
          },
        },
        leakedTerms: [
          "payment_handlers",
          "sslcommerz_payment_handler",
        ],
      },
    ];

    for (const { profile, leakedTerms } of unsafeProfiles) {
      const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(json(profile));
      const { client } = await boot(fetchImpl);

      const result = await client.callTool({
        name: "catalog_profile",
        arguments: {},
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        ucp: { status: "error", version: UCP_VERSION },
        messages: [{
          type: "error",
          code: "ucp_profile_not_catalog_only",
          content: "Storefront catalog is temporarily unavailable.",
          severity: "recoverable",
        }],
      });

      const contentBlock = firstContentBlock(result);
      expect(contentBlock).toMatchObject({
        type: "text",
        text: expect.stringContaining("ucp_profile_not_catalog_only"),
      });
      const text = isRecord(contentBlock) && typeof contentBlock.text === "string"
        ? contentBlock.text
        : "";
      for (const leakedTerm of leakedTerms) {
        expect(text).not.toContain(leakedTerm);
      }

      const [input, init] = fetchCall(fetchImpl);
      expect(requestUrl(input)).toBe("https://storefront.example.test/.well-known/ucp");
      expect(init?.method).toBe("GET");
    }
  });

  it("validates a bounded cart snapshot through the storefront proxy", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(json({
      success: true,
      data: {
        valid: false,
        issues: [{
          index: 0,
          productId: "prod_1",
          variantId: "var_1",
          code: "PRICE_CHANGED",
          action: "refresh_item",
          message: "The price changed before checkout.",
          productName: "Khaki Shoes",
          variantLabel: "Size: 42",
          requestedQuantity: 2,
          submittedPrice: 100,
          currentPrice: 120,
        }],
        items: [],
        subtotal: 0,
        hasFreeDeliveryProduct: false,
      },
    }));
    const { client } = await boot(fetchImpl);

    const result = await client.callTool({
      name: "cart_validate",
      arguments: {
        items: [{
          productId: "prod_1",
          variantId: "var_1",
          slug: "khaki-shoes",
          name: "Khaki Shoes",
          quantity: 2,
          unitPrice: 100,
          options: [{ name: "Size", value: "42" }],
        }],
      },
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      cartValidation: {
        valid: false,
        issueCount: 1,
        issues: [{
          index: 0,
          productId: "prod_1",
          variantId: "var_1",
          code: "PRICE_CHANGED",
          action: "refresh_item",
          message: "Unit price changed.",
          productName: "Khaki Shoes",
          variantLabel: "Size: 42",
          requestedQuantity: 2,
          submittedPrice: 100,
          currentPrice: 120,
        }],
        items: [],
        subtotal: 0,
      },
    });
    expect(firstContentBlock(result)).toMatchObject({
      type: "text",
      text: expect.stringContaining("PRICE_CHANGED"),
    });
    const serialized = JSON.stringify(result).toLowerCase();
    for (const unsafeTerm of UNSAFE_TERMS) {
      expect(serialized).not.toContain(unsafeTerm);
    }

    const [input, init] = fetchCall(fetchImpl);
    expect(requestUrl(input)).toBe("https://storefront.example.test/api/checkout/validate-cart");
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect([...headers.keys()].sort()).toEqual(["accept", "content-type"]);
    expect(parseRequestBody(init)).toEqual({
      items: [{
        productId: "prod_1",
        variantId: "var_1",
        quantity: 2,
        price: 100,
        productName: "Khaki Shoes",
        variantLabel: "Size: 42",
      }],
    });
  });

  it("keeps storefront validation failures fail-closed and cheap", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockRejectedValue(
      new Error("raw checkout order payment customer@example.test"),
    );
    const { client } = await boot(fetchImpl);

    const result = await client.callTool({
      name: "cart_validate",
      arguments: {
        items: [{ productId: "prod_1", quantity: 1, unitPrice: 100 }],
      },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      cartValidation: {
        valid: false,
        issueCount: 0,
        issues: [],
      },
      error: {
        code: "temporarily_unavailable",
        message: "Storefront cart validation is temporarily unavailable.",
      },
    });
    const serialized = JSON.stringify(result).toLowerCase();
    expect(serialized).not.toContain("raw checkout order payment customer@example.test");
    for (const unsafeTerm of UNSAFE_TERMS) {
      expect(serialized).not.toContain(unsafeTerm);
    }
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
  it("hides admin MCP on the public agent host before auth or API preflight", async () => {
    const apiFetch = mockJsonFetch(adminPermissionsBody());
    const worker = createAgentWorker();
    const response = await worker.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }, {
        Cookie: ADMIN_COOKIE,
      }, PUBLIC_ADMIN_MCP_URL),
      createEnv(apiFetch),
      createExecutionContext(),
    );

    const body = await response.text();
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(JSON.parse(body)).toEqual({
      success: false,
      error: "not_found",
    });
    expect(body.toLowerCase()).not.toContain("admin");
    expect(body.toLowerCase()).not.toContain("mcp");
    expect(apiFetch).not.toHaveBeenCalled();
  });

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

  it("lists exactly the read-only admin tools after cookie preflight", async () => {
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
    expect(tools.map((tool) => tool.name)).toEqual([
      "admin_session_context",
      "admin_navigation_context",
      "admin_product_search",
      "admin_category_search",
      "admin_collection_search",
      "admin_page_search",
      "admin_order_search",
      "admin_media_search",
      "admin_inventory_lookup",
      "admin_dashboard_summary",
      "admin_settings_summary",
    ]);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
    }
    const serialized = JSON.stringify(tools).toLowerCase();
    for (const unsafeTerm of ADMIN_MCP_FORBIDDEN_MUTATION_TERMS) {
      expect(serialized).not.toContain(unsafeTerm);
    }
  });

  it("calls admin_settings_summary through the route with no-store response and cookie-only API forwarding", async () => {
    const settingsSummary = {
      general: {
        storeName: "Scalius Test Store",
        currency: "BDT",
      },
      checkout: {
        phoneRequired: true,
        guestCheckoutEnabled: false,
      },
      providers: {
        payment: { configuredCount: 1, activeCount: 1 },
        notifications: { emailReady: true, smsReady: false, whatsappReady: false },
      },
    };
    const apiFetch = vi.fn<FetchLike>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "http://api.internal/api/v1/admin/settings/mcp-summary") {
        return Promise.resolve(json({
          success: true,
          data: settingsSummary,
          ignoredRootSecret: `must-not-leak ${ADMIN_COOKIE}`,
        }));
      }
      return Promise.resolve(json(adminPermissionsBody()));
    });
    const worker = createAgentWorker();
    const env = createEnv(apiFetch);
    const init = await initializeAdminMcp(worker, env, {
      Cookie: ADMIN_COOKIE,
      Authorization: "Bearer must-not-forward",
      "User-Agent": "vitest-admin-client",
    });
    const headers: Record<string, string> = {
      Cookie: ADMIN_COOKIE,
      Authorization: "Bearer must-not-forward",
      "User-Agent": "vitest-admin-client",
    };
    if (init.sessionId) headers["Mcp-Session-Id"] = init.sessionId;
    if (init.protocolVersion) headers["MCP-Protocol-Version"] = init.protocolVersion;

    const callsBeforeTool = apiFetch.mock.calls.length;
    const message = await adminMcpRpc(worker, env, {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: {
        name: "admin_settings_summary",
        arguments: {},
      },
    }, headers);
    const result = requireMcpResult(message);

    expect(apiFetch.mock.calls.length).toBe(callsBeforeTool + 2);
    const [preflightInput, preflightInit] = fetchCall(apiFetch, callsBeforeTool);
    expect(requestUrl(preflightInput)).toBe("http://api.internal/api/v1/admin/rbac/my-permissions");
    expect(new Headers(preflightInit?.headers).get("Authorization")).toBeNull();

    const [settingsInput, settingsInit] = fetchCall(apiFetch, callsBeforeTool + 1);
    expect(requestUrl(settingsInput)).toBe("http://api.internal/api/v1/admin/settings/mcp-summary");
    expect(settingsInit?.method).toBe("GET");
    expect(settingsInit?.body).toBeUndefined();
    const settingsHeaders = new Headers(settingsInit?.headers);
    expect(settingsHeaders.get("Accept")).toBe("application/json");
    expect(settingsHeaders.get("Cookie")).toBe(ADMIN_COOKIE);
    expect(settingsHeaders.get("User-Agent")).toBe("vitest-admin-client");
    expect(settingsHeaders.get("Authorization")).toBeNull();
    expect([...settingsHeaders.keys()].sort()).toEqual(["accept", "cookie", "user-agent"]);
    expect(result.isError).toBeUndefined();
    expect(adminSettingsSummaryContext(result)).toEqual(settingsSummary);
    expect(firstContentBlock(result)).toEqual({
      type: "text",
      text: "Admin settings summary is available.",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("ignoredRootSecret");
    expect(serialized).not.toContain("must-not-leak");
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

  it("returns admin_navigation_context from effective RBAC permissions with bounded static pages", async () => {
    const apiFetch = mockJsonFetch(adminPermissionsBody({
      email: "admin@example.test",
      phone: "+8801000000000",
      permissions: [
        "dashboard.view",
        "products.view",
        "orders.view",
        "settings.general.view",
      ],
    }));
    const worker = createAgentWorker();
    const env = createEnv(apiFetch);
    const init = await initializeAdminMcp(worker, env, { Cookie: ADMIN_COOKIE });
    const headers: Record<string, string> = { Cookie: ADMIN_COOKIE };
    if (init.sessionId) headers["Mcp-Session-Id"] = init.sessionId;
    if (init.protocolVersion) headers["MCP-Protocol-Version"] = init.protocolVersion;

    const callsBeforeTool = apiFetch.mock.calls.length;
    const message = await adminMcpRpc(worker, env, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "admin_navigation_context",
        arguments: {},
      },
    }, headers);
    const result = requireMcpResult(message);
    const context = adminNavigationContext(result);

    expect(apiFetch.mock.calls.length).toBe(callsBeforeTool + 1);
    expect(result.isError).toBeUndefined();
    expect(context).toMatchObject({
      source: {
        permissions: "/api/v1/admin/rbac/my-permissions",
        catalog: "admin-navigation-context:v1",
      },
      session: {
        userId: "admin_123",
        isSuperAdmin: false,
        roleCount: 1,
        permissionCount: 4,
        deniedPermissionCount: 1,
      },
      defaultPath: "/admin",
      limits: {
        maxPages: 24,
        returnedPages: 9,
        catalogPages: 24,
        includesDynamicRoutes: false,
      },
    });
    expect(adminNavigationPaths(context)).toEqual([
      "/admin",
      "/admin/products",
      "/admin/inventory",
      "/admin/orders",
      "/admin/abandoned-checkouts",
      "/admin/settings",
      "/admin/settings/theme",
      "/admin/settings/account",
      "/admin/settings/checkout",
    ]);
    expect(firstContentBlock(result)).toMatchObject({
      type: "text",
      text: expect.stringContaining("adminNavigationContext"),
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("admin@example.test");
    expect(serialized).not.toContain("+8801000000000");
  });

  it("returns an empty admin navigation catalog for a non-superadmin with no effective permissions", async () => {
    const apiFetch = mockJsonFetch(adminPermissionsBody({
      permissions: [],
      overrides: { grants: [], denials: [] },
    }));
    const worker = createAgentWorker();
    const env = createEnv(apiFetch);
    const init = await initializeAdminMcp(worker, env, { Cookie: ADMIN_COOKIE });
    const headers: Record<string, string> = { Cookie: ADMIN_COOKIE };
    if (init.sessionId) headers["Mcp-Session-Id"] = init.sessionId;
    if (init.protocolVersion) headers["MCP-Protocol-Version"] = init.protocolVersion;

    const message = await adminMcpRpc(worker, env, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "admin_navigation_context",
        arguments: {},
      },
    }, headers);
    const result = requireMcpResult(message);
    const context = adminNavigationContext(result);

    expect(context).toMatchObject({
      defaultPath: null,
      limits: {
        returnedPages: 0,
        includesDynamicRoutes: false,
      },
      sections: [],
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

  it("returns a safe admin_navigation_context tool error when no cookie option is present", async () => {
    const apiFetch = mockJsonFetch(adminPermissionsBody());
    const { client } = await bootAdmin(apiFetch, {
      cookie: null,
      userAgent: "vitest-admin-mcp",
    });

    const result = await client.callTool({
      name: "admin_navigation_context",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "admin_session_required",
        status: 401,
      },
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("calls admin_dashboard_summary through the API binding with strict safe aggregate projection", async () => {
    const longUserAgent = `vitest-admin-mcp-${"x".repeat(300)}`;
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        stats: {
          totalProducts: 12,
          totalCustomers: 34,
          totalRevenue: 999999,
          currentMonth: {
            orders: 5,
            revenue: 1234.5,
            orderGrowth: -2.5,
            revenueGrowth: 4,
            orderStatus: {
              delivered: 1,
              processing: 2,
              shipping: 1,
              cancelled: 1,
              returned: 99,
            },
            recentOrders: [{
              id: "ord_secret_123",
              customerName: "Jane Buyer",
              email: "jane@example.test",
              phone: "+8801712345678",
              providerPayload: { token: "provider-secret-payload" },
              paymentEvidence: "receipt-proof-secret",
            }],
            dailyActivity: [{ date: "2026-07-08", revenue: 777 }],
          },
          lastMonth: {
            orders: 4,
            revenue: 1000,
            totalRevenue: 8888,
            customerEmail: "last-month@example.test",
          },
          unknownField: "must-not-leak",
        },
        recentOrders: [{ id: "ord_top_level_secret" }],
        customerName: "Top Level Buyer",
        email: "top-level@example.test",
        phone: "+8801999999999",
        providerPayload: { raw: "top-level-provider-secret" },
      },
      rawMessage: `must-not-leak ${ADMIN_COOKIE}`,
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: ADMIN_COOKIE,
      userAgent: longUserAgent,
    });

    const result = await client.callTool({
      name: "admin_dashboard_summary",
      arguments: {},
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetchCall(apiFetch);
    expect(requestUrl(input)).toBe("http://api.internal/api/v1/admin/dashboard/metrics-summary");
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Cookie")).toBe(ADMIN_COOKIE);
    expect(headers.get("User-Agent")).toBe(longUserAgent.slice(0, 256));
    expect(headers.get("Authorization")).toBeNull();
    expect([...headers.keys()].sort()).toEqual(["accept", "cookie", "user-agent"]);

    expect(result.isError).toBeUndefined();
    const context = adminDashboardSummaryContext(result as Record<string, unknown>);
    expect(context).toEqual({
      source: {
        path: "/api/v1/admin/dashboard/metrics-summary",
        permission: "dashboard.view",
      },
      stats: {
        totalProducts: 12,
        totalCustomers: 34,
        currentMonth: {
          orders: 5,
          revenue: 1234.5,
          orderGrowth: -2.5,
          revenueGrowth: 4,
          orderStatus: {
            delivered: 1,
            processing: 2,
            shipping: 1,
            cancelled: 1,
          },
        },
        lastMonth: {
          orders: 4,
          revenue: 1000,
        },
      },
      limits: {
        includesRecentOrders: false,
        includesOrderIds: false,
        includesCustomerPii: false,
        includesCustomerContacts: false,
        includesPaymentEvidence: false,
        includesProviderPayloads: false,
        includesLifetimeRevenue: false,
        includesDailyActivity: false,
        canMutate: false,
      },
    });
    expect(firstContentBlock(result)).toEqual({
      type: "text",
      text: "Admin dashboard summary aggregates are available.",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("ord_secret_123");
    expect(serialized).not.toContain("ord_top_level_secret");
    expect(serialized).not.toContain("Jane Buyer");
    expect(serialized).not.toContain("Top Level Buyer");
    expect(serialized).not.toContain("jane@example.test");
    expect(serialized).not.toContain("top-level@example.test");
    expect(serialized).not.toContain("+8801712345678");
    expect(serialized).not.toContain("+8801999999999");
    expect(serialized).not.toContain("provider-secret-payload");
    expect(serialized).not.toContain("top-level-provider-secret");
    expect(serialized).not.toContain("receipt-proof-secret");
    expect(serialized).not.toContain("dailyActivity");
    expect(serialized).not.toContain("totalRevenue");
    expect(serialized).not.toContain("unknownField");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain(ADMIN_COOKIE);
  });

  it("returns a safe admin_dashboard_summary tool error when no cookie option is present", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { stats: { totalProducts: 0 } },
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: null,
      userAgent: "vitest-admin-mcp",
    });

    const result = await client.callTool({
      name: "admin_dashboard_summary",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "admin_session_required",
        status: 401,
      },
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("rejects unexpected admin_dashboard_summary inputs before API fetches", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { stats: { totalProducts: 0 } },
    });
    const { client } = await bootAdmin(apiFetch);

    await expectValidationToolError(client.callTool({
      name: "admin_dashboard_summary",
      arguments: {
        includeRecentOrders: true,
        customerEmail: "customer@example.test",
        orderId: "ord_secret_123",
        Authorization: "Bearer must-not-forward",
      },
    }));

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("keeps admin_dashboard_summary upstream failures fail-closed without leaking upstream bodies", async () => {
    const leak = `raw upstream leak ${ADMIN_COOKIE} admin@example.test +8801712345678 ord_secret provider-secret`;
    const cases: Array<() => Response> = [
      () => json({ success: false, error: { code: "forbidden", message: leak } }, 403),
      () => json({ success: false, error: { code: "server_error", message: leak } }, 500),
      () => new Response(`not json ${leak}`, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
      () => json({ success: false, error: { code: "invalid", message: leak } }),
      () => json({ success: true, data: { stats: [], message: leak } }),
      () => json({ success: true, data: { message: leak } }),
    ];

    for (const makeResponse of cases) {
      const apiFetch = vi.fn<FetchLike>().mockImplementation(() => Promise.resolve(makeResponse()));
      const { client } = await bootAdmin(apiFetch);

      const result = await client.callTool({
        name: "admin_dashboard_summary",
        arguments: {},
      });

      expect(apiFetch).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        adminDashboardSummary: {
          source: {
            path: "/api/v1/admin/dashboard/metrics-summary",
            permission: "dashboard.view",
          },
          stats: null,
          limits: {
            includesRecentOrders: false,
            includesOrderIds: false,
            includesCustomerPii: false,
            includesCustomerContacts: false,
            includesPaymentEvidence: false,
            includesProviderPayloads: false,
            includesLifetimeRevenue: false,
            includesDailyActivity: false,
            canMutate: false,
          },
        },
        error: {
          code: "admin_dashboard_summary_unavailable",
        },
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(ADMIN_COOKIE);
      expect(serialized).not.toContain("admin@example.test");
      expect(serialized).not.toContain("+8801712345678");
      expect(serialized).not.toContain("ord_secret");
      expect(serialized).not.toContain("provider-secret");
      expect(serialized).not.toContain("raw upstream leak");
    }
  });

  it("calls admin_settings_summary through the API binding with exact redacted settings projection", async () => {
    const longUserAgent = `vitest-admin-mcp-${"x".repeat(300)}`;
    const settingsSummary = {
      general: {
        storeName: "Scalius Test Store",
        storefrontUrlConfigured: true,
        currency: "BDT",
      },
      checkout: {
        phoneRequired: true,
        guestCheckoutEnabled: false,
        partialPaymentsEnabled: true,
      },
      discovery: {
        productFeedEnabled: true,
        sitemapEnabled: true,
        ucpCatalogOnly: true,
      },
      providerReadiness: {
        paymentGateways: { configuredCount: 2, activeCount: 1 },
        notifications: { emailReady: true, smsReady: false, whatsappReady: true },
      },
    };
    const apiFetch = mockJsonFetch({
      success: true,
      data: settingsSummary,
      ignoredRootSecret: `must-not-leak ${ADMIN_COOKIE} provider-secret`,
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: ADMIN_COOKIE,
      userAgent: longUserAgent,
    });

    const result = await client.callTool({
      name: "admin_settings_summary",
      arguments: {},
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetchCall(apiFetch);
    expect(requestUrl(input)).toBe("http://api.internal/api/v1/admin/settings/mcp-summary");
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Cookie")).toBe(ADMIN_COOKIE);
    expect(headers.get("User-Agent")).toBe(longUserAgent.slice(0, 256));
    expect(headers.get("Authorization")).toBeNull();
    expect([...headers.keys()].sort()).toEqual(["accept", "cookie", "user-agent"]);

    expect(result.isError).toBeUndefined();
    expect(adminSettingsSummaryContext(result as Record<string, unknown>)).toEqual(settingsSummary);
    expect(firstContentBlock(result)).toEqual({
      type: "text",
      text: "Admin settings summary is available.",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("ignoredRootSecret");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("provider-secret");
    expect(serialized).not.toContain(ADMIN_COOKIE);
  });

  it("returns a safe admin_settings_summary tool error when no cookie option is present", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { general: { storeName: "Scalius Test Store" } },
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: null,
      userAgent: "vitest-admin-mcp",
    });

    const result = await client.callTool({
      name: "admin_settings_summary",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "admin_session_required",
        status: 401,
      },
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("rejects unexpected admin_settings_summary inputs before API fetches", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { general: { storeName: "Scalius Test Store" } },
    });
    const { client } = await bootAdmin(apiFetch);

    await expectValidationToolError(client.callTool({
      name: "admin_settings_summary",
      arguments: {
        includeSecrets: true,
        providerCredential: "provider-secret",
        Authorization: "Bearer must-not-forward",
      },
    }));

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("keeps admin_settings_summary upstream failures fail-closed without leaking upstream bodies", async () => {
    const leak = `raw upstream leak ${ADMIN_COOKIE} admin@example.test +8801712345678 provider-secret`;
    const cases: Array<{ makeResponse: () => Response; expectedStatus: number }> = [
      {
        makeResponse: () => json({ success: false, error: { code: "unauthorized", message: leak } }, 401),
        expectedStatus: 401,
      },
      {
        makeResponse: () => json({ success: false, error: { code: "forbidden", message: leak } }, 403),
        expectedStatus: 403,
      },
      {
        makeResponse: () => json({ success: false, error: { code: "server_error", message: leak } }, 500),
        expectedStatus: 503,
      },
      {
        makeResponse: () => new Response(`not json ${leak}`, {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
        expectedStatus: 503,
      },
      {
        makeResponse: () => json({ success: false, error: { code: "invalid", message: leak } }),
        expectedStatus: 503,
      },
      {
        makeResponse: () => json({ success: true, data: [], message: leak }),
        expectedStatus: 503,
      },
      {
        makeResponse: () => json({ success: true, data: null, message: leak }),
        expectedStatus: 503,
      },
    ];

    for (const { makeResponse, expectedStatus } of cases) {
      const apiFetch = vi.fn<FetchLike>().mockImplementation(() => Promise.resolve(makeResponse()));
      const { client } = await bootAdmin(apiFetch);

      const result = await client.callTool({
        name: "admin_settings_summary",
        arguments: {},
      });

      expect(apiFetch).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        adminSettingsSummary: null,
        error: {
          code: "admin_settings_summary_unavailable",
          status: expectedStatus,
        },
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(ADMIN_COOKIE);
      expect(serialized).not.toContain("admin@example.test");
      expect(serialized).not.toContain("+8801712345678");
      expect(serialized).not.toContain("provider-secret");
      expect(serialized).not.toContain("raw upstream leak");
    }
  });

  it("calls admin_category_search through the API binding with fixed search query and compact output", async () => {
    const longUserAgent = `vitest-admin-mcp-${"x".repeat(300)}`;
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        categories: [{
          id: "cat_1",
          name: "Summer Shoes",
          slug: "summer-shoes",
          isActive: true,
          status: "active",
          description: "raw category description",
          imageUrl: "https://cdn.example.test/private-category.jpg",
          imageCount: 2,
          metaTitle: "must-not-leak",
          metaDescription: "must-not-leak",
          canonicalPath: "/categories/summer-shoes",
          noIndex: true,
          excludeFromSitemap: false,
          productCount: 7,
          createdAt: "2026-07-07T08:00:00.000Z",
          updatedAt: "2026-07-07T10:30:00.000Z",
          deletedAt: "2026-07-08T00:00:00.000Z",
          privateNote: "must-not-leak",
          customerEmail: "customer@example.test",
          orderCount: 12,
          paymentStatus: "paid",
        }, {
          id: "cat_absolute",
          name: "Absolute Canonical",
          slug: "absolute-canonical",
          canonicalPath: "https://evil.example.test/categories/absolute-canonical",
          imageUrl: null,
          noIndex: false,
          excludeFromSitemap: true,
          productCount: 0,
          updatedAt: "2026-07-08T10:30:00.000Z",
        }],
        pagination: {
          page: 2,
          limit: 3,
          total: 9,
          totalPages: 3,
          rawCursor: "must-not-leak",
        },
      },
      rawMessage: `must-not-leak ${ADMIN_COOKIE}`,
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: ADMIN_COOKIE,
      userAgent: longUserAgent,
    });

    const result = await client.callTool({
      name: "admin_category_search",
      arguments: { query: "  summer shoes  ", limit: 3, page: 2 },
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetchCall(apiFetch);
    const url = new URL(requestUrl(input));
    expect(`${url.origin}${url.pathname}`).toBe("http://api.internal/api/v1/admin/categories");
    expect([...url.searchParams.entries()]).toEqual([
      ["search", "summer shoes"],
      ["page", "2"],
      ["limit", "3"],
      ["sort", "updatedAt"],
      ["order", "desc"],
    ]);
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Cookie")).toBe(ADMIN_COOKIE);
    expect(headers.get("User-Agent")).toBe(longUserAgent.slice(0, 256));
    expect(headers.get("Authorization")).toBeNull();
    expect([...headers.keys()].sort()).toEqual(["accept", "cookie", "user-agent"]);

    expect(result.isError).toBeUndefined();
    const context = adminCategorySearchContext(result as Record<string, unknown>);
    expect(context).toEqual({
      source: { path: "/api/v1/admin/categories" },
      query: {
        query: "summer shoes",
        page: 2,
        limit: 3,
        sort: "updatedAt",
        order: "desc",
      },
      categories: [{
        id: "cat_1",
        name: "Summer Shoes",
        slug: "summer-shoes",
        productCount: 7,
        noIndex: true,
        excludeFromSitemap: false,
        canonicalPath: "/categories/summer-shoes",
        updatedAt: "2026-07-07T10:30:00.000Z",
      }, {
        id: "cat_absolute",
        name: "Absolute Canonical",
        slug: "absolute-canonical",
        productCount: 0,
        noIndex: false,
        excludeFromSitemap: true,
        updatedAt: "2026-07-08T10:30:00.000Z",
      }],
      pagination: {
        page: 2,
        limit: 3,
        total: 9,
        totalPages: 3,
      },
      limits: {
        maxCategories: 10,
        includesTrashed: false,
        includesDescriptions: false,
        includesMetaText: false,
        includesRawImages: false,
      },
    });
    const categories = context.categories as Array<Record<string, unknown>>;
    expect(categories).toHaveLength(2);
    const category = categories[0];
    if (!category) throw new Error("Expected compact admin category");
    expect(Object.keys(category).sort()).toEqual([
      "canonicalPath",
      "excludeFromSitemap",
      "id",
      "name",
      "noIndex",
      "productCount",
      "slug",
      "updatedAt",
    ]);
    expect(categories[1]).not.toHaveProperty("canonicalPath");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("raw category description");
    expect(serialized).not.toContain("https://cdn.example.test/private-category.jpg");
    expect(serialized).not.toContain("https://evil.example.test");
    expect(serialized).not.toContain("metaTitle");
    expect(serialized).not.toContain("metaDescription");
    expect(serialized).not.toContain("deletedAt");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("customer@example.test");
    expect(serialized).not.toContain(ADMIN_COOKIE);
  });

  it("keeps admin_category_search upstream failures fail-closed without leaking upstream bodies", async () => {
    const leak = `raw upstream leak ${ADMIN_COOKIE} admin@example.test +8801712345678`;
    const cases: Array<() => Response> = [
      () => json({ success: false, error: { code: "forbidden", message: leak } }, 403),
      () => json({ success: false, error: { code: "server_error", message: leak } }, 500),
      () => new Response(`not json ${leak}`, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
      () => json({ success: false, error: { code: "invalid", message: leak } }),
      () => json({ success: true, data: { categories: [], message: leak } }),
    ];

    for (const makeResponse of cases) {
      const apiFetch = vi.fn<FetchLike>().mockImplementation(() => Promise.resolve(makeResponse()));
      const { client } = await bootAdmin(apiFetch);

      const result = await client.callTool({
        name: "admin_category_search",
        arguments: { query: "summer" },
      });

      expect(apiFetch).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        adminCategorySearch: {
          source: { path: "/api/v1/admin/categories" },
          query: {
            query: "summer",
            page: 1,
            limit: 5,
            sort: "updatedAt",
            order: "desc",
          },
          categories: [],
          pagination: null,
          limits: {
            maxCategories: 10,
            includesTrashed: false,
            includesDescriptions: false,
            includesMetaText: false,
            includesRawImages: false,
          },
        },
        error: {
          code: "admin_category_unavailable",
        },
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(ADMIN_COOKIE);
      expect(serialized).not.toContain("admin@example.test");
      expect(serialized).not.toContain("+8801712345678");
      expect(serialized).not.toContain("raw upstream leak");
    }
  });

  it("returns a safe admin_category_search tool error when no cookie option is present", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { categories: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } },
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: null,
      userAgent: "vitest-admin-mcp",
    });

    const result = await client.callTool({
      name: "admin_category_search",
      arguments: { query: "summer" },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "admin_session_required",
        status: 401,
      },
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("rejects unbounded admin_category_search inputs before API fetches", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { categories: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } },
    });
    const { client } = await bootAdmin(apiFetch);

    await expectValidationToolError(client.callTool({
      name: "admin_category_search",
      arguments: { query: "", limit: 5 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_category_search",
      arguments: { query: "x".repeat(121), limit: 5 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_category_search",
      arguments: { query: "summer", limit: 11 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_category_search",
      arguments: { query: "summer", page: 21 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_category_search",
      arguments: {
        query: "summer",
        search: "old-field",
        includeTrashed: true,
        includeDescriptions: true,
        imageUrl: "https://cdn.example.test/private.jpg",
        deletedAt: "2026-07-08T00:00:00.000Z",
        Authorization: "Bearer must-not-forward",
      },
    }));

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("calls admin_collection_search through the API binding with fixed search query and compact output", async () => {
    const longUserAgent = `vitest-admin-mcp-${"x".repeat(300)}`;
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        collections: [{
          id: "col_1",
          name: "Summer Picks",
          slug: "must-not-leak-slug",
          type: "manual",
          config: "{\"productIds\":[\"prod_secret\"]}",
          sortOrder: 4,
          isActive: true,
          description: "raw collection description",
          imageUrl: "https://cdn.example.test/private-collection.jpg",
          products: [{ id: "prod_secret", name: "Hidden Product" }],
          productCount: 7,
          metaTitle: "must-not-leak",
          metaDescription: "must-not-leak",
          canonicalPath: "/collections/col_1",
          noIndex: true,
          excludeFromSitemap: false,
          createdAt: "2026-07-07T08:00:00.000Z",
          updatedAt: "2026-07-07T10:30:00.000Z",
          deletedAt: "2026-07-08T00:00:00.000Z",
          privateNote: "must-not-leak",
          customerEmail: "customer@example.test",
          orderCount: 12,
          paymentStatus: "paid",
        }, {
          id: "col_absolute",
          name: "Absolute Canonical",
          slug: "absolute-canonical",
          canonicalPath: "/collections/col_other",
          imageUrl: null,
          noIndex: false,
          excludeFromSitemap: true,
          productCount: 0,
          updatedAt: "2026-07-08T10:30:00.000Z",
        }],
        pagination: {
          page: 2,
          limit: 3,
          total: 9,
          totalPages: 3,
          rawCursor: "must-not-leak",
        },
      },
      rawMessage: `must-not-leak ${ADMIN_COOKIE}`,
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: ADMIN_COOKIE,
      userAgent: longUserAgent,
    });

    const result = await client.callTool({
      name: "admin_collection_search",
      arguments: { query: "  summer picks  ", limit: 3, page: 2 },
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetchCall(apiFetch);
    const url = new URL(requestUrl(input));
    expect(`${url.origin}${url.pathname}`).toBe("http://api.internal/api/v1/admin/collections");
    expect([...url.searchParams.entries()]).toEqual([
      ["search", "summer picks"],
      ["page", "2"],
      ["limit", "3"],
      ["sort", "updatedAt"],
      ["order", "desc"],
    ]);
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Cookie")).toBe(ADMIN_COOKIE);
    expect(headers.get("User-Agent")).toBe(longUserAgent.slice(0, 256));
    expect(headers.get("Authorization")).toBeNull();
    expect([...headers.keys()].sort()).toEqual(["accept", "cookie", "user-agent"]);

    expect(result.isError).toBeUndefined();
    const context = adminCollectionSearchContext(result as Record<string, unknown>);
    expect(context).toEqual({
      source: { path: "/api/v1/admin/collections" },
      query: {
        query: "summer picks",
        page: 2,
        limit: 3,
        sort: "updatedAt",
        order: "desc",
      },
      collections: [{
        id: "col_1",
        name: "Summer Picks",
        productCount: 7,
        noIndex: true,
        excludeFromSitemap: false,
        canonicalPath: "/collections/col_1",
        updatedAt: "2026-07-07T10:30:00.000Z",
      }, {
        id: "col_absolute",
        name: "Absolute Canonical",
        productCount: 0,
        noIndex: false,
        excludeFromSitemap: true,
        updatedAt: "2026-07-08T10:30:00.000Z",
      }],
      pagination: {
        page: 2,
        limit: 3,
        total: 9,
        totalPages: 3,
      },
      limits: {
        maxCollections: 10,
        includesTrashed: false,
        includesProducts: false,
        includesDescriptions: false,
        includesMetaText: false,
        includesRawImages: false,
        includesDeletedFields: false,
      },
    });
    const collections = context.collections as Array<Record<string, unknown>>;
    expect(collections).toHaveLength(2);
    const collection = collections[0];
    if (!collection) throw new Error("Expected compact admin collection");
    expect(Object.keys(collection).sort()).toEqual([
      "canonicalPath",
      "excludeFromSitemap",
      "id",
      "name",
      "noIndex",
      "productCount",
      "updatedAt",
    ]);
    expect(collections[1]).not.toHaveProperty("canonicalPath");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("raw collection description");
    expect(serialized).not.toContain("https://cdn.example.test/private-collection.jpg");
    expect(serialized).not.toContain("/collections/col_other");
    expect(serialized).not.toContain("must-not-leak-slug");
    expect(serialized).not.toContain("absolute-canonical");
    expect(serialized).not.toContain("prod_secret");
    expect(serialized).not.toContain("Hidden Product");
    expect(serialized).not.toContain("config");
    expect(serialized).not.toContain("metaTitle");
    expect(serialized).not.toContain("metaDescription");
    expect(serialized).not.toContain("deletedAt");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("customer@example.test");
    expect(serialized).not.toContain(ADMIN_COOKIE);
  });

  it("keeps admin_collection_search upstream failures fail-closed without leaking upstream bodies", async () => {
    const leak = `raw upstream leak ${ADMIN_COOKIE} admin@example.test +8801712345678`;
    const cases: Array<() => Response> = [
      () => json({ success: false, error: { code: "forbidden", message: leak } }, 403),
      () => json({ success: false, error: { code: "server_error", message: leak } }, 500),
      () => new Response(`not json ${leak}`, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
      () => json({ success: false, error: { code: "invalid", message: leak } }),
      () => json({ success: true, data: { collections: [], message: leak } }),
    ];

    for (const makeResponse of cases) {
      const apiFetch = vi.fn<FetchLike>().mockImplementation(() => Promise.resolve(makeResponse()));
      const { client } = await bootAdmin(apiFetch);

      const result = await client.callTool({
        name: "admin_collection_search",
        arguments: { query: "summer" },
      });

      expect(apiFetch).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        adminCollectionSearch: {
          source: { path: "/api/v1/admin/collections" },
          query: {
            query: "summer",
            page: 1,
            limit: 5,
            sort: "updatedAt",
            order: "desc",
          },
          collections: [],
          pagination: null,
          limits: {
            maxCollections: 10,
            includesTrashed: false,
            includesProducts: false,
            includesDescriptions: false,
            includesMetaText: false,
            includesRawImages: false,
            includesDeletedFields: false,
          },
        },
        error: {
          code: "admin_collection_unavailable",
        },
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(ADMIN_COOKIE);
      expect(serialized).not.toContain("admin@example.test");
      expect(serialized).not.toContain("+8801712345678");
      expect(serialized).not.toContain("raw upstream leak");
    }
  });

  it("returns a safe admin_collection_search tool error when no cookie option is present", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { collections: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } },
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: null,
      userAgent: "vitest-admin-mcp",
    });

    const result = await client.callTool({
      name: "admin_collection_search",
      arguments: { query: "summer" },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "admin_session_required",
        status: 401,
      },
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("rejects unbounded admin_collection_search inputs before API fetches", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { collections: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } },
    });
    const { client } = await bootAdmin(apiFetch);

    await expectValidationToolError(client.callTool({
      name: "admin_collection_search",
      arguments: { query: "", limit: 5 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_collection_search",
      arguments: { query: "x".repeat(121), limit: 5 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_collection_search",
      arguments: { query: "summer", limit: 11 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_collection_search",
      arguments: { query: "summer", page: 21 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_collection_search",
      arguments: {
        query: "summer",
        search: "old-field",
        trashed: true,
        includeProducts: true,
        includeDescriptions: true,
        includeDeleted: true,
        metaDescription: "must-not-forward",
        imageUrl: "https://cdn.example.test/private.jpg",
        Authorization: "Bearer must-not-forward",
      },
    }));

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("calls admin_page_search through the API binding with fixed search query and compact output", async () => {
    const longUserAgent = `vitest-admin-mcp-${"x".repeat(300)}`;
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        pages: [{
          id: "page_1",
          title: "About Us",
          slug: "about-us",
          isPublished: true,
          noIndex: true,
          excludeFromSitemap: false,
          canonicalPath: "/about-us",
          hideHeader: false,
          hideFooter: true,
          hideTitle: false,
          publishedAt: "2026-07-07T08:00:00.000Z",
          updatedAt: "2026-07-07T10:30:00.000Z",
          content: "<p>raw page content</p>",
          metaTitle: "must-not-leak",
          metaDescription: "must-not-leak",
          featuredImage: "https://cdn.example.test/private-page.jpg",
          deletedAt: "2026-07-08T00:00:00.000Z",
          deletedBy: "admin_secret",
          privateNote: "must-not-leak",
          customerEmail: "customer@example.test",
          mutationAuthority: "must-not-leak",
        }, {
          id: "page_override_canonical",
          title: "Contact",
          slug: "contact",
          isPublished: false,
          noIndex: false,
          excludeFromSitemap: true,
          canonicalPath: "/contact-us",
          hideHeader: "not-boolean",
          hideFooter: null,
          hideTitle: true,
          publishedAt: null,
          updatedAt: "2026-07-08T10:30:00.000Z",
        }, {
          id: "page_blank_canonical",
          title: "Careers",
          slug: "careers",
          isPublished: true,
          canonicalPath: "",
          updatedAt: 1783516200,
        }, {
          id: "page_reserved_canonical",
          title: "Search",
          slug: "search",
          isPublished: true,
          canonicalPath: "/search",
          updatedAt: "2026-07-08T11:30:00.000Z",
        }],
        pagination: {
          page: 2,
          limit: 4,
          total: 9,
          totalPages: 3,
          rawCursor: "must-not-leak",
        },
      },
      rawMessage: `must-not-leak ${ADMIN_COOKIE}`,
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: ADMIN_COOKIE,
      userAgent: longUserAgent,
    });

    const result = await client.callTool({
      name: "admin_page_search",
      arguments: { query: "  about us  ", limit: 4, page: 2 },
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetchCall(apiFetch);
    const url = new URL(requestUrl(input));
    expect(`${url.origin}${url.pathname}`).toBe("http://api.internal/api/v1/admin/pages");
    expect([...url.searchParams.entries()]).toEqual([
      ["search", "about us"],
      ["page", "2"],
      ["limit", "4"],
      ["sort", "updatedAt"],
      ["order", "desc"],
    ]);
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Cookie")).toBe(ADMIN_COOKIE);
    expect(headers.get("User-Agent")).toBe(longUserAgent.slice(0, 256));
    expect(headers.get("Authorization")).toBeNull();
    expect([...headers.keys()].sort()).toEqual(["accept", "cookie", "user-agent"]);

    expect(result.isError).toBeUndefined();
    const context = adminPageSearchContext(result as Record<string, unknown>);
    expect(context).toEqual({
      source: { path: "/api/v1/admin/pages" },
      query: {
        query: "about us",
        page: 2,
        limit: 4,
        sort: "updatedAt",
        order: "desc",
      },
      pages: [{
        id: "page_1",
        title: "About Us",
        slug: "about-us",
        isPublished: true,
        noIndex: true,
        excludeFromSitemap: false,
        canonicalPath: "/about-us",
        hideHeader: false,
        hideFooter: true,
        hideTitle: false,
        publishedAt: "2026-07-07T08:00:00.000Z",
        updatedAt: "2026-07-07T10:30:00.000Z",
      }, {
        id: "page_override_canonical",
        title: "Contact",
        slug: "contact",
        isPublished: false,
        noIndex: false,
        excludeFromSitemap: true,
        canonicalPath: "/contact-us",
        hideTitle: true,
        updatedAt: "2026-07-08T10:30:00.000Z",
      }, {
        id: "page_blank_canonical",
        title: "Careers",
        slug: "careers",
        isPublished: true,
        updatedAt: 1783516200,
      }, {
        id: "page_reserved_canonical",
        title: "Search",
        slug: "search",
        isPublished: true,
        updatedAt: "2026-07-08T11:30:00.000Z",
      }],
      pagination: {
        page: 2,
        limit: 4,
        total: 9,
        totalPages: 3,
      },
      limits: {
        maxPages: 10,
        includesTrashed: false,
        includesContent: false,
        includesMetaText: false,
        includesRawImages: false,
        includesDeletedFields: false,
      },
    });
    const pages = context.pages as Array<Record<string, unknown>>;
    expect(pages).toHaveLength(4);
    const page = pages[0];
    if (!page) throw new Error("Expected compact admin page");
    expect(Object.keys(page).sort()).toEqual([
      "canonicalPath",
      "excludeFromSitemap",
      "hideFooter",
      "hideHeader",
      "hideTitle",
      "id",
      "isPublished",
      "noIndex",
      "publishedAt",
      "slug",
      "title",
      "updatedAt",
    ]);
    expect(pages[1]).toHaveProperty("canonicalPath", "/contact-us");
    expect(pages[1]).not.toHaveProperty("hideHeader");
    expect(pages[1]).not.toHaveProperty("hideFooter");
    expect(pages[2]).not.toHaveProperty("canonicalPath");
    expect(pages[3]).not.toHaveProperty("canonicalPath");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("raw page content");
    expect(serialized).not.toContain("https://cdn.example.test/private-page.jpg");
    expect(serialized).not.toContain('canonicalPath":"/search');
    expect(serialized).not.toContain("metaTitle");
    expect(serialized).not.toContain("metaDescription");
    expect(serialized).not.toContain("featuredImage");
    expect(serialized).not.toContain("deletedAt");
    expect(serialized).not.toContain("deletedBy");
    expect(serialized).not.toContain("mutationAuthority");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("customer@example.test");
    expect(serialized).not.toContain(ADMIN_COOKIE);
  });

  it("keeps admin_page_search upstream failures fail-closed without leaking upstream bodies", async () => {
    const leak = `raw upstream leak ${ADMIN_COOKIE} admin@example.test +8801712345678`;
    const cases: Array<() => Response> = [
      () => json({ success: false, error: { code: "forbidden", message: leak } }, 403),
      () => json({ success: false, error: { code: "server_error", message: leak } }, 500),
      () => new Response(`not json ${leak}`, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
      () => json({ success: false, error: { code: "invalid", message: leak } }),
      () => json({ success: true, data: { pages: [], message: leak } }),
    ];

    for (const makeResponse of cases) {
      const apiFetch = vi.fn<FetchLike>().mockImplementation(() => Promise.resolve(makeResponse()));
      const { client } = await bootAdmin(apiFetch);

      const result = await client.callTool({
        name: "admin_page_search",
        arguments: { query: "about" },
      });

      expect(apiFetch).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        adminPageSearch: {
          source: { path: "/api/v1/admin/pages" },
          query: {
            query: "about",
            page: 1,
            limit: 5,
            sort: "updatedAt",
            order: "desc",
          },
          pages: [],
          pagination: null,
          limits: {
            maxPages: 10,
            includesTrashed: false,
            includesContent: false,
            includesMetaText: false,
            includesRawImages: false,
            includesDeletedFields: false,
          },
        },
        error: {
          code: "admin_page_unavailable",
        },
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(ADMIN_COOKIE);
      expect(serialized).not.toContain("admin@example.test");
      expect(serialized).not.toContain("+8801712345678");
      expect(serialized).not.toContain("raw upstream leak");
    }
  });

  it("returns a safe admin_page_search tool error when no cookie option is present", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { pages: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } },
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: null,
      userAgent: "vitest-admin-mcp",
    });

    const result = await client.callTool({
      name: "admin_page_search",
      arguments: { query: "about" },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "admin_session_required",
        status: 401,
      },
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("rejects unbounded admin_page_search inputs before API fetches", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { pages: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } },
    });
    const { client } = await bootAdmin(apiFetch);

    await expectValidationToolError(client.callTool({
      name: "admin_page_search",
      arguments: { query: "", limit: 5 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_page_search",
      arguments: { query: "   ", limit: 5 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_page_search",
      arguments: { query: "x".repeat(121), limit: 5 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_page_search",
      arguments: { query: "about", limit: 11 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_page_search",
      arguments: { query: "about", page: 21 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_page_search",
      arguments: {
        query: "about",
        search: "old-field",
        trashed: true,
        includeContent: true,
        includeMeta: true,
        includeDeleted: true,
        content: "<p>must-not-forward</p>",
        featuredImage: "https://cdn.example.test/private.jpg",
        Authorization: "Bearer must-not-forward",
      },
    }));

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("calls admin_order_search through the API binding with fixed search query and compact output", async () => {
    const longUserAgent = `vitest-admin-mcp-${"x".repeat(300)}`;
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        orders: [{
          id: "order_1",
          orderNumber: "ORD-1001",
          code: "SC-1001",
          customerName: "Asha Rahman",
          customerPhone: "+8801712345678",
          customerEmail: "asha@example.test",
          customerPhoneMasked: "+88017****678",
          customerEmailMasked: "a***@example.test",
          totalAmount: 1250,
          currency: "BDT",
          status: "confirmed",
          paymentStatus: "paid",
          paymentMethod: "sslcommerz",
          fulfillmentStatus: "partial",
          createdAt: "2026-07-07T10:30:00.000Z",
          updatedAt: 1783516200,
          itemCount: 3,
          totalQuantity: 5,
          shippingCharge: 80,
          discountAmount: 50,
          city: "dhaka",
          zone: "mirpur",
          area: "section-10",
          cityName: "Dhaka",
          zoneName: "Mirpur",
          areaName: "Section 10",
          addressLine1: "Road 1",
          notes: "leave at desk",
          receiptToken: "chk_secret",
          paymentRecoveryLink: "https://storefront.example.test/payment-recovery?orderId=order_1",
          paymentRecovery: {
            message: "support message must not leak",
            token: "RECOVERY-TOKEN",
            url: "https://storefront.example.test/payment-recovery?token=secret",
          },
          latestShipment: {
            trackingId: "TRACK-SECRET",
            trackingUrl: "https://carrier.example.test/track/TRACK-SECRET",
          },
          items: [{ sku: "SKU-SECRET", name: "Private line item" }],
          skus: ["SKU-SECRET"],
          providerPayload: { raw: "provider payload secret" },
          supportMessages: ["support message must not leak"],
          unknownSecret: "must-not-leak",
        }],
        pagination: {
          page: 2,
          limit: 3,
          total: 9,
          totalPages: 3,
          rawCursor: "must-not-leak",
        },
      },
      rawMessage: `must-not-leak ${ADMIN_COOKIE}`,
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: ADMIN_COOKIE,
      userAgent: longUserAgent,
    });

    const result = await client.callTool({
      name: "admin_order_search",
      arguments: { query: "  ORD-1001  ", limit: 3, page: 2 },
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetchCall(apiFetch);
    const url = new URL(requestUrl(input));
    expect(`${url.origin}${url.pathname}`).toBe("http://api.internal/api/v1/admin/orders");
    expect([...url.searchParams.entries()]).toEqual([
      ["search", "ORD-1001"],
      ["page", "2"],
      ["limit", "3"],
      ["sort", "updatedAt"],
      ["order", "desc"],
    ]);
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Cookie")).toBe(ADMIN_COOKIE);
    expect(headers.get("User-Agent")).toBe(longUserAgent.slice(0, 256));
    expect(headers.get("Authorization")).toBeNull();
    expect([...headers.keys()].sort()).toEqual(["accept", "cookie", "user-agent"]);

    expect(result.isError).toBeUndefined();
    const context = adminOrderSearchContext(result as Record<string, unknown>);
    expect(context).toEqual({
      source: { path: "/api/v1/admin/orders" },
      query: {
        query: "ORD-1001",
        page: 2,
        limit: 3,
        sort: "updatedAt",
        order: "desc",
      },
      orders: [{
        id: "order_1",
        orderNumber: "ORD-1001",
        code: "SC-1001",
        createdAt: "2026-07-07T10:30:00.000Z",
        updatedAt: 1783516200,
        orderStatus: "confirmed",
        paymentStatus: "paid",
        fulfillmentStatus: "partial",
        paymentMethod: "sslcommerz",
        totalAmount: 1250,
        currency: "BDT",
        itemCount: 3,
        customerEmailMasked: "a***@example.test",
        customerPhoneMasked: "+88017****678",
      }],
      pagination: {
        page: 2,
        limit: 3,
        total: 9,
        totalPages: 3,
      },
      limits: {
        maxOrders: 10,
        includesTrashed: false,
        includesAddresses: false,
        includesItems: false,
        includesPaymentRecovery: false,
        includesTracking: false,
      },
    });
    const orders = context.orders as Array<Record<string, unknown>>;
    expect(orders).toHaveLength(1);
    const order = orders[0];
    if (!order) throw new Error("Expected compact admin order");
    expect(Object.keys(order).sort()).toEqual([
      "code",
      "createdAt",
      "currency",
      "customerEmailMasked",
      "customerPhoneMasked",
      "fulfillmentStatus",
      "id",
      "itemCount",
      "orderNumber",
      "orderStatus",
      "paymentMethod",
      "paymentStatus",
      "totalAmount",
      "updatedAt",
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("Asha Rahman");
    expect(serialized).not.toContain("+8801712345678");
    expect(serialized).not.toContain("asha@example.test");
    expect(serialized).not.toContain("Road 1");
    expect(serialized).not.toContain("leave at desk");
    expect(serialized).not.toContain("chk_secret");
    expect(serialized).not.toContain("RECOVERY-TOKEN");
    expect(serialized).not.toContain("payment-recovery");
    expect(serialized).not.toContain("TRACK-SECRET");
    expect(serialized).not.toContain("SKU-SECRET");
    expect(serialized).not.toContain("provider payload secret");
    expect(serialized).not.toContain("support message must not leak");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain(ADMIN_COOKIE);
  });

  it("keeps admin_order_search upstream failures fail-closed without leaking upstream bodies", async () => {
    const leak = `raw upstream leak ${ADMIN_COOKIE} admin@example.test +8801712345678`;
    const cases: Array<() => Response> = [
      () => json({ success: false, error: { code: "forbidden", message: leak } }, 403),
      () => json({ success: false, error: { code: "server_error", message: leak } }, 500),
      () => new Response(`not json ${leak}`, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
      () => json({ success: false, error: { code: "invalid", message: leak } }),
    ];

    for (const makeResponse of cases) {
      const apiFetch = vi.fn<FetchLike>().mockImplementation(() => Promise.resolve(makeResponse()));
      const { client } = await bootAdmin(apiFetch);

      const result = await client.callTool({
        name: "admin_order_search",
        arguments: { query: "ORD-1001" },
      });

      expect(apiFetch).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        adminOrderSearch: {
          source: { path: "/api/v1/admin/orders" },
          query: {
            query: "ORD-1001",
            page: 1,
            limit: 5,
            sort: "updatedAt",
            order: "desc",
          },
          orders: [],
          pagination: null,
          limits: {
            maxOrders: 10,
            includesTrashed: false,
            includesAddresses: false,
            includesItems: false,
            includesPaymentRecovery: false,
            includesTracking: false,
          },
        },
        error: {
          code: "admin_order_unavailable",
        },
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(ADMIN_COOKIE);
      expect(serialized).not.toContain("admin@example.test");
      expect(serialized).not.toContain("+8801712345678");
      expect(serialized).not.toContain("raw upstream leak");
    }
  });

  it("returns a safe admin_order_search tool error when no cookie option is present", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { orders: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } },
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: null,
      userAgent: "vitest-admin-mcp",
    });

    const result = await client.callTool({
      name: "admin_order_search",
      arguments: { query: "ORD-1001" },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "admin_session_required",
        status: 401,
      },
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("rejects unbounded admin_order_search inputs before API fetches", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { orders: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } },
    });
    const { client } = await bootAdmin(apiFetch);

    await expectValidationToolError(client.callTool({
      name: "admin_order_search",
      arguments: { query: "", limit: 5 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_order_search",
      arguments: { query: "x".repeat(81), limit: 5 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_order_search",
      arguments: { query: "ORD-1001", limit: 11 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_order_search",
      arguments: { query: "ORD-1001", page: 21 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_order_search",
      arguments: {
        query: "ORD-1001",
        status: "paid",
        includeItems: true,
        includeAddresses: true,
        Authorization: "Bearer must-not-forward",
        receiptToken: "chk_secret",
        paymentRecoveryLink: "https://storefront.example.test/payment-recovery?token=secret",
      },
    }));

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("calls admin_media_search through the API binding with fixed search query and compact output", async () => {
    const longUserAgent = `vitest-admin-mcp-${"x".repeat(300)}`;
    const overlongMediaUrl = `https://cdn.example.test/${"x".repeat(1000)}`;
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        files: [{
          id: "media_1",
          filename: "summer-shoes.jpg",
          url: "https://cdn.example.test/media/summer-shoes.jpg",
          mimeType: "image/jpeg",
          size: 123456,
          altText: "Summer shoes",
          width: 1200,
          height: 800,
          folderId: "folder_summer",
          createdAt: "2026-07-07T10:00:00.000Z",
          updatedAt: "2026-07-07T10:30:00.000Z",
          deletedAt: "2026-07-08T00:00:00.000Z",
          deletedBy: "admin_2",
          storageKey: "private/storage/key",
          checksum: "sha256-secret",
          uploadMetadata: { ip: "127.0.0.1", userAgent: "must-not-leak" },
          providerError: `raw provider leak ${ADMIN_COOKIE}`,
          mutationUrl: "https://cdn.example.test/delete/media_1",
        }, {
          id: "media_2",
          filename: "local-banner.png",
          url: "/uploads/local-banner.png",
          mimeType: "image/png",
          size: 0,
          width: 0,
          height: 0,
          folderId: "folder_summer",
          createdAt: 1783516200,
          updatedAt: "2026-07-07T11:30:00.000Z",
        }, {
          id: "media_unsafe",
          filename: "unsafe.jpg",
          url: "https://user:pass@cdn.example.test/media/unsafe.jpg",
          mimeType: "image/jpeg",
          size: 50,
          createdAt: "2026-07-07T12:00:00.000Z",
          updatedAt: "2026-07-07T12:30:00.000Z",
        }, {
          id: "media_query",
          filename: "query.jpg",
          url: "https://cdn.example.test/media/query.jpg?token=secret",
          mimeType: "image/jpeg",
          size: 60,
        }, {
          id: "media_protocol_relative",
          filename: "protocol-relative.jpg",
          url: "//cdn.example.test/media/protocol-relative.jpg",
          mimeType: "image/jpeg",
          size: 70,
        }, {
          id: "media_long_url",
          filename: "long-url.jpg",
          url: overlongMediaUrl,
          mimeType: "image/jpeg",
          size: 80,
        }],
        pagination: {
          page: 2,
          limit: 3,
          total: 9,
          totalPages: 3,
          cursor: "must-not-leak",
        },
      },
      rawMessage: `must-not-leak ${ADMIN_COOKIE}`,
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: ADMIN_COOKIE,
      userAgent: longUserAgent,
    });

    const result = await client.callTool({
      name: "admin_media_search",
      arguments: {
        query: "  summer shoes  ",
        limit: 3,
        page: 2,
        folderId: "  folder_summer  ",
        mimeType: "  image/jpeg  ",
      },
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetchCall(apiFetch);
    const url = new URL(requestUrl(input));
    expect(`${url.origin}${url.pathname}`).toBe("http://api.internal/api/v1/admin/media");
    expect([...url.searchParams.entries()]).toEqual([
      ["page", "2"],
      ["limit", "3"],
      ["search", "summer shoes"],
      ["folderId", "folder_summer"],
      ["mimeType", "image/jpeg"],
      ["sortBy", "createdAt"],
      ["sortOrder", "desc"],
    ]);
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Cookie")).toBe(ADMIN_COOKIE);
    expect(headers.get("User-Agent")).toBe(longUserAgent.slice(0, 256));
    expect(headers.get("Authorization")).toBeNull();
    expect([...headers.keys()].sort()).toEqual(["accept", "cookie", "user-agent"]);

    expect(result.isError).toBeUndefined();
    const context = adminMediaSearchContext(result as Record<string, unknown>);
    expect(context).toEqual({
      source: { path: "/api/v1/admin/media" },
      query: {
        page: 2,
        limit: 3,
        sortBy: "createdAt",
        sortOrder: "desc",
        query: "summer shoes",
        folderId: "folder_summer",
        mimeType: "image/jpeg",
      },
      files: [{
        id: "media_1",
        filename: "summer-shoes.jpg",
        url: "https://cdn.example.test/media/summer-shoes.jpg",
        mimeType: "image/jpeg",
        size: 123456,
        altText: "Summer shoes",
        width: 1200,
        height: 800,
        folderId: "folder_summer",
        createdAt: "2026-07-07T10:00:00.000Z",
        updatedAt: "2026-07-07T10:30:00.000Z",
      }, {
        id: "media_2",
        filename: "local-banner.png",
        url: "/uploads/local-banner.png",
        mimeType: "image/png",
        size: 0,
        width: 0,
        height: 0,
        folderId: "folder_summer",
        createdAt: 1783516200,
        updatedAt: "2026-07-07T11:30:00.000Z",
      }, {
        id: "media_unsafe",
        filename: "unsafe.jpg",
        mimeType: "image/jpeg",
        size: 50,
        createdAt: "2026-07-07T12:00:00.000Z",
        updatedAt: "2026-07-07T12:30:00.000Z",
      }, {
        id: "media_query",
        filename: "query.jpg",
        mimeType: "image/jpeg",
        size: 60,
      }, {
        id: "media_protocol_relative",
        filename: "protocol-relative.jpg",
        mimeType: "image/jpeg",
        size: 70,
      }, {
        id: "media_long_url",
        filename: "long-url.jpg",
        mimeType: "image/jpeg",
        size: 80,
      }],
      pagination: {
        page: 2,
        limit: 3,
        total: 9,
        totalPages: 3,
      },
      limits: {
        maxFiles: 10,
        includesDeletedFields: false,
        includesStorageKeys: false,
        includesUploadMetadata: false,
        includesMutationAuthority: false,
      },
    });
    const files = context.files as Array<Record<string, unknown>>;
    expect(files).toHaveLength(6);
    const file = files[0];
    if (!file) throw new Error("Expected compact admin media file");
    expect(Object.keys(file).sort()).toEqual([
      "altText",
      "createdAt",
      "filename",
      "folderId",
      "height",
      "id",
      "mimeType",
      "size",
      "updatedAt",
      "url",
      "width",
    ]);
    expect(files[2]).not.toHaveProperty("url");
    expect(files[3]).not.toHaveProperty("url");
    expect(files[4]).not.toHaveProperty("url");
    expect(files[5]).not.toHaveProperty("url");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("deletedAt");
    expect(serialized).not.toContain("deletedBy");
    expect(serialized).not.toContain("private/storage/key");
    expect(serialized).not.toContain("sha256-secret");
    expect(serialized).not.toContain("uploadMetadata");
    expect(serialized).not.toContain("raw provider leak");
    expect(serialized).not.toContain("delete/media_1");
    expect(serialized).not.toContain("user:pass");
    expect(serialized).not.toContain("?token=secret");
    expect(serialized).not.toContain("//cdn.example.test/media/protocol-relative.jpg");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain(ADMIN_COOKIE);
  });

  it("allows admin_media_search latest listing without a query while keeping limits bounded", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        files: Array.from({ length: 11 }, (_, index) => ({
          id: `media_${index}`,
          filename: `latest-${index}.jpg`,
          url: `/uploads/latest-${index}.jpg`,
          mimeType: "image/jpeg",
          size: index,
        })),
        pagination: {
          page: 1,
          limit: 10,
          total: 11,
          totalPages: 2,
        },
      },
    });
    const { client } = await bootAdmin(apiFetch);

    const result = await client.callTool({
      name: "admin_media_search",
      arguments: { limit: 10 },
    });

    const [input] = fetchCall(apiFetch);
    const url = new URL(requestUrl(input));
    expect([...url.searchParams.entries()]).toEqual([
      ["page", "1"],
      ["limit", "10"],
      ["sortBy", "createdAt"],
      ["sortOrder", "desc"],
    ]);
    expect(url.searchParams.has("search")).toBe(false);

    const context = adminMediaSearchContext(result as Record<string, unknown>);
    expect(context.query).toEqual({
      page: 1,
      limit: 10,
      sortBy: "createdAt",
      sortOrder: "desc",
    });
    expect(context.files).toHaveLength(10);
    expect(context.limits).toMatchObject({ maxFiles: 10 });
  });

  it("returns a safe admin_media_search tool error when no cookie option is present", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { files: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } },
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: null,
      userAgent: "vitest-admin-mcp",
    });

    const result = await client.callTool({
      name: "admin_media_search",
      arguments: { query: "summer" },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "admin_session_required",
        status: 401,
      },
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("rejects unbounded admin_media_search inputs before API fetches", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { files: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } },
    });
    const { client } = await bootAdmin(apiFetch);

    await expectValidationToolError(client.callTool({
      name: "admin_media_search",
      arguments: { query: "x".repeat(121), limit: 5 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_media_search",
      arguments: { limit: 11 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_media_search",
      arguments: { page: 21 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_media_search",
      arguments: { folderId: "x".repeat(161) },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_media_search",
      arguments: { mimeType: "x".repeat(81) },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_media_search",
      arguments: {
        query: "summer",
        search: "old-field",
        sortBy: "filename",
        sortOrder: "asc",
        upload: true,
        delete: true,
        moveToFolderId: "folder_other",
        filters: { width: 1200 },
        includeDeleted: true,
        storageKey: "private/storage/key",
        Authorization: "Bearer must-not-forward",
      },
    }));

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("keeps admin_media_search upstream failures fail-closed without leaking upstream bodies", async () => {
    const leak = `raw upstream leak ${ADMIN_COOKIE} admin@example.test +8801712345678`;
    const cases: Array<() => Response> = [
      () => json({ success: false, error: { code: "forbidden", message: leak } }, 403),
      () => json({ success: false, error: { code: "server_error", message: leak } }, 500),
      () => new Response(`not json ${leak}`, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
      () => json({ success: false, error: { code: "invalid", message: leak } }),
      () => json({ success: true, data: { files: [], message: leak } }),
    ];

    for (const makeResponse of cases) {
      const apiFetch = vi.fn<FetchLike>().mockImplementation(() => Promise.resolve(makeResponse()));
      const { client } = await bootAdmin(apiFetch);

      const result = await client.callTool({
        name: "admin_media_search",
        arguments: { query: "summer" },
      });

      expect(apiFetch).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        adminMediaSearch: {
          source: { path: "/api/v1/admin/media" },
          query: {
            page: 1,
            limit: 5,
            sortBy: "createdAt",
            sortOrder: "desc",
            query: "summer",
          },
          files: [],
          pagination: null,
          limits: {
            maxFiles: 10,
            includesDeletedFields: false,
            includesStorageKeys: false,
            includesUploadMetadata: false,
            includesMutationAuthority: false,
          },
        },
        error: {
          code: "admin_media_unavailable",
        },
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(ADMIN_COOKIE);
      expect(serialized).not.toContain("admin@example.test");
      expect(serialized).not.toContain("+8801712345678");
      expect(serialized).not.toContain("raw upstream leak");
    }
  });

  it("calls admin_inventory_lookup through the API binding with fixed variant query and compact output", async () => {
    const longUserAgent = `vitest-admin-mcp-${"x".repeat(300)}`;
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        variants: [{
          id: "var_1",
          productId: "prod_1",
          productName: "Running Shoes",
          sku: "RUN-42",
          size: "42",
          color: "Black",
          stock: 20,
          reservedStock: 4,
          available: 16,
          lowStockThreshold: 5,
          price: 1200,
          version: 7,
          barcode: "BARCODE-SECRET",
          barcodeType: "code128",
          movements: [{ id: "move_secret" }],
          alerts: [{ id: "alert_secret" }],
          orderId: "order_secret",
          notes: "private operator note",
          createdBy: "admin_private",
          mutationUrl: "https://api.example.test/adjust",
          unknownSecret: "must-not-leak",
        }, {
          id: "var_2",
          productId: "prod_2",
          productName: "Plain Tee",
          sku: "TEE-DEFAULT",
          size: null,
          color: null,
          stock: 0,
          reservedStock: 0,
          available: 0,
          lowStockThreshold: 2,
        }],
        pagination: {
          page: 2,
          limit: 3,
          total: 12,
          totalPages: 4,
          cursor: "must-not-leak",
        },
        stats: {
          totalVariants: 12,
          totalOnHand: 100,
          totalReserved: 15,
          totalAvailable: 85,
          outOfStockCount: 2,
          lowStockCount: 3,
          privateCostValue: "must-not-leak",
        },
      },
      rawMessage: `raw upstream leak ${ADMIN_COOKIE}`,
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: ADMIN_COOKIE,
      userAgent: longUserAgent,
    });

    const result = await client.callTool({
      name: "admin_inventory_lookup",
      arguments: {
        query: "  running shoes  ",
        limit: 3,
        page: 2,
        status: "low",
        sort: "sku",
        order: "desc",
      },
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetchCall(apiFetch);
    const url = new URL(requestUrl(input));
    expect(`${url.origin}${url.pathname}`).toBe("http://api.internal/api/v1/admin/inventory");
    expect([...url.searchParams.entries()]).toEqual([
      ["section", "variants"],
      ["search", "running shoes"],
      ["page", "2"],
      ["limit", "3"],
      ["status", "low"],
      ["sort", "sku"],
      ["order", "desc"],
    ]);
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Cookie")).toBe(ADMIN_COOKIE);
    expect(headers.get("User-Agent")).toBe(longUserAgent.slice(0, 256));
    expect(headers.get("Authorization")).toBeNull();
    expect([...headers.keys()].sort()).toEqual(["accept", "cookie", "user-agent"]);

    expect(result.isError).toBeUndefined();
    const context = adminInventoryLookupContext(result as Record<string, unknown>);
    expect(context).toEqual({
      source: { path: "/api/v1/admin/inventory" },
      query: {
        section: "variants",
        page: 2,
        limit: 3,
        status: "low",
        sort: "sku",
        order: "desc",
        query: "running shoes",
      },
      variants: [{
        id: "var_1",
        productId: "prod_1",
        productName: "Running Shoes",
        sku: "RUN-42",
        size: "42",
        color: "Black",
        stock: 20,
        reservedStock: 4,
        available: 16,
        lowStockThreshold: 5,
      }, {
        id: "var_2",
        productId: "prod_2",
        productName: "Plain Tee",
        sku: "TEE-DEFAULT",
        stock: 0,
        reservedStock: 0,
        available: 0,
        lowStockThreshold: 2,
      }],
      pagination: {
        page: 2,
        limit: 3,
        total: 12,
        totalPages: 4,
      },
      stats: {
        totalVariants: 12,
        totalOnHand: 100,
        totalReserved: 15,
        totalAvailable: 85,
        outOfStockCount: 2,
        lowStockCount: 3,
      },
      limits: {
        maxVariants: 10,
        section: "variants",
        includesMovements: false,
        includesAlerts: false,
        includesBarcode: false,
        includesPrices: false,
        includesVersion: false,
        canMutateStock: false,
      },
    });
    const variants = context.variants as Array<Record<string, unknown>>;
    expect(variants).toHaveLength(2);
    const variant = variants[0];
    if (!variant) throw new Error("Expected compact inventory variant");
    expect(Object.keys(variant).sort()).toEqual([
      "available",
      "color",
      "id",
      "lowStockThreshold",
      "productId",
      "productName",
      "reservedStock",
      "size",
      "sku",
      "stock",
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("1200");
    expect(serialized).not.toContain("BARCODE-SECRET");
    expect(serialized).not.toContain("code128");
    expect(serialized).not.toContain("move_secret");
    expect(serialized).not.toContain("alert_secret");
    expect(serialized).not.toContain("order_secret");
    expect(serialized).not.toContain("private operator note");
    expect(serialized).not.toContain("admin_private");
    expect(serialized).not.toContain("https://api.example.test/adjust");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("raw upstream leak");
    expect(serialized).not.toContain(ADMIN_COOKIE);
  });

  it("allows admin_inventory_lookup latest listing without a query while keeping defaults bounded", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        variants: [{
          id: "var_latest",
          productId: "prod_latest",
          productName: "Latest Variant",
          sku: "LATEST",
          stock: 6,
          reservedStock: 1,
          available: 5,
          lowStockThreshold: 2,
        }],
        pagination: {
          page: 1,
          limit: 5,
          total: 1,
          totalPages: 1,
        },
        stats: {
          totalVariants: 1,
          totalOnHand: 6,
          totalReserved: 1,
          totalAvailable: 5,
          outOfStockCount: 0,
          lowStockCount: 0,
        },
      },
    });
    const { client } = await bootAdmin(apiFetch);

    const result = await client.callTool({
      name: "admin_inventory_lookup",
      arguments: {},
    });

    const [input] = fetchCall(apiFetch);
    const url = new URL(requestUrl(input));
    expect([...url.searchParams.entries()]).toEqual([
      ["section", "variants"],
      ["page", "1"],
      ["limit", "5"],
      ["status", "all"],
      ["sort", "available"],
      ["order", "asc"],
    ]);
    expect(url.searchParams.has("search")).toBe(false);

    const context = adminInventoryLookupContext(result as Record<string, unknown>);
    expect(context.query).toEqual({
      section: "variants",
      page: 1,
      limit: 5,
      status: "all",
      sort: "available",
      order: "asc",
    });
    expect(context.variants).toHaveLength(1);
    expect(context.limits).toMatchObject({ maxVariants: 10, section: "variants" });
  });

  it("returns a safe admin_inventory_lookup tool error when no cookie option is present", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        variants: [],
        pagination: { page: 1, limit: 5, total: 0, totalPages: 0 },
        stats: {
          totalVariants: 0,
          totalOnHand: 0,
          totalReserved: 0,
          totalAvailable: 0,
          outOfStockCount: 0,
          lowStockCount: 0,
        },
      },
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: null,
      userAgent: "vitest-admin-mcp",
    });

    const result = await client.callTool({
      name: "admin_inventory_lookup",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "admin_session_required",
        status: 401,
      },
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("rejects unbounded admin_inventory_lookup inputs before API fetches", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        variants: [],
        pagination: { page: 1, limit: 5, total: 0, totalPages: 0 },
        stats: {
          totalVariants: 0,
          totalOnHand: 0,
          totalReserved: 0,
          totalAvailable: 0,
          outOfStockCount: 0,
          lowStockCount: 0,
        },
      },
    });
    const { client } = await bootAdmin(apiFetch);

    await expectValidationToolError(client.callTool({
      name: "admin_inventory_lookup",
      arguments: { query: "x".repeat(121), limit: 5 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_inventory_lookup",
      arguments: { limit: 11 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_inventory_lookup",
      arguments: { page: 21 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_inventory_lookup",
      arguments: { status: "damaged" },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_inventory_lookup",
      arguments: { sort: "updatedAt" },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_inventory_lookup",
      arguments: { order: "newest" },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_inventory_lookup",
      arguments: {
        query: "RUN",
        section: "movements",
        includeAlerts: true,
        includeMovements: true,
        adjust: true,
        setStock: 10,
        barcode: "BARCODE-SECRET",
        price: 1200,
        Authorization: "Bearer must-not-forward",
      },
    }));

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("keeps admin_inventory_lookup upstream failures fail-closed without leaking upstream bodies", async () => {
    const leak = `raw upstream leak ${ADMIN_COOKIE} admin@example.test +8801712345678`;
    const cases: Array<() => Response> = [
      () => json({ success: false, error: { code: "forbidden", message: leak } }, 403),
      () => json({ success: false, error: { code: "server_error", message: leak } }, 500),
      () => new Response(`not json ${leak}`, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
      () => json({ success: false, error: { code: "invalid", message: leak } }),
      () => json({
        success: true,
        data: {
          pagination: { page: 1, limit: 5, total: 0, totalPages: 0 },
          stats: {
            totalVariants: 0,
            totalOnHand: 0,
            totalReserved: 0,
            totalAvailable: 0,
            outOfStockCount: 0,
            lowStockCount: 0,
          },
          message: leak,
        },
      }),
      () => json({
        success: true,
        data: {
          variants: [],
          stats: {
            totalVariants: 0,
            totalOnHand: 0,
            totalReserved: 0,
            totalAvailable: 0,
            outOfStockCount: 0,
            lowStockCount: 0,
          },
          message: leak,
        },
      }),
      () => json({
        success: true,
        data: {
          variants: [],
          pagination: { page: 1, limit: 5, total: 0, totalPages: 0 },
          message: leak,
        },
      }),
      () => json({
        success: true,
        data: {
          variants: [],
          pagination: { page: 1, limit: 5, total: 0, totalPages: 0 },
          stats: {},
          message: leak,
        },
      }),
      () => json({
        success: true,
        data: {
          variants: [],
          pagination: { page: 1, limit: 5, total: 0, totalPages: 0 },
          stats: { totalVariants: "0" },
          message: leak,
        },
      }),
    ];

    for (const makeResponse of cases) {
      const apiFetch = vi.fn<FetchLike>().mockImplementation(() => Promise.resolve(makeResponse()));
      const { client } = await bootAdmin(apiFetch);

      const result = await client.callTool({
        name: "admin_inventory_lookup",
        arguments: { query: "RUN" },
      });

      expect(apiFetch).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        adminInventoryLookup: {
          source: { path: "/api/v1/admin/inventory" },
          query: {
            section: "variants",
            page: 1,
            limit: 5,
            status: "all",
            sort: "available",
            order: "asc",
            query: "RUN",
          },
          variants: [],
          pagination: null,
          stats: null,
          limits: {
            maxVariants: 10,
            section: "variants",
            includesMovements: false,
            includesAlerts: false,
            includesBarcode: false,
            includesPrices: false,
            includesVersion: false,
            canMutateStock: false,
          },
        },
        error: {
          code: "admin_inventory_unavailable",
          message: "Admin inventory is temporarily unavailable.",
        },
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(ADMIN_COOKIE);
      expect(serialized).not.toContain("admin@example.test");
      expect(serialized).not.toContain("+8801712345678");
      expect(serialized).not.toContain("raw upstream leak");
    }
  });

  it("slices admin_inventory_lookup variants to the documented maximum", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        variants: Array.from({ length: 12 }, (_, index) => ({
          id: `var_${index}`,
          productId: `prod_${index}`,
          productName: `Product ${index}`,
          sku: `SKU-${index}`,
          stock: index,
          reservedStock: 0,
          available: index,
          lowStockThreshold: 2,
        })),
        pagination: {
          page: 1,
          limit: 10,
          total: 12,
          totalPages: 2,
        },
        stats: {
          totalVariants: 12,
          totalOnHand: 66,
          totalReserved: 0,
          totalAvailable: 66,
          outOfStockCount: 1,
          lowStockCount: 2,
        },
      },
    });
    const { client } = await bootAdmin(apiFetch);

    const result = await client.callTool({
      name: "admin_inventory_lookup",
      arguments: { limit: 10 },
    });

    const context = adminInventoryLookupContext(result as Record<string, unknown>);
    expect(context.variants).toHaveLength(10);
    expect(context.limits).toMatchObject({ maxVariants: 10 });
  });

  it("calls admin_product_search through the API binding with fixed search query and compact output", async () => {
    const longUserAgent = `vitest-admin-mcp-${"x".repeat(300)}`;
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        products: [{
          id: "prod_1",
          name: "Khaki Shoes",
          slug: "khaki-shoes",
          isActive: true,
          category: { name: "Shoes", description: "category-private" },
          variantCount: 2,
          imageCount: 4,
          updatedAt: "2026-07-07T10:30:00.000Z",
          sku: "SKU-SECRET",
          price: 1200,
          discountType: "flat",
          discountAmount: 100,
          discountPercentage: 5,
          primaryImage: "https://cdn.example.test/private.jpg",
          deletedAt: "2026-07-08T00:00:00.000Z",
          stock: 99,
          barcode: "BARCODE-SECRET",
          description: "raw product description",
          internalOnly: "must-not-leak",
        }],
        pagination: {
          page: 2,
          limit: 3,
          total: 9,
          totalPages: 3,
          rawCursor: "must-not-leak",
        },
      },
      rawMessage: `must-not-leak ${ADMIN_COOKIE}`,
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: ADMIN_COOKIE,
      userAgent: longUserAgent,
    });

    const result = await client.callTool({
      name: "admin_product_search",
      arguments: { query: "  khaki shoes  ", limit: 3, page: 2 },
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetchCall(apiFetch);
    const url = new URL(requestUrl(input));
    expect(`${url.origin}${url.pathname}`).toBe("http://api.internal/api/v1/admin/products");
    expect([...url.searchParams.entries()]).toEqual([
      ["search", "khaki shoes"],
      ["page", "2"],
      ["limit", "3"],
      ["sort", "updatedAt"],
      ["order", "desc"],
    ]);
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Cookie")).toBe(ADMIN_COOKIE);
    expect(headers.get("User-Agent")).toBe(longUserAgent.slice(0, 256));
    expect(headers.get("Authorization")).toBeNull();
    expect([...headers.keys()].sort()).toEqual(["accept", "cookie", "user-agent"]);

    expect(result.isError).toBeUndefined();
    const context = adminProductSearchContext(result as Record<string, unknown>);
    expect(context).toEqual({
      source: { path: "/api/v1/admin/products" },
      query: {
        query: "khaki shoes",
        page: 2,
        limit: 3,
        sort: "updatedAt",
        order: "desc",
      },
      products: [{
        id: "prod_1",
        name: "Khaki Shoes",
        slug: "khaki-shoes",
        isActive: true,
        categoryName: "Shoes",
        variantCount: 2,
        imageCount: 4,
        updatedAt: "2026-07-07T10:30:00.000Z",
      }],
      pagination: {
        page: 2,
        limit: 3,
        total: 9,
        totalPages: 3,
      },
      limits: {
        maxProducts: 10,
        includesTrashed: false,
        includesStock: false,
      },
    });
    const products = context.products as Array<Record<string, unknown>>;
    expect(products).toHaveLength(1);
    const product = products[0];
    if (!product) throw new Error("Expected compact admin product");
    expect(Object.keys(product).sort()).toEqual([
      "categoryName",
      "id",
      "imageCount",
      "isActive",
      "name",
      "slug",
      "updatedAt",
      "variantCount",
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("SKU-SECRET");
    expect(serialized).not.toContain("BARCODE-SECRET");
    expect(serialized).not.toContain("raw product description");
    expect(serialized).not.toContain("https://cdn.example.test/private.jpg");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain(ADMIN_COOKIE);
  });

  it("keeps admin_product_search upstream failures fail-closed without leaking upstream bodies", async () => {
    const leak = `raw upstream leak ${ADMIN_COOKIE} admin@example.test`;
    const cases: Array<() => Response> = [
      () => json({ success: false, error: { code: "forbidden", message: leak } }, 403),
      () => json({ success: false, error: { code: "server_error", message: leak } }, 500),
      () => new Response(`not json ${leak}`, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
      () => json({ success: false, error: { code: "invalid", message: leak } }),
    ];

    for (const makeResponse of cases) {
      const apiFetch = vi.fn<FetchLike>().mockImplementation(() => Promise.resolve(makeResponse()));
      const { client } = await bootAdmin(apiFetch);

      const result = await client.callTool({
        name: "admin_product_search",
        arguments: { query: "khaki" },
      });

      expect(apiFetch).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        adminProductSearch: {
          source: { path: "/api/v1/admin/products" },
          query: {
            query: "khaki",
            page: 1,
            limit: 5,
            sort: "updatedAt",
            order: "desc",
          },
          products: [],
          pagination: null,
          limits: {
            maxProducts: 10,
            includesTrashed: false,
            includesStock: false,
          },
        },
        error: {
          code: "admin_product_unavailable",
        },
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(ADMIN_COOKIE);
      expect(serialized).not.toContain("admin@example.test");
      expect(serialized).not.toContain("raw upstream leak");
    }
  });

  it("returns a safe admin_product_search tool error when no cookie option is present", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { products: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } },
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: null,
      userAgent: "vitest-admin-mcp",
    });

    const result = await client.callTool({
      name: "admin_product_search",
      arguments: { query: "khaki" },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "admin_session_required",
        status: 401,
      },
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("rejects unbounded admin_product_search inputs before API fetches", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { products: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } },
    });
    const { client } = await bootAdmin(apiFetch);

    await expectValidationToolError(client.callTool({
      name: "admin_product_search",
      arguments: { query: "", limit: 5 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_product_search",
      arguments: { query: "x".repeat(121), limit: 5 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_product_search",
      arguments: { query: "khaki", limit: 11 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_product_search",
      arguments: { query: "khaki", page: 21 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_product_search",
      arguments: {
        query: "khaki",
        search: "old-field",
        categoryId: "cat_1",
        includeTrashed: true,
        Authorization: "Bearer must-not-forward",
        receiptToken: "chk_secret",
      },
    }));

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("bounds admin_navigation_context output for superadmins and drops unknown upstream fields", async () => {
    const apiFetch = mockJsonFetch(adminPermissionsBody());
    const { client } = await bootAdmin(apiFetch, {
      cookie: ADMIN_COOKIE,
      userAgent: "vitest-admin-mcp",
      permissionsBody: adminPermissionsBody({
        isSuperAdmin: true,
        permissions: Array.from({ length: 200 }, (_, index) => `synthetic.${index}`),
        email: "admin@example.test",
        providerCredentials: "must-not-leak",
      }),
    });

    const result = await client.callTool({
      name: "admin_navigation_context",
      arguments: {},
    });
    const context = adminNavigationContext(result as Record<string, unknown>);

    expect(result.isError).toBeUndefined();
    expect(adminNavigationPaths(context)).toHaveLength(24);
    expect(context).toMatchObject({
      defaultPath: "/admin",
      limits: {
        maxPages: 24,
        returnedPages: 24,
        catalogPages: 24,
        includesDynamicRoutes: false,
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("admin@example.test");
    expect(serialized).not.toContain("must-not-leak");
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
