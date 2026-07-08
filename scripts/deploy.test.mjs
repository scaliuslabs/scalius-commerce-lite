import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getBuildCommandForTarget,
  getDeployCommandForTarget,
  parseOnlyTarget,
  sampleApiReadiness,
  verifyAgentDeploy,
} from "./deploy.mjs";

function readyResponse() {
  return new Response(JSON.stringify({
    success: true,
    status: "ready",
    checks: {
      d1: { status: "ok", latencyMs: 20 },
      api_cache_kv: { status: "ok", latencyMs: 30 },
      r2: { status: "ok", latencyMs: 40 },
    },
  }), { status: 200 });
}

function degradedResponse(status = 503) {
  return new Response(JSON.stringify({
    success: false,
    status: "degraded",
    checks: {
      d1: { status: "ok", latencyMs: 20 },
      api_cache_kv: { status: "ok", latencyMs: 30 },
      r2: { status: "error", latencyMs: 1_500 },
    },
  }), { status });
}

function agentHealthResponse() {
  return new Response(JSON.stringify({
    success: true,
    status: "ok",
    service: "scalius-agent",
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function agentTool(name, extra = {}) {
  return {
    name,
    description: `Reads public catalog data for ${name}.`,
    inputSchema: { type: "object" },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    ...extra,
  };
}

function agentTools(overrides = {}) {
  return [
    agentTool("catalog_search", overrides.catalog_search),
    agentTool("catalog_lookup", overrides.catalog_lookup),
    agentTool("catalog_product", overrides.catalog_product),
    agentTool("catalog_profile", overrides.catalog_profile),
  ];
}

function ucpProfile(capabilities = {
  "dev.ucp.shopping.catalog.search": [{
    version: "2026-07",
    spec: "https://ucp.dev/2026-07/specification/catalog/search",
    schema: "https://ucp.dev/2026-07/schemas/shopping/catalog_search.json",
  }],
  "dev.ucp.shopping.catalog.lookup": [{
    version: "2026-07",
    spec: "https://ucp.dev/2026-07/specification/catalog/lookup",
    schema: "https://ucp.dev/2026-07/schemas/shopping/catalog_lookup.json",
  }],
}) {
  return {
    ucp: {
      version: "2026-07",
      services: {
        "dev.ucp.shopping": [
          {
            version: "2026-07",
            transport: "rest",
            endpoint: "https://storefront.example.test/ucp",
            spec: "https://ucp.dev/2026-07/specification/overview",
            schema: "https://ucp.dev/2026-07/services/shopping/rest.openapi.json",
          },
        ],
      },
      capabilities,
      supported_versions: {
        "2026-07": "https://storefront.example.test/.well-known/ucp",
      },
    },
  };
}

function agentCatalogProfileMcpResult(profile = ucpProfile()) {
  return {
    content: [{ type: "text", text: JSON.stringify(profile) }],
    structuredContent: profile,
  };
}

function mcpSseResponse(message) {
  return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("deploy API readiness sampling", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes when transient degraded readiness samples recover", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(degradedResponse())
      .mockResolvedValueOnce(readyResponse())
      .mockResolvedValueOnce(readyResponse())
      .mockResolvedValueOnce(readyResponse());

    const result = await sampleApiReadiness("https://api.example.test", {
      sampleCount: 4,
      delayMs: 0,
      fetchImpl,
      sleepImpl: async () => undefined,
    });

    expect(result.readyCount).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.example.test/api/v1/readyz");
    expect(console.warn).toHaveBeenCalledWith(
      "⚠ API /readyz recovered after transient degraded samples (3/4 ready).",
    );
  });

  it("fails when readiness never recovers", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(degradedResponse())
      .mockResolvedValueOnce(degradedResponse())
      .mockResolvedValueOnce(degradedResponse());

    await expect(sampleApiReadiness("https://api.example.test", {
      sampleCount: 3,
      delayMs: 0,
      fetchImpl,
      sleepImpl: async () => undefined,
    })).rejects.toThrow("API /readyz did not recover during deploy verification");
  });

  it("does not treat a 200 response with a degraded dependency as ready", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(degradedResponse(200))
      .mockResolvedValueOnce(readyResponse());

    await expect(sampleApiReadiness("https://api.example.test", {
      sampleCount: 2,
      delayMs: 0,
      fetchImpl,
      sleepImpl: async () => undefined,
    })).rejects.toThrow("1/2 ready");
  });
});

describe("deploy agent verification", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes when health and MCP catalog_profile smoke are catalog-only", async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const parsed = new URL(url);

      if (parsed.pathname === "/health") {
        expect(init.method).toBe("GET");
        requests.push(`${init.method} ${parsed.pathname}`);
        return agentHealthResponse();
      }
      if (parsed.pathname === "/mcp") {
        expect(init.method).toBe("POST");
        const headers = new Headers(init.headers);
        expect(headers.get("accept")).toBe("application/json, text/event-stream");
        expect(headers.get("content-type")).toBe("application/json");
        const body = JSON.parse(init.body);
        const requestLabel =
          `${init.method} ${parsed.pathname} ${body.method}` +
          `${body.params?.name ? `:${body.params.name}` : ""}`;
        requests.push(requestLabel);
        if (body.method === "initialize") {
          return mcpSseResponse({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: { listChanged: true } },
              serverInfo: { name: "scalius-agent", version: "0.1.0" },
            },
          });
        }
        if (body.method === "tools/list") {
          return mcpSseResponse({
            jsonrpc: "2.0",
            id: body.id,
            result: { tools: agentTools() },
          });
        }
        if (body.method === "tools/call") {
          expect(body.params).toEqual({
            name: "catalog_profile",
            arguments: {},
          });
          return mcpSseResponse({
            jsonrpc: "2.0",
            id: body.id,
            result: agentCatalogProfileMcpResult(),
          });
        }
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await verifyAgentDeploy({
      agentUrl: "https://agent.example.test",
      storefrontUrl: "https://storefront.example.test",
      fetchImpl,
      timeoutMs: 5_000,
    });

    expect(requests).toEqual([
      "GET /health",
      "POST /mcp initialize",
      "POST /mcp tools/list",
      "POST /mcp tools/call:catalog_profile",
    ]);
    expect(result.mcp.tools.toolNames).toEqual([
      "catalog_lookup",
      "catalog_product",
      "catalog_profile",
      "catalog_search",
    ]);
    expect(result.mcp.catalogTool).toMatchObject({
      name: "catalog_profile",
      contentCount: 1,
      profile: {
        endpoint: "https://storefront.example.test/ucp",
        capabilities: [
          "dev.ucp.shopping.catalog.search",
          "dev.ucp.shopping.catalog.lookup",
        ],
      },
    });
    expect(console.log).toHaveBeenCalledWith(
      "✓ Agent /health returned 200; MCP tools: catalog_lookup, catalog_product, " +
      "catalog_profile, catalog_search; catalog_profile call ok (2 catalog capabilities, " +
      "endpoint https://storefront.example.test/ucp).",
    );
  });

  it("fails when the catalog_profile tool returns unsafe UCP commerce capabilities", async () => {
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/health") return agentHealthResponse();
      if (parsed.pathname === "/mcp") {
        const body = JSON.parse(init.body);
        if (body.method === "initialize") {
          return mcpSseResponse({
            jsonrpc: "2.0",
            id: body.id,
            result: { protocolVersion: "2025-06-18", capabilities: {} },
          });
        }
        if (body.method === "tools/list") {
          return mcpSseResponse({
            jsonrpc: "2.0",
            id: body.id,
            result: { tools: agentTools() },
          });
        }
        if (body.method === "tools/call") {
          return mcpSseResponse({
            jsonrpc: "2.0",
            id: body.id,
            result: agentCatalogProfileMcpResult(ucpProfile({
              ...ucpProfile().ucp.capabilities,
              "dev.ucp.shopping.checkout": [{
                version: "2026-07",
                spec: "https://ucp.dev/2026-07/specification/checkout",
                schema: "https://ucp.dev/2026-07/schemas/shopping/checkout.json",
              }],
            })),
          });
        }
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    await expect(verifyAgentDeploy({
      agentUrl: "https://agent.example.test",
      storefrontUrl: "https://storefront.example.test",
      fetchImpl,
      timeoutMs: 5_000,
    })).rejects.toThrow(/catalog_profile failed: .*checkout\/cart\/order\/payment/);
  });

  it("fails when MCP tools expose unsafe capabilities", async () => {
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/health") return agentHealthResponse();
      if (parsed.pathname === "/mcp") {
        const body = JSON.parse(init.body);
        if (body.method === "initialize") {
          return mcpSseResponse({
            jsonrpc: "2.0",
            id: body.id,
            result: { protocolVersion: "2025-06-18", capabilities: {} },
          });
        }
        if (body.method === "tools/list") {
          return mcpSseResponse({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: agentTools({
                catalog_profile: {
                  _meta: { capabilities: ["customer_recovery"] },
                },
              }),
            },
          });
        }
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    await expect(verifyAgentDeploy({
      agentUrl: "https://agent.example.test",
      fetchImpl,
      timeoutMs: 5_000,
    })).rejects.toThrow("checkout/cart/order/payment/customer/recovery terms");
  });
});

describe("deploy target wiring", () => {
  it("accepts non-commerce worker deploy targets", () => {
    expect(parseOnlyTarget(["--only", "ops-monitor"])).toEqual({
      ok: true,
      target: "ops-monitor",
    });
    expect(parseOnlyTarget(["--only", "agent"])).toEqual({
      ok: true,
      target: "agent",
    });

    expect(parseOnlyTarget(["--only", "unknown"])).toMatchObject({
      ok: false,
      message: expect.stringContaining("api, admin, storefront, ops-monitor, agent"),
    });
  });

  it("builds and deploys ops-monitor from its app workspace", () => {
    expect(getBuildCommandForTarget("ops-monitor")).toContain(
      "--filter @scalius/ops-monitor build",
    );

    const command = getDeployCommandForTarget("ops-monitor");
    expect(command.cmd).toContain("exec wrangler deploy");
    expect(command.label).toBe("Deploy Ops Monitor Worker");
    expect(command.cwd).toMatch(/apps\/ops-monitor$/);
  });

  it("builds and deploys agent from its app workspace", () => {
    expect(getBuildCommandForTarget("agent")).toContain(
      "--filter @scalius/agent build",
    );

    const command = getDeployCommandForTarget("agent");
    expect(command.cmd).toContain("exec wrangler deploy");
    expect(command.label).toBe("Deploy Agent Worker");
    expect(command.cwd).toMatch(/apps\/agent$/);
  });
});
