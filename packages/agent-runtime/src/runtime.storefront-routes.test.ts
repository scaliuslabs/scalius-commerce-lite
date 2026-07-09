import { describe, expect, it } from "vitest";
import {
  UCP_VERSION,
  createStorefrontAgentWorker,
} from "./storefront-runtime";
import {
  ADMIN_COOKIE,
  MCP_ACCEPT_HEADER,
  MCP_PROTOCOL_VERSION,
  adminPermissionsBody,
  createEnv,
  createExecutionContext,
  mockJsonFetch,
} from "./runtime-test-support";

describe("storefront Agent runtime routes", () => {
  it("serves no-store health JSON", async () => {
    const worker = createStorefrontAgentWorker();
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
      service: "scalius-storefront-agent",
    });
  });

  it("publishes a cacheable catalog-only UCP platform profile", async () => {
    const worker = createStorefrontAgentWorker();
    const response = await worker.fetch(
      new Request("https://agent.example.test/.well-known/ucp"),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("public");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const profile = await response.json() as {
      ucp: {
        version: string;
        services: Record<string, unknown>;
        capabilities: Record<string, unknown>;
        payment_handlers?: unknown;
      };
    };
    expect(profile.ucp.version).toBe(UCP_VERSION);
    expect(Object.keys(profile.ucp.services)).toEqual(["dev.ucp.shopping"]);
    expect(Object.keys(profile.ucp.capabilities).sort()).toEqual([
      "dev.ucp.shopping.catalog.lookup",
      "dev.ucp.shopping.catalog.search",
    ]);
    expect(profile.ucp).not.toHaveProperty("payment_handlers");

    const serialized = JSON.stringify(profile).toLowerCase();
    for (const forbidden of ["checkout", "fulfillment", "order", "payment"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("serves the UCP platform profile only at the exact query-free path", async () => {
    const worker = createStorefrontAgentWorker();
    const [withQuery, wrongMethod] = await Promise.all([
      worker.fetch(
        new Request("https://agent.example.test/.well-known/ucp?debug=1"),
        createEnv(),
        createExecutionContext(),
      ),
      worker.fetch(
        new Request("https://agent.example.test/.well-known/ucp", { method: "POST" }),
        createEnv(),
        createExecutionContext(),
      ),
    ]);

    expect(withQuery.status).toBe(404);
    expect(wrongMethod.status).toBe(404);
  });

  it("returns no-store JSON for unknown routes", async () => {
    const worker = createStorefrontAgentWorker();
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

  it("does not expose an Admin MCP route", async () => {
    const apiFetch = mockJsonFetch(adminPermissionsBody());
    const worker = createStorefrontAgentWorker();
    const response = await worker.fetch(
      new Request("https://agent.example.test/mcp/admin", {
        method: "POST",
        headers: { Cookie: ADMIN_COOKIE },
      }),
      createEnv(apiFetch),
      createExecutionContext(),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      success: false,
      error: "not_found",
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("serves public catalog MCP responses with no-store cache headers", async () => {
    const worker = createStorefrontAgentWorker();
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
