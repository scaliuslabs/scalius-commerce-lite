import { describe, expect, it } from "vitest";
import { createAgentMcpServer, formatAgentToolResult } from "./server";

describe("MCP server construction", () => {
  it("constructs with exactly the supported four tools without module-init schema errors", () => {
    const server = createAgentMcpServer({
      surface: "dashboard",
      env: {} as Env,
      ctx: {} as ExecutionContext,
    });
    expect(server.toolInputSchemaJson("operations.search")).toBeDefined();
    expect(server.toolInputSchemaJson("operations.describe")).toBeDefined();
    expect(server.toolInputSchemaJson("operations.execute")).toBeDefined();
    expect(server.toolInputSchemaJson("operations.batch")).toBeDefined();
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

  it("puts sensitive continuation fields in structured content only", () => {
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
    expect(formatted.content[0]?.text).not.toContain(code);
    expect(formatted.content[0]?.text).toContain("POST fields");
    expect(JSON.stringify(formatted.structuredContent).match(new RegExp(code, "g")))
      .toHaveLength(1);
  });
});
