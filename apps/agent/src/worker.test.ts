import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AGENT_PROFILE_URL,
  UCP_VERSION,
  createAgentWorker,
  createStorefrontCatalogMcpServer,
} from "./worker";
import type { FetchLike } from "./worker";

const TEST_ENV: Env = {
  STOREFRONT_URL: "https://storefront.example.test",
  AGENT_PROFILE_URL: DEFAULT_AGENT_PROFILE_URL,
  AGENT_NAME: "test-catalog-agent",
  AGENT_VERSION: "0.1.0-test",
};

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

interface BootedClient {
  client: Client;
  server: McpServer;
}

const openClients: BootedClient[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function boot(fetchImpl: FetchLike = vi.fn().mockResolvedValue(json({ ucp: { status: "success" } }))) {
  const server = createStorefrontCatalogMcpServer(TEST_ENV, { fetchImpl });
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
      TEST_ENV,
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
      TEST_ENV,
      createExecutionContext(),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      success: false,
      error: "not_found",
    });
  });
});
