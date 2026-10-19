import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION,
  createMcpHandler,
  type JSONRPCMessage,
} from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { AGENT_PROMPTS, AGENT_PROMPT_MAX_BYTES } from "./prompts";
import {
  AGENT_MCP_INSTRUCTIONS,
  AGENT_MCP_PROTOCOL_VERSIONS,
  buildAgentInstructions,
  createAgentMcpServer,
  formatAgentBrowserHandoffResult,
} from "./server";
import { storeContextLine } from "./context";

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: unknown;
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

async function connectInMemory(server: ReturnType<typeof createAgentMcpServer>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (response: JsonRpcResponse) => void>();
  clientTransport.onmessage = (message) => {
    const response = message as JsonRpcResponse;
    if (typeof response.id === "number") pending.get(response.id)?.(response);
  };
  await clientTransport.start();
  await server.connect(serverTransport);
  let requestId = 0;
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    requestId += 1;
    const response = new Promise<JsonRpcResponse>((resolve) => pending.set(requestId, resolve));
    await clientTransport.send({ jsonrpc: "2.0", id: requestId, method, params } as JSONRPCMessage);
    const resolved = await response;
    pending.delete(requestId);
    return resolved;
  };
  const initialized = await request("initialize", {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "mcp-registration-test", version: "1.0.0" },
  });
  await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" } as JSONRPCMessage);
  return {
    initialized,
    request,
    close: async () => {
      await clientTransport.close();
      await server.close();
    },
  };
}

function server(surface: "dashboard" | "storefront") {
  return createAgentMcpServer({ surface, env: {} as Env, ctx: {} as ExecutionContext });
}

describe("MCP server construction", () => {
  it("publishes one concise operating loop naming every tool", () => {
    for (const tool of ["scalius_search", "scalius_describe", "scalius_read", "scalius_write", "scalius_answer"]) {
      expect(AGENT_MCP_INSTRUCTIONS).toContain(tool);
    }
    expect(AGENT_MCP_INSTRUCTIONS).toContain("dryRun:true");
    expect(AGENT_MCP_INSTRUCTIONS).toContain("confirmToken");
    expect(bytes(AGENT_MCP_INSTRUCTIONS)).toBeLessThan(500);
  });

  it("adds the live store line and stays within 600 bytes", () => {
    const line = storeContextLine({
      name: "Dhaka Panjabi House",
      currency: "BDT",
      timeZone: "Asia/Dhaka",
      markets: [{ name: "Bangladesh", currency: "BDT", backup: true }, { name: "India", currency: "INR" }],
      checkout: "incomplete",
      notSetUp: ["No active shipping method", "No payment method is enabled"],
    });
    expect(line).toBe("Store: Dhaka Panjabi House · BDT · Asia/Dhaka · markets: Bangladesh (BDT), India (INR) · checkout incomplete · not set up: No active shipping method; No payment method is enabled.");
    const instructions = buildAgentInstructions(line);
    expect(instructions.startsWith(AGENT_MCP_INSTRUCTIONS)).toBe(true);
    expect(new TextEncoder().encode(instructions).byteLength).toBeLessThanOrEqual(600);
    const long = buildAgentInstructions(`Store: ${"বাংলা ".repeat(200)}`);
    expect(new TextEncoder().encode(long).byteLength).toBeLessThanOrEqual(600);
    expect(long.endsWith("...")).toBe(true);
    expect(buildAgentInstructions("")).toBe(AGENT_MCP_INSTRUCTIONS);
  });

  it("lists the five merged snake_case tools in at most 6,144 bytes on both audiences", async () => {
    const measured: Record<string, number> = {};
    for (const surface of ["dashboard", "storefront"] as const) {
      const connection = await connectInMemory(server(surface));
      try {
        const response = await connection.request("tools/list");
        expect(response.error).toBeUndefined();
        const tools = (response.result as { tools: Array<{ name: string; annotations?: Record<string, boolean>; outputSchema?: unknown }> }).tools;
        expect(tools.map((tool) => tool.name)).toEqual([
          "scalius_search",
          "scalius_describe",
          "scalius_answer",
          "scalius_read",
          "scalius_write",
        ]);
        for (const tool of tools) expect(tool.name).toMatch(/^[a-z_]+$/);
        for (const name of ["scalius_search", "scalius_describe", "scalius_answer", "scalius_read"]) {
          expect(tools.find((tool) => tool.name === name)?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
        }
        expect(tools.find((tool) => tool.name === "scalius_write")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
        const outputSchemas = new Set(tools.map((tool) => JSON.stringify(tool.outputSchema)));
        expect(outputSchemas.size).toBe(1);
        expect(bytes(tools[0]!.outputSchema)).toBeLessThanOrEqual(300);
        measured[surface] = bytes(response.result);
        expect(measured[surface]).toBeLessThanOrEqual(6_144);
      } finally {
        await connection.close();
      }
    }
    process.stdout.write(`MCP tools/list bytes ${JSON.stringify(measured)}\n`);
  });

  it("removes every old dotted tool name without an alias", () => {
    const dashboard = server("dashboard");
    for (const name of [
      "workflows.resolve", "workflows.read", "operations.describe", "operations.read",
      "operations.read_batch", "operations.write", "operations.write_batch", "operations.execute",
      "operations.search", "http.request", "scalius_run",
    ]) {
      expect(dashboard.toolInputSchemaJson(name)).toBeUndefined();
    }
  });

  it("negotiates 2025-11-25 for a 2025 client and serves 2026-07-28 with cache hints", async () => {
    expect(AGENT_MCP_PROTOCOL_VERSIONS[0]).toBe("2026-07-28");
    expect(AGENT_MCP_PROTOCOL_VERSIONS).toEqual(expect.arrayContaining(["2025-11-25", "2025-06-18", "2025-03-26"]));
    const connection = await connectInMemory(server("dashboard"));
    try {
      expect(connection.initialized.result).toMatchObject({
        protocolVersion: "2025-11-25",
        capabilities: { tools: {}, resources: {}, prompts: {} },
        instructions: AGENT_MCP_INSTRUCTIONS,
      });
    } finally {
      await connection.close();
    }

    const handler = createMcpHandler(() => server("dashboard"));
    const envelope = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
    };
    const modern = async (method: string) => {
      const response = await handler.fetch(new Request("https://api.example.test/api/v1/mcp/dashboard", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": method,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { _meta: envelope } }),
      }));
      expect(response.status).toBe(200);
      return (await response.json() as { result: Record<string, unknown> }).result;
    };
    expect(await modern("server/discover")).toMatchObject({
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: AGENT_MCP_INSTRUCTIONS,
      ttlMs: 300_000,
      cacheScope: "private",
    });
    const tools = await modern("tools/list");
    expect(tools).toMatchObject({ ttlMs: 3_600_000, cacheScope: "private" });
    expect((tools.tools as unknown[]).length).toBe(5);
    expect(bytes(tools)).toBeLessThanOrEqual(6_144);
  });

  it("offers the store, operation, workflow and recipe resources and the merchant prompts", async () => {
    const connection = await connectInMemory(server("dashboard"));
    try {
      const resources = await connection.request("resources/list");
      expect((resources.result as { resources: Array<{ uri: string }> }).resources.map((resource) => resource.uri))
        .toEqual(["scalius://store", "scalius://skills/recipes"]);
      const templates = await connection.request("resources/templates/list");
      expect((templates.result as { resourceTemplates: Array<{ uriTemplate: string }> }).resourceTemplates.map((template) => template.uriTemplate))
        .toEqual(["scalius://ops/{operationId}", "scalius://workflows/{id}"]);
      const prompts = await connection.request("prompts/list");
      expect((prompts.result as { prompts: Array<{ name: string }> }).prompts.map((prompt) => prompt.name)).toEqual([
        "daily_brief", "launch_product", "run_sale", "fulfil_backlog", "checkout_health", "tracking_health",
      ]);
      const prompt = await connection.request("prompts/get", { name: "launch_product", arguments: { name: "Cotton Panjabi", price: "1500" } });
      const text = (prompt.result as { messages: Array<{ content: { text: string } }> }).messages[0]!.content.text;
      expect(text).toContain("Cotton Panjabi");
      expect(text).toContain("dryRun:true");
    } finally {
      await connection.close();
    }
    for (const prompt of AGENT_PROMPTS) {
      expect(new TextEncoder().encode(prompt.body({ name: "x".repeat(100), price: "1", options: "Size: S,M,L", percent: "10", scope: "all", dates: "Fri to Sun" })).byteLength)
        .toBeLessThanOrEqual(AGENT_PROMPT_MAX_BYTES);
    }
    const storefront = await connectInMemory(server("storefront"));
    try {
      const prompts = await storefront.request("prompts/list");
      expect(prompts.error ?? (prompts.result as { prompts: unknown[] }).prompts).toBeDefined();
    } finally {
      await storefront.close();
    }
  });

  it("returns only a non-secret authenticated browser resource link", () => {
    const formatted = formatAgentBrowserHandoffResult({
      handoffId: "abh_0123456789abcdefghij",
      url: "https://dashboard.example.test/admin/settings/agent-access/continue/abh_0123456789abcdefghij",
      expiresAt: "2026-08-14T12:05:00.000Z",
    });
    expect(formatted.content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "resource_link",
        uri: expect.stringContaining("/agent-access/continue/abh_0123456789abcdefghij"),
      }),
    ]));
    expect(JSON.stringify(formatted)).not.toContain("continuationCode");
    expect(JSON.stringify(formatted)).not.toContain("fields");
  });
});
