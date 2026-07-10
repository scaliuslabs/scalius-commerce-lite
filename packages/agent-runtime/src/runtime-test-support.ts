import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, expect, vi } from "vitest";
import { createAdminMcpServer } from "./mcp/admin";
import type { AdminMcpOptions } from "./mcp/admin";
import { createAdminAgentWorker } from "./admin-runtime";
import {
  DEFAULT_AGENT_PROFILE_URL,
  createStorefrontCatalogMcpServer,
} from "./storefront-runtime";
import type { FetchLike } from "./storefront-runtime";
import type {
  AdminAgentRuntimeEnv,
  StorefrontAgentRuntimeEnv,
} from "./runtime-env";

export type TestMcpServer = {
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
            : "2025-11-25",
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

export const BASE_TEST_ENV = {
  STOREFRONT_URL: "https://storefront.example.test",
  AGENT_PROFILE_URL: DEFAULT_AGENT_PROFILE_URL,
  AGENT_NAME: "test-catalog-agent",
  AGENT_VERSION: "0.1.0-test",
};

export const ADMIN_COOKIE = "better-auth.session_token=signed-session";

export const UNSAFE_TERMS = [
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

export const ADMIN_MCP_FORBIDDEN_MUTATION_TERMS = [
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

export const MCP_ACCEPT_HEADER = "application/json, text/event-stream";
export const MCP_PROTOCOL_VERSION = "2025-11-25";
export const INTERNAL_ADMIN_MCP_URL = "http://admin-agent.internal/mcp";
export const PUBLIC_ADMIN_MCP_URL = "https://admin-agent.example.test/mcp";
export const ADMIN_NOTIFICATION_SETTINGS_SUMMARY_PATH =
  "/api/v1/admin/settings/notification-channels/mcp-summary";
export const ADMIN_NOTIFICATION_SETTINGS_SUMMARY_VERSION =
  "admin-notification-settings-summary:v1";

export interface BootedClient {
  client: Client;
  server: McpServer;
}

export const openClients: BootedClient[] = [];

export type MockFetch = ReturnType<typeof vi.fn<FetchLike>>;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export function adminPermissionsBody(overrides: Record<string, unknown> = {}) {
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

export function adminNotificationSettingsSummaryFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    source: {
      path: ADMIN_NOTIFICATION_SETTINGS_SUMMARY_PATH,
      permission: "settings.general.view",
      version: ADMIN_NOTIFICATION_SETTINGS_SUMMARY_VERSION,
    },
    customer: {
      supportedChannels: ["email", "sms", "whatsapp"],
      readiness: {
        email: { configured: true, ready: true, issueCount: 0 },
        sms: { configured: false, ready: false, issueCount: 1 },
        whatsapp: { configured: true, ready: true, issueCount: 0 },
      },
      enabledEventCounts: {
        email: 1,
        sms: 0,
        whatsapp: 0,
      },
      events: [
        {
          type: "order_created",
          label: "Order Created",
          enabledChannels: ["email"],
          hasAnyChannel: true,
        },
      ],
      whatsappTemplate: {
        configured: true,
        languageConfigured: true,
      },
    },
    merchant: {
      supportedChannels: ["push"],
      readiness: {
        push: { configured: true, ready: true, issueCount: 0 },
      },
      enabledEventCounts: {
        push: 1,
      },
      events: [
        {
          type: "order_created",
          label: "Order Created",
          enabledChannels: ["push"],
          hasAnyChannel: true,
        },
      ],
    },
    totals: {
      orderEventCount: 15,
      customerEventsWithAnyChannel: 1,
      merchantEventsWithPush: 1,
      readinessIssueCount: 1,
    },
    limits: {
      includesCredentials: false,
      includesMaskedSecrets: false,
      includesProviderIdentifiers: false,
      includesRawProviderErrors: false,
      includesRecipients: false,
      includesOrderIds: false,
      includesDeliveryReceipts: false,
      canMutate: false,
    },
    ...overrides,
  };
}

export function mockJsonFetch(body: unknown, status = 200): MockFetch {
  return vi.fn<FetchLike>().mockImplementation(() => Promise.resolve(json(body, status)));
}

export function apiBinding(fetchImpl: FetchLike): Fetcher {
  return { fetch: fetchImpl } as Fetcher;
}

export type TestAgentEnv = AdminAgentRuntimeEnv & StorefrontAgentRuntimeEnv;

export function createEnv(
  apiFetch: FetchLike = mockJsonFetch(adminPermissionsBody()),
): TestAgentEnv {
  return {
    ...BASE_TEST_ENV,
    API: apiBinding(apiFetch),
    STOREFRONT: apiBinding(
      mockJsonFetch({ ucp: { status: "success" }, products: [] }),
    ),
  };
}

export async function boot(
  fetchImpl: FetchLike | null = vi.fn().mockResolvedValue(
    json({ ucp: { status: "success" } }),
  ),
  env: TestAgentEnv = createEnv(),
) {
  const server = createStorefrontCatalogMcpServer(
    env,
    fetchImpl ? { fetchImpl } : {},
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  openClients.push({ client, server });
  return { client, server };
}

export async function bootAdmin(
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

export function fetchCall(fetchImpl: FetchLike, index = 0): [RequestInfo | URL, RequestInit | undefined] {
  const mock = vi.mocked(fetchImpl);
  const call = mock.mock.calls[index];
  if (!call) throw new Error(`Missing fetch call ${index}`);
  return [call[0], call[1]];
}

export function requestUrl(input: RequestInfo | URL): string {
  return input instanceof URL ? input.toString() : String(input);
}

export function parseRequestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") return {};
  return JSON.parse(init.body) as Record<string, unknown>;
}

export function mcpRequest(
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

export async function parseMcpJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  const contentType = response.headers.get("Content-Type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const dataLine = text.split(/\r?\n/).find((line) => line.startsWith("data:"));
    if (!dataLine) throw new Error(`Missing MCP event data: ${text}`);
    return JSON.parse(dataLine.slice("data:".length).trim()) as Record<string, unknown>;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

export function requireMcpResult(message: Record<string, unknown>): Record<string, unknown> {
  expect(message.error).toBeUndefined();
  expect(isRecord(message.result)).toBe(true);
  return message.result as Record<string, unknown>;
}

export async function initializeAdminMcp(
  worker: ReturnType<typeof createAdminAgentWorker>,
  env: AdminAgentRuntimeEnv,
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

export async function adminMcpRpc(
  worker: ReturnType<typeof createAdminAgentWorker>,
  env: AdminAgentRuntimeEnv,
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

export function createExecutionContext(): ExecutionContext {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function firstContentBlock(result: unknown): unknown {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    throw new Error("Expected MCP content array");
  }
  return result.content[0];
}

export function adminNavigationContext(result: Record<string, unknown>): Record<string, unknown> {
  const structuredContent = result.structuredContent;
  if (!isRecord(structuredContent) || !isRecord(structuredContent.adminNavigationContext)) {
    throw new Error("Expected adminNavigationContext structured content");
  }
  return structuredContent.adminNavigationContext;
}

export function adminProductSearchContext(result: Record<string, unknown>): Record<string, unknown> {
  const structuredContent = result.structuredContent;
  if (!isRecord(structuredContent) || !isRecord(structuredContent.adminProductSearch)) {
    throw new Error("Expected adminProductSearch structured content");
  }
  return structuredContent.adminProductSearch;
}

export function adminProductCopyContext(result: Record<string, unknown>): Record<string, unknown> {
  const structuredContent = result.structuredContent;
  if (!isRecord(structuredContent) || !isRecord(structuredContent.adminProductCopyContext)) {
    throw new Error("Expected adminProductCopyContext structured content");
  }
  return structuredContent.adminProductCopyContext;
}

export function adminCategorySearchContext(result: Record<string, unknown>): Record<string, unknown> {
  const structuredContent = result.structuredContent;
  if (!isRecord(structuredContent) || !isRecord(structuredContent.adminCategorySearch)) {
    throw new Error("Expected adminCategorySearch structured content");
  }
  return structuredContent.adminCategorySearch;
}

export function adminCollectionSearchContext(result: Record<string, unknown>): Record<string, unknown> {
  const structuredContent = result.structuredContent;
  if (!isRecord(structuredContent) || !isRecord(structuredContent.adminCollectionSearch)) {
    throw new Error("Expected adminCollectionSearch structured content");
  }
  return structuredContent.adminCollectionSearch;
}

export function adminPageSearchContext(result: Record<string, unknown>): Record<string, unknown> {
  const structuredContent = result.structuredContent;
  if (!isRecord(structuredContent) || !isRecord(structuredContent.adminPageSearch)) {
    throw new Error("Expected adminPageSearch structured content");
  }
  return structuredContent.adminPageSearch;
}

export function adminOrderSearchContext(result: Record<string, unknown>): Record<string, unknown> {
  const structuredContent = result.structuredContent;
  if (!isRecord(structuredContent) || !isRecord(structuredContent.adminOrderSearch)) {
    throw new Error("Expected adminOrderSearch structured content");
  }
  return structuredContent.adminOrderSearch;
}

export function adminCustomerSearchContext(result: Record<string, unknown>): Record<string, unknown> {
  const structuredContent = result.structuredContent;
  if (!isRecord(structuredContent) || !isRecord(structuredContent.adminCustomerSearch)) {
    throw new Error("Expected adminCustomerSearch structured content");
  }
  return structuredContent.adminCustomerSearch;
}

export function adminMediaSearchContext(result: Record<string, unknown>): Record<string, unknown> {
  const structuredContent = result.structuredContent;
  if (!isRecord(structuredContent) || !isRecord(structuredContent.adminMediaSearch)) {
    throw new Error("Expected adminMediaSearch structured content");
  }
  return structuredContent.adminMediaSearch;
}

export function adminInventoryLookupContext(result: Record<string, unknown>): Record<string, unknown> {
  const structuredContent = result.structuredContent;
  if (!isRecord(structuredContent) || !isRecord(structuredContent.adminInventoryLookup)) {
    throw new Error("Expected adminInventoryLookup structured content");
  }
  return structuredContent.adminInventoryLookup;
}

export function adminDashboardSummaryContext(result: Record<string, unknown>): Record<string, unknown> {
  const structuredContent = result.structuredContent;
  if (!isRecord(structuredContent) || !isRecord(structuredContent.adminDashboardSummary)) {
    throw new Error("Expected adminDashboardSummary structured content");
  }
  return structuredContent.adminDashboardSummary;
}

export function adminSettingsSummaryContext(result: Record<string, unknown>): Record<string, unknown> {
  const structuredContent = result.structuredContent;
  if (!isRecord(structuredContent) || !isRecord(structuredContent.adminSettingsSummary)) {
    throw new Error("Expected adminSettingsSummary structured content");
  }
  return structuredContent.adminSettingsSummary;
}

export function adminNotificationSettingsSummaryContext(result: Record<string, unknown>): Record<string, unknown> {
  const structuredContent = result.structuredContent;
  if (!isRecord(structuredContent) || !isRecord(structuredContent.adminNotificationSettingsSummary)) {
    throw new Error("Expected adminNotificationSettingsSummary structured content");
  }
  return structuredContent.adminNotificationSettingsSummary;
}

export function adminAnalyticsSummaryContext(result: Record<string, unknown>): Record<string, unknown> {
  const structuredContent = result.structuredContent;
  if (!isRecord(structuredContent) || !isRecord(structuredContent.adminAnalyticsSummary)) {
    throw new Error("Expected adminAnalyticsSummary structured content");
  }
  return structuredContent.adminAnalyticsSummary;
}

export function catalogCategoriesContext(result: Record<string, unknown>): Record<string, unknown> {
  const structuredContent = result.structuredContent;
  if (!isRecord(structuredContent) || !isRecord(structuredContent.catalogCategories)) {
    throw new Error("Expected catalogCategories structured content");
  }
  return structuredContent.catalogCategories;
}

export function adminNavigationPaths(context: Record<string, unknown>): string[] {
  const sections = Array.isArray(context.sections) ? context.sections : [];
  return sections.flatMap((section) => {
    if (!isRecord(section) || !Array.isArray(section.pages)) return [];
    return section.pages.flatMap((page) => {
      if (!isRecord(page) || typeof page.path !== "string") return [];
      return [page.path];
    });
  });
}

export async function expectValidationToolError(resultPromise: Promise<unknown>): Promise<void> {
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
