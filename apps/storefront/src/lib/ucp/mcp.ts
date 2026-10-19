/**
 * The UCP MCP binding (https://ucp.dev/2026-08-25/specification/shopping/catalog/mcp/):
 * `POST /ucp/mcp`, stateless JSON-RPC over Streamable HTTP with exactly the
 * three read-only catalog tools. Each tool runs the same catalog operation
 * as its REST route (`runUcpCatalogOperation`), so `structuredContent` is the
 * REST body and the text part is the REST body's exact bytes.
 *
 * MCP 2026-07-28 is stateless (`server/discover`, the version in `_meta`);
 * 2025-era clients still `initialize`. Nothing here keeps state between
 * requests, and nothing writes.
 */
import {
  MAX_LOOKUP_IDS,
  UCP_CORS_HEADERS,
  UCP_VERSION,
  isJsonObject,
  lookupTooLarge,
  negotiateUcpRequest,
  readJsonBody,
  runUcpCatalogOperation,
  type UcpOperation,
} from "./catalog";

/** Newest first; a 2025-era client negotiates through `initialize`. */
export const UCP_MCP_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"] as const;
const LATEST_INITIALIZE_VERSION = "2025-11-25";
const PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion";
const SERVER_INFO_META = "io.modelcontextprotocol/serverInfo";
const SERVER_INFO = { name: "scalius-ucp-catalog", title: "Store catalog (UCP)", version: UCP_VERSION };
const INSTRUCTIONS =
  `Read-only UCP ${UCP_VERSION} catalog of this store. Every call carries meta["ucp-agent"].profile (your platform's HTTPS UCP profile) and a catalog object. Prices are integer minor units; context.address_country, currency and language choose the market. There is no cart or checkout here: send the buyer to the product url.`;
/** The tool list never changes between deployments of one version: clients may cache it for an hour. */
const LIST_CACHE = { ttlMs: 3_600_000, cacheScope: "public" as const };

// JSON-RPC and MCP error codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
/** UCP: a transport-level failure (temporarily unavailable). */
const UCP_SERVER_ERROR = -32000;
/** UCP: discovery or version negotiation failed (`invalid_profile_url`, `version_unsupported`). */
const UCP_NEGOTIATION_ERROR = -32001;
/** MCP 2026-07-28: an Mcp-Method or Mcp-Name header disagrees with the body. */
const HEADER_MISMATCH = -32020;
/** MCP 2026-07-28: the request's protocol version is not one this server speaks. */
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

const META_SCHEMA = {
  type: "object",
  description: "UCP request metadata.",
  required: ["ucp-agent"],
  properties: {
    "ucp-agent": {
      type: "object",
      required: ["profile"],
      properties: {
        profile: { type: "string", format: "uri", description: "Your platform's UCP profile (HTTPS)." },
      },
    },
  },
} as const;

const CONTEXT_SCHEMA = {
  type: "object",
  description: "Buyer hints that choose the market: its prices, currency and language.",
  properties: {
    address_country: { type: "string", description: "ISO 3166-1 alpha-2 country, e.g. IN." },
    currency: { type: "string", description: "ISO 4217 currency, e.g. USD; also the price filter's currency." },
    language: { type: "string", description: "BCP 47 language tag, e.g. en." },
    intent: { type: "string" },
  },
} as const;

const OUTPUT_SCHEMA = {
  type: "object",
  description: "The UCP response; see the capability schema named in the tool description.",
  required: ["ucp"],
  properties: { ucp: { type: "object" } },
} as const;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

interface UcpMcpTool {
  name: string;
  operation: UcpOperation;
  definition: Record<string, unknown>;
}

function tool(
  name: string,
  operation: UcpOperation,
  title: string,
  description: string,
  catalog: Record<string, unknown>,
): UcpMcpTool {
  return {
    name,
    operation,
    definition: {
      name,
      title,
      description,
      inputSchema: {
        type: "object",
        required: ["meta", "catalog"],
        properties: { meta: META_SCHEMA, catalog },
      },
      outputSchema: OUTPUT_SCHEMA,
      annotations: { title, ...READ_ONLY },
    },
  };
}

/** The binding's tools, in a fixed order (2026-07-28: deterministic for client caching). */
export const UCP_MCP_TOOLS: readonly UcpMcpTool[] = [
  tool(
    "search_catalog",
    "search",
    "Search the catalog",
    `Search products by text, category or price (UCP dev.ucp.shopping.catalog.search; response: https://ucp.dev/${UCP_VERSION}/schemas/shopping/catalog_search.json#/$defs/search_response).`,
    {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search." },
        context: CONTEXT_SCHEMA,
        filters: {
          type: "object",
          properties: {
            categories: { type: "array", items: { type: "string" }, description: "Category handle; the first is used." },
            price: {
              type: "object",
              description: "Bounds in minor units of the answered currency.",
              properties: { min: { type: "integer", minimum: 0 }, max: { type: "integer", minimum: 0 } },
            },
          },
        },
        pagination: {
          type: "object",
          properties: {
            cursor: { type: "string", description: "The previous page's cursor." },
            limit: { type: "integer", minimum: 1, maximum: 50 },
          },
        },
      },
    },
  ),
  tool(
    "lookup_catalog",
    "lookup",
    "Look up products",
    `Resolve up to ${MAX_LOOKUP_IDS} product ids, variant ids, SKUs, handles or product URLs (UCP dev.ucp.shopping.catalog.lookup; response: https://ucp.dev/${UCP_VERSION}/schemas/shopping/catalog_lookup.json#/$defs/lookup_response).`,
    {
      type: "object",
      required: ["ids"],
      properties: {
        ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: MAX_LOOKUP_IDS },
        context: CONTEXT_SCHEMA,
      },
    },
  ),
  tool(
    "get_product",
    "product",
    "Get a product",
    `One product with every variant and option availability for a selection (UCP dev.ucp.shopping.catalog.lookup; response: https://ucp.dev/${UCP_VERSION}/schemas/shopping/catalog_lookup.json#/$defs/get_product_response).`,
    {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Product or variant id, SKU, handle or product URL." },
        selected: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "label"],
            properties: { name: { type: "string" }, label: { type: "string" } },
          },
        },
        preferences: {
          type: "array",
          items: { type: "string" },
          description: "Option names to keep longest when no variant matches every selection.",
        },
        context: CONTEXT_SCHEMA,
      },
    },
  ),
];

type JsonRpcId = string | number | null;

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-cache, no-store, must-revalidate",
  ...UCP_CORS_HEADERS,
} as const;

function rpcResponse(payload: Record<string, unknown>, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...JSON_HEADERS, ...headers } });
}

function rpcResult(id: JsonRpcId, result: Record<string, unknown>): Response {
  return rpcResponse({
    jsonrpc: "2.0",
    id,
    result: { resultType: "complete", ...result, _meta: { [SERVER_INFO_META]: SERVER_INFO } },
  });
}

function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return rpcResponse({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } }, status, headers);
}

function isSupportedVersion(value: string): boolean {
  return (UCP_MCP_PROTOCOL_VERSIONS as readonly string[]).includes(value);
}

/** The protocol version a request names (header or 2026-07-28 `_meta`), when it names one this server lacks. */
function unsupportedProtocolVersion(request: Request, params: Record<string, unknown>): string | null {
  const header = request.headers.get("MCP-Protocol-Version")?.trim();
  if (header && !isSupportedVersion(header)) return header;
  const meta = isJsonObject(params._meta) ? params._meta : {};
  const named = meta[PROTOCOL_VERSION_META];
  if (typeof named === "string" && !isSupportedVersion(named)) return named;
  return null;
}

function capabilities() {
  return { tools: { listChanged: false } };
}

async function callTool(id: JsonRpcId, params: Record<string, unknown>): Promise<Response> {
  const name = typeof params.name === "string" ? params.name : "";
  const found = UCP_MCP_TOOLS.find((each) => each.name === name);
  if (!found) return rpcError(id, INVALID_PARAMS, `Unknown tool: ${name.slice(0, 64)}`);

  const args = isJsonObject(params.arguments) ? params.arguments : {};
  const meta = isJsonObject(args.meta) ? args.meta : {};
  const agent = isJsonObject(meta["ucp-agent"]) ? meta["ucp-agent"] : {};
  const catalog = args.catalog;
  if (!isJsonObject(catalog)) {
    return rpcError(id, INVALID_PARAMS, "arguments.catalog must be an object.");
  }

  const negotiation = negotiateUcpRequest(agent.profile, catalog);
  if (negotiation) {
    return rpcError(id, UCP_NEGOTIATION_ERROR, negotiation.code === "version_unsupported"
      ? "Protocol version not supported"
      : "UCP discovery failed", { code: negotiation.code, content: negotiation.content });
  }
  // UCP MCP conformance: a batch over the size limit is invalid params.
  if (found.operation === "lookup" && lookupTooLarge(catalog)) {
    return rpcError(id, INVALID_PARAMS, `lookup_catalog accepts at most ${MAX_LOOKUP_IDS} identifiers.`, {
      code: "request_too_large",
    });
  }

  const result = await runUcpCatalogOperation(found.operation, catalog);
  if (result.status === 503) {
    return rpcError(id, UCP_SERVER_ERROR, "Catalog temporarily unavailable", {
      retry_after: 30,
      ...result.body,
    }, 503, { "Retry-After": "30" });
  }
  if (result.status === 400) {
    return rpcError(id, INVALID_PARAMS, "Invalid catalog input", result.body);
  }
  // A business outcome (success, or get_product not_found): the UCP body, as REST answers it.
  return rpcResult(id, {
    structuredContent: result.body,
    content: [{ type: "text", text: JSON.stringify(result.body) }],
  });
}

/** `POST /ucp/mcp`: one JSON-RPC message; a notification is accepted without a body. */
export async function handleUcpMcpRequest(request: Request): Promise<Response> {
  const message = await readJsonBody(request);
  if (message === undefined) return rpcError(null, PARSE_ERROR, "Parse error: the body must be one JSON-RPC message of at most 64 KiB.");
  if (!isJsonObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(null, INVALID_REQUEST, "Invalid Request: send one JSON-RPC 2.0 object (batches are not supported).");
  }

  const hasId = Object.prototype.hasOwnProperty.call(message, "id");
  const id = (typeof message.id === "string" || typeof message.id === "number" ? message.id : null) as JsonRpcId;
  if (!hasId) {
    // Notifications (notifications/initialized, cancellations) need no answer.
    return new Response(null, { status: 202, headers: UCP_CORS_HEADERS });
  }

  const method = message.method;
  const params = isJsonObject(message.params) ? message.params : {};
  const methodHeader = request.headers.get("Mcp-Method");
  const nameHeader = request.headers.get("Mcp-Name");
  if ((methodHeader && methodHeader !== method) ||
    (nameHeader && method === "tools/call" && nameHeader !== params.name)) {
    return rpcError(id, HEADER_MISMATCH, "Mcp-Method or Mcp-Name does not match the request body.", undefined, 400);
  }

  if (method === "initialize") {
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
    return rpcResult(id, {
      protocolVersion: isSupportedVersion(requested) && requested !== "2026-07-28" ? requested : LATEST_INITIALIZE_VERSION,
      capabilities: capabilities(),
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    });
  }

  const unsupported = unsupportedProtocolVersion(request, params);
  if (unsupported) {
    return rpcError(id, UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", {
      requested: unsupported.slice(0, 32),
      supported: UCP_MCP_PROTOCOL_VERSIONS,
    }, 400);
  }

  try {
    switch (method) {
      case "server/discover":
        return rpcResult(id, {
          supportedVersions: UCP_MCP_PROTOCOL_VERSIONS,
          capabilities: capabilities(),
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
          ...LIST_CACHE,
        });
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: UCP_MCP_TOOLS.map((each) => each.definition), ...LIST_CACHE });
      case "tools/call":
        return await callTool(id, params);
      default:
        return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method.slice(0, 64)}`);
    }
  } catch (error) {
    console.error("UCP MCP request failed:", error instanceof Error ? error.name : "unknown");
    return rpcError(id, INTERNAL_ERROR, "Internal error", undefined, 500);
  }
}

/** Streamable HTTP's GET stream is not offered: every answer is the POST's own response. */
export function ucpMcpMethodNotAllowed(): Response {
  return new Response(null, { status: 405, headers: { ...UCP_CORS_HEADERS, Allow: "POST, OPTIONS" } });
}
