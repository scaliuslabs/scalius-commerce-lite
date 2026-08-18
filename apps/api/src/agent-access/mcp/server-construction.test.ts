import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION,
  type JSONRPCMessage,
} from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import {
  AGENT_MCP_INSTRUCTIONS,
  createAgentMcpServer,
  formatAgentBrowserHandoffResult,
  formatAgentToolResult,
} from "./server";

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: unknown;
}

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
    await clientTransport.send({
      jsonrpc: "2.0",
      id: requestId,
      method,
      params,
    } as JSONRPCMessage);
    const resolved = await response;
    pending.delete(requestId);
    return resolved;
  };
  await request("initialize", {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "mcp-registration-test", version: "1.0.0" },
  });
  await clientTransport.send({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  } as JSONRPCMessage);
  return {
    request,
    close: async () => {
      await clientTransport.close();
      await server.close();
    },
  };
}

describe("MCP server construction", () => {
  it("publishes one concise cross-tool operating loop", () => {
    expect(AGENT_MCP_INSTRUCTIONS).toContain("workflows.resolve");
    expect(AGENT_MCP_INSTRUCTIONS).toContain("workflows.read");
    expect(AGENT_MCP_INSTRUCTIONS.toLowerCase()).toContain("describe");
    expect(AGENT_MCP_INSTRUCTIONS).toContain("operations.read");
    expect(AGENT_MCP_INSTRUCTIONS).toContain("operations.write");
    expect(AGENT_MCP_INSTRUCTIONS).toContain("never arbitrary code, HTTP, or SQL");
    expect(AGENT_MCP_INSTRUCTIONS.length).toBeLessThan(360);
  });

  it("constructs the resolver and split generic operation tools without module-init schema errors", () => {
    const server = createAgentMcpServer({
      surface: "dashboard",
      env: {} as Env,
      ctx: {} as ExecutionContext,
    });
    expect(server.toolInputSchemaJson("workflows.resolve")).toBeDefined();
    expect(server.toolInputSchemaJson("workflows.read")).toBeDefined();
    expect(server.toolInputSchemaJson("operations.describe")).toBeDefined();
    expect(server.toolInputSchemaJson("operations.read")).toBeDefined();
    expect(server.toolInputSchemaJson("operations.write")).toBeDefined();
    for (const name of ["operations.read_batch", "operations.write_batch"]) {
      const batchSchema = server.toolInputSchemaJson(name);
      expect(batchSchema).toBeDefined();
      expect(JSON.stringify(batchSchema)).toContain('"$step"');
      expect(JSON.stringify(batchSchema)).toContain('"pointer"');
    }
    expect(server.toolInputSchemaJson("operations.execute")).toBeUndefined();
    expect(server.toolInputSchemaJson("operations.batch")).toBeUndefined();
    expect(server.toolInputSchemaJson("operations.search")).toBeUndefined();
    expect(server.toolInputSchemaJson("http.request")).toBeUndefined();
  });

  it("advertises truthful split-tool annotations and bounded output schemas in memory", async () => {
    const server = createAgentMcpServer({
      surface: "dashboard",
      env: {} as Env,
      ctx: {} as ExecutionContext,
    });
    const connection = await connectInMemory(server);
    try {
      const response = await connection.request("tools/list");
      expect(response.error).toBeUndefined();
      const tools = (response.result as { tools: Array<{
        name: string;
        annotations?: Record<string, boolean>;
        outputSchema?: Record<string, unknown>;
      }> }).tools;
      expect(tools.map((tool) => tool.name)).toEqual([
        "workflows.resolve",
        "workflows.read",
        "operations.describe",
        "operations.read",
        "operations.read_batch",
        "operations.write",
        "operations.write_batch",
      ]);
      expect(tools.map((tool) => tool.name)).not.toContain("operations.execute");
      expect(tools.map((tool) => tool.name)).not.toContain("operations.batch");
      for (const name of ["workflows.resolve", "workflows.read", "operations.describe"]) {
        expect(tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
        });
      }
      for (const name of ["operations.read", "operations.read_batch"]) {
        expect(tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
        });
      }
      for (const name of ["operations.write", "operations.write_batch"]) {
        expect(tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
        });
      }
      for (const tool of tools.filter((candidate) => candidate.name !== "workflows.read")) {
        expect(tool.outputSchema).toMatchObject({
          type: "object",
          properties: {
            results: { maxItems: 20 },
            summary: { maxLength: 240 },
          },
        });
        expect(tool.outputSchema?.properties).not.toHaveProperty("operations");
        expect(tool.outputSchema?.properties).not.toHaveProperty("count");
      }
      const workflowReadSchema = tools.find((tool) => tool.name === "workflows.read")?.outputSchema;
      expect(workflowReadSchema).toMatchObject({
        type: "object",
        properties: { result: {} },
      });
      expect(JSON.stringify(workflowReadSchema)).toContain("workflow_read_unavailable");
      expect(JSON.stringify(workflowReadSchema)).toContain('"maxItems":100');
      expect(JSON.stringify(workflowReadSchema)).toContain('"maxItems":6');
      expect(JSON.stringify(workflowReadSchema)).toContain('"maxLength":300');
    } finally {
      await connection.close();
    }
  });

  it("places a one-time secret in structured content exactly once", () => {
    const token = "scl_pat_one_time_only";
    const formatted = formatAgentToolResult({
      ok: true,
      result: {
        operationId: "dashboard.agent_access.tokens.create",
        status: 201,
        ok: true,
        requestId: "request-1",
        contentType: "application/json",
        data: { token },
        oneTimeSecret: true,
      },
    });
    expect(formatted.content[0]?.text).toBe(
      "One-time secret returned in structured content",
    );
    expect(formatted.content[0]?.text).not.toContain(token);
    expect(JSON.stringify(formatted.structuredContent).match(new RegExp(token, "g")))
      .toHaveLength(1);
  });

  it("returns artifact metadata as a resource link without embedding bytes", () => {
    const formatted = formatAgentToolResult({
      ok: true,
      result: {
        operationId: "dashboard.orders.export",
        status: 200,
        ok: true,
        requestId: "request-2",
        contentType: "text/csv",
        data: null,
        artifact: {
          artifactId: "aah_0123456789abcdefghij",
          uri: "https://api.example.test/api/v1/mcp/dashboard/artifacts/aah_0123456789abcdefghij",
          filename: "orders.csv",
          mediaType: "text/csv",
          sizeBytes: 2048,
          sha256: "a".repeat(64),
          expiresInSeconds: 300,
        },
      },
    });
    expect(formatted.content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "resource_link",
        uri: "https://api.example.test/api/v1/mcp/dashboard/artifacts/aah_0123456789abcdefghij",
        mimeType: "text/csv",
        size: 2048,
      }),
    ]));
    expect(JSON.stringify(formatted)).not.toContain("base64");
    expect(JSON.stringify(formatted)).not.toContain("Authorization");
  });

  it("fails closed without returning sensitive continuation fields", () => {
    const code = `tpc_${"b".repeat(48)}`;
    const formatted = formatAgentToolResult({
      ok: true,
      result: {
        operationId: "dashboard.theme.preview_session_create",
        status: 200,
        ok: true,
        requestId: "request-3",
        contentType: "application/json",
        sensitiveContinuation: true,
        data: {
          success: true,
          data: {
            continuation: {
              url: "https://storefront.example.test/theme-preview/continue",
              method: "POST",
              fields: { continuationCode: code, path: "/", device: "full" },
            },
          },
        },
      },
    });
    expect(formatted.isError).toBe(true);
    expect(JSON.stringify(formatted)).not.toContain(code);
    expect(formatted.structuredContent).toEqual({
      ok: false,
      error: {
        code: "sensitive_continuation_not_supported",
        message: expect.stringContaining("Scalius CLI"),
      },
    });
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

  it("does not duplicate a large structured result into compatibility text", () => {
    const value = { ok: true, operation: { schema: "x".repeat(5_000) } };
    const formatted = formatAgentToolResult(value);
    expect(formatted.content[0]?.text).toMatch(/^Structured result returned \(\d+ UTF-8 bytes\)$/);
    expect(formatted.content[0]?.text).not.toContain("xxxx");
    expect(formatted.structuredContent).toEqual(value);
  });
});
