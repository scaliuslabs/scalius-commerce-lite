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
