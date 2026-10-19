// @vitest-environment node
// Acceptance (c): `/ucp/mcp` lists exactly three read-only tools, and
// search_catalog answers with the REST route's exact bytes.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFeedProducts: vi.fn(),
  getLayoutData: vi.fn(),
}));

vi.mock("@/lib/api/products", () => ({ getFeedProducts: mocks.getFeedProducts }));
vi.mock("@/lib/api/storefront", () => ({ getLayoutData: mocks.getLayoutData }));
vi.mock("@/lib/sitemap-utils", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sitemap-utils")>("@/lib/sitemap-utils");
  return { ...actual, getBaseUrl: () => "https://storefront.example.test" };
});

import { POST as mcpPost, GET as mcpGet } from "../../pages/ucp/mcp";
import { POST as restSearch } from "../../pages/ucp/catalog/search";
import { POST as restProduct } from "../../pages/ucp/catalog/product";
import { ucpFeedPage, ucpFeedProduct } from "./ucp-fixtures.testing";
import { ucpSchemaErrors } from "./ucp-schema.testing";

const AGENT = "https://agent.example.test/.well-known/ucp";
let nextId = 1;

function rpc(method: string, params?: unknown, headers: HeadersInit = {}) {
  return new Request("https://storefront.example.test/ucp/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params === undefined ? {} : { params }) }),
  });
}

async function call(method: string, params?: unknown, headers?: HeadersInit) {
  const response = await mcpPost({ request: rpc(method, params, headers) } as never);
  return { response, json: await response.json() };
}

function toolCall(name: string, catalog: unknown, profile: unknown = AGENT) {
  return call("tools/call", { name, arguments: { meta: { "ucp-agent": { profile } }, catalog } });
}

describe("UCP MCP binding", () => {
  beforeEach(() => {
    mocks.getFeedProducts.mockReset();
    mocks.getLayoutData.mockReset();
    mocks.getLayoutData.mockResolvedValue({ currency: { code: "BDT", decimalPlaces: 2, priceIncrementMinor: 100 } });
  });

  it("lists exactly the three read-only catalog tools", async () => {
    const { response, json } = await call("tools/list");

    expect(response.status).toBe(200);
    expect(json.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "search_catalog",
      "lookup_catalog",
      "get_product",
    ]);
    for (const tool of json.result.tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
      expect(tool.inputSchema.required).toEqual(["meta", "catalog"]);
    }
    expect(json.result).toMatchObject({ resultType: "complete", cacheScope: "public" });
  });

  it("answers search_catalog with the REST search body, byte for byte", async () => {
    const product = ucpFeedProduct({ rating: { average: 4.5, count: 3 } });
    mocks.getFeedProducts.mockImplementation(async () => ucpFeedPage([product]));
    const catalog = { query: "khaki", pagination: { limit: 5 } };

    const rest = await restSearch({
      request: new Request("https://storefront.example.test/ucp/catalog/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "UCP-Agent": `profile="${AGENT}"` },
        body: JSON.stringify(catalog),
      }),
    } as never);
    const restText = await rest.text();
    const { json } = await toolCall("search_catalog", catalog);

    expect(rest.status).toBe(200);
    expect(json.result.content).toEqual([{ type: "text", text: restText }]);
    expect(JSON.stringify(json.result.structuredContent)).toBe(restText);
    expect(JSON.stringify(json.result.structuredContent.products)).toBe(JSON.stringify(JSON.parse(restText).products));
    expect(json.result.structuredContent.products).toHaveLength(1);
    expect(ucpSchemaErrors("shopping/catalog_search.json#/$defs/search_response", json.result.structuredContent)).toEqual([]);
  });

  it("answers get_product not_found as a result, like the REST route", async () => {
    mocks.getFeedProducts.mockResolvedValue(ucpFeedPage([]));
    const rest = await restProduct({
      request: new Request("https://storefront.example.test/ucp/catalog/product", {
        method: "POST",
        headers: { "Content-Type": "application/json", "UCP-Agent": `profile="${AGENT}"` },
        body: JSON.stringify({ id: "missing" }),
      }),
    } as never);
    const { json } = await toolCall("get_product", { id: "missing" });

    expect(json.result.structuredContent).toEqual(await rest.json());
    expect(json.result.structuredContent.messages[0]).toMatchObject({ code: "not_found", severity: "unrecoverable" });
  });

  it("requires the platform profile in meta", async () => {
    const { json } = await toolCall("search_catalog", { query: "khaki" }, "http://agent.example.test/profile");

    expect(json.error.code).toBe(-32001);
    expect(json.error.data.code).toBe("invalid_profile_url");
    expect(mocks.getFeedProducts).not.toHaveBeenCalled();
  });

  it("answers an oversized lookup with invalid params before any read", async () => {
    const ids = Array.from({ length: 26 }, (_, index) => `SKU-${index}`);
    const { json } = await toolCall("lookup_catalog", { ids });

    expect(json.error.code).toBe(-32602);
    expect(mocks.getLayoutData).not.toHaveBeenCalled();
  });

  it("answers invalid catalog input with invalid params carrying the UCP messages", async () => {
    const { json } = await toolCall("search_catalog", {});

    expect(json.error.code).toBe(-32602);
    expect(json.error.data.messages[0].code).toBe("request_invalid");
  });

  it("passes a temporarily unavailable catalog on as HTTP 503", async () => {
    mocks.getLayoutData.mockResolvedValue(null);
    const { response, json } = await toolCall("search_catalog", { query: "khaki" });

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(json.error).toMatchObject({ code: -32000, data: { retry_after: 30 } });
  });

  it("negotiates 2025-era clients through initialize and 2026-07-28 ones through server/discover", async () => {
    const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.json.result).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "scalius-ucp-catalog" },
    });

    const discover = await call("server/discover", { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } });
    expect(discover.json.result.supportedVersions).toContain("2026-07-28");

    const unsupported = await call("tools/list", undefined, { "MCP-Protocol-Version": "1999-01-01" });
    expect(unsupported.response.status).toBe(400);
    expect(unsupported.json.error.code).toBe(-32022);
  });

  it("accepts notifications without a body and refuses what it does not serve", async () => {
    const notification = await mcpPost({
      request: new Request("https://storefront.example.test/ucp/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      }),
    } as never);
    expect(notification.status).toBe(202);

    expect((await call("tools/call", { name: "create_checkout", arguments: {} })).json.error.code).toBe(-32602);
    expect((await call("resources/list")).json.error.code).toBe(-32601);
    expect((await call("tools/list", undefined, { "Mcp-Method": "tools/call" })).json.error.code).toBe(-32020);
    expect((await mcpGet({} as never)).status).toBe(405);

    const batch = await mcpPost({
      request: new Request("https://storefront.example.test/ucp/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]),
      }),
    } as never);
    expect((await batch.json()).error.code).toBe(-32600);
  });
});
