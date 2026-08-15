import { describe, expect, it } from "vitest";
import {
  AGENT_MCP_INSTRUCTIONS,
  createAgentMcpServer,
  formatAgentBrowserHandoffResult,
  formatAgentToolResult,
} from "./server";

describe("MCP server construction", () => {
  it("publishes one concise cross-tool operating loop", () => {
    expect(AGENT_MCP_INSTRUCTIONS.toLowerCase()).toContain("search");
    expect(AGENT_MCP_INSTRUCTIONS.toLowerCase()).toContain("describe");
    expect(AGENT_MCP_INSTRUCTIONS).toContain("operations.batch");
    expect(AGENT_MCP_INSTRUCTIONS.length).toBeLessThan(320);
  });

  it("constructs with exactly the supported four tools without module-init schema errors", () => {
    const server = createAgentMcpServer({
      surface: "dashboard",
      env: {} as Env,
      ctx: {} as ExecutionContext,
    });
    expect(server.toolInputSchemaJson("operations.search")).toBeDefined();
    expect(server.toolInputSchemaJson("operations.describe")).toBeDefined();
    expect(server.toolInputSchemaJson("operations.execute")).toBeDefined();
    const batchSchema = server.toolInputSchemaJson("operations.batch");
    expect(batchSchema).toBeDefined();
    expect(JSON.stringify(batchSchema)).toContain('"$step"');
    expect(JSON.stringify(batchSchema)).toContain('"pointer"');
    expect(server.toolInputSchemaJson("http.request")).toBeUndefined();
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
