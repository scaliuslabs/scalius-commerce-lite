import { describe, expect, it } from "vitest";
import {
  DASHBOARD_MCP_PATH,
  DASHBOARD_OAUTH_PROTECTED_RESOURCE_METADATA_PATH,
  STOREFRONT_MCP_PATH,
  STOREFRONT_OAUTH_PROTECTED_RESOURCE_METADATA_PATH,
  getOAuthCompletionRequestId,
  isAgentAccessPath,
  getMcpArtifactPath,
} from "./paths";

describe("agent access path authority", () => {
  it("matches only the two MCP resources and their exact RFC 9728 paths", () => {
    for (const path of [
      DASHBOARD_MCP_PATH,
      STOREFRONT_MCP_PATH,
      DASHBOARD_OAUTH_PROTECTED_RESOURCE_METADATA_PATH,
      STOREFRONT_OAUTH_PROTECTED_RESOURCE_METADATA_PATH,
    ]) {
      expect(isAgentAccessPath(path)).toBe(true);
    }
    expect(isAgentAccessPath(`${DASHBOARD_MCP_PATH}-evil`)).toBe(false);
    expect(isAgentAccessPath(`${STOREFRONT_MCP_PATH}/child`)).toBe(false);
    expect(isAgentAccessPath("/.well-known/oauth-protected-resource")).toBe(false);
  });

  it("accepts only exact audience-child artifact paths", () => {
    expect(getMcpArtifactPath(
      "/api/v1/mcp/dashboard/artifacts/aah_0123456789abcdefghij",
    )).toEqual({
      resource: "dashboard",
      artifactId: "aah_0123456789abcdefghij",
    });
    expect(isAgentAccessPath(
      "/api/v1/mcp/storefront/artifacts/aah_0123456789abcdefghij",
    )).toBe(true);
    expect(isAgentAccessPath(
      "/api/v1/mcp/dashboard-evil/artifacts/aah_0123456789abcdefghij",
    )).toBe(false);
    expect(isAgentAccessPath(
      "/api/v1/mcp/dashboard/artifacts/aah_bad",
    )).toBe(false);
  });

  it("accepts only exact opaque completion IDs", () => {
    const path = "/oauth/complete/aar_0123456789abcdefghij";
    expect(getOAuthCompletionRequestId(path)).toBe("aar_0123456789abcdefghij");
    expect(isAgentAccessPath(path)).toBe(true);
    expect(getOAuthCompletionRequestId(`${path}/extra`)).toBeNull();
    expect(getOAuthCompletionRequestId("/oauth/complete/../../oauth/token")).toBeNull();
  });
});
