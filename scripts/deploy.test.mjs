import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getBuildCommandForTarget,
  getDeployCommandForTarget,
  getTypecheckCommandForTarget,
  parseOnlyTarget,
  sampleApiReadiness,
  verifyAdminDeploy,
  verifyStorefrontAgentDeploy,
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
    service: "scalius-storefront-agent",
  }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function adminMcpUnauthenticatedResponse(status = 401, headers = {}) {
  return new Response(JSON.stringify({
    success: false,
    error: { code: status === 403 ? "FORBIDDEN" : "UNAUTHORIZED" },
  }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
      ...headers,
    },
  });
}

function agentTool(name, extra = {}) {
  const description = name === "cart_validate"
    ? "Checks a public storefront cart snapshot for current availability and price truth."
    : `Reads public catalog data for ${name}.`;
  return {
    name,
    description,
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
    agentTool("cart_validate", overrides.cart_validate),
    agentTool("catalog_categories", overrides.catalog_categories),
    agentTool("catalog_search", overrides.catalog_search),
    agentTool("catalog_lookup", overrides.catalog_lookup),
    agentTool("catalog_product", overrides.catalog_product),
    agentTool("catalog_profile", overrides.catalog_profile),
    agentTool("storefront_discovery_policy", overrides.storefront_discovery_policy),
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

function agentCatalogCategoriesMcpResult() {
  const result = {
    catalogCategories: {
      categories: [{
        id: "cat_demo",
        slug: "demo",
        name: "Demo",
        path: "/categories/demo",
      }],
      limit: 1,
      hasMore: true,
    },
  };

  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function agentCatalogSearchMcpResult() {
  const result = {
    ucp: {
      version: "2026-07",
      status: "success",
      capabilities: ["dev.ucp.shopping.catalog.search"],
    },
    products: [{
      id: "gid://scalius/product/prod_release_check",
      title: "Release Check Product",
      url: "https://storefront.example.test/products/release-check-product",
      variants: [{
        id: "gid://scalius/product-variant/var_release_check",
        sku: "REL-1",
      }],
    }],
    pagination: { has_next_page: false, total_count: 1 },
  };

  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function agentCatalogLookupMcpResult(inputId = "gid://scalius/product/prod_release_check") {
  const result = {
    ucp: {
      version: "2026-07",
      status: "success",
      capabilities: ["dev.ucp.shopping.catalog.lookup"],
    },
    products: [{
      id: "gid://scalius/product/prod_release_check",
      variants: [{
        id: "gid://scalius/product-variant/var_release_check",
        inputs: [{ id: inputId, match: "exact" }],
      }],
    }],
  };

  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function agentCatalogProductMcpResult(inputId = "gid://scalius/product/prod_release_check") {
  const result = {
    ucp: {
      version: "2026-07",
      status: "success",
      capabilities: ["dev.ucp.shopping.catalog.lookup"],
    },
    product: {
      id: inputId,
      title: "Release Check Product",
      variants: [{
        id: "gid://scalius/product-variant/var_release_check",
        sku: "REL-1",
      }],
    },
  };

  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function agentDiscoveryPolicyMcpResult() {
  const result = {
    storefrontDiscoveryPolicy: {
      source: { path: "/api/v1/seo" },
      discovery: {
        sitemap: {
          enabled: true,
          sections: {
            staticPages: true,
            products: true,
            categories: true,
            collections: false,
            pages: true,
          },
          urls: [{ type: "index", url: "https://storefront.example.test/sitemap.xml" }],
        },
        feeds: {
          productCatalogEnabled: true,
          includeUnavailableProducts: false,
          variantStrategy: "variants",
          urls: [{
            type: "google",
            url: "https://storefront.example.test/api/product-feed.xml",
          }],
        },
        robots: {
          advertiseSitemap: true,
          robotsUrl: "https://storefront.example.test/robots.txt",
        },
        structuredData: {
          organization: true,
          websiteSearch: true,
          products: true,
          productGroups: true,
          offerShippingDetails: true,
          breadcrumbs: true,
          collections: false,
        },
      },
      returnPolicy: {
        enabled: false,
      },
      limits: {
        readOnly: true,
        canMutate: false,
        includesCustomerData: false,
        includesPaymentData: false,
        includesCheckoutData: false,
      },
    },
  };

  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function agentCartValidationMcpResult() {
  const result = {
    cartValidation: {
      valid: false,
      issueCount: 1,
      issues: [{
        index: 0,
        productId: "release-check-missing-product",
        variantId: "release-check-missing-variant",
        code: "PRODUCT_UNAVAILABLE",
        action: "remove",
        message: "This item is no longer available.",
        productName: null,
        variantLabel: null,
        requestedQuantity: 1,
      }],
      items: [],
      subtotal: 0,
    },
  };

  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function mcpSseResponse(message) {
  return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
    },
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

describe("deploy admin verification", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes when dashboard admin MCP rejects unauthenticated requests with no-store", async () => {
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const parsed = new URL(url);
      expect(parsed.href).toBe("https://dashboard.example.test/api/assistant/mcp");
      expect(init.method).toBe("POST");
      const headers = new Headers(init.headers);
      expect(headers.get("accept")).toBe("application/json, text/event-stream");
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.has("cookie")).toBe(false);
      expect(headers.has("authorization")).toBe(false);
      expect(JSON.parse(init.body)).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
      });

      return adminMcpUnauthenticatedResponse();
    });

    const result = await verifyAdminDeploy({
      dashboardUrl: "https://dashboard.example.test",
      fetchImpl,
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({
      url: "https://dashboard.example.test/api/assistant/mcp",
      statusCode: 401,
      cacheControl: "private, no-cache, no-store, must-revalidate",
    });
    expect(console.log).toHaveBeenCalledWith(
      "✓ Admin MCP rejected unauthenticated request with 401; " +
      "Cache-Control: private, no-cache, no-store, must-revalidate.",
    );
  });

  it("fails when dashboard admin MCP does not fail closed", async () => {
    await expect(verifyAdminDeploy({
      dashboardUrl: "https://dashboard.example.test",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      })),
      timeoutMs: 5_000,
    })).rejects.toThrow("expected 401/403");
  });
});

describe("Storefront Agent deploy verification", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes when health, MCP tools, and catalog_profile smoke stay read-only", async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const parsed = new URL(url);

      if (parsed.pathname === "/health") {
        expect(init.method).toBe("GET");
        requests.push(`${init.method} ${parsed.pathname}`);
        return agentHealthResponse();
      }
      if (parsed.pathname.startsWith("/internal/conversations/")) {
        expect(init.method).toBe("GET");
        requests.push(`${init.method} ${parsed.pathname}`);
        return new Response(JSON.stringify({
          success: false,
          error: "not_found",
        }), {
          status: 404,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
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
              protocolVersion: "2025-11-25",
              capabilities: { tools: { listChanged: true } },
              serverInfo: {
                name: "scalius-storefront-catalog-agent",
                version: "0.1.0",
              },
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
          if (body.params?.name === "catalog_profile") {
            expect(body.params).toEqual({
              name: "catalog_profile",
              arguments: {},
            });
          }
          if (body.params?.name === "catalog_categories") {
            expect(body.params).toEqual({
              name: "catalog_categories",
              arguments: {
                limit: 1,
              },
            });
          }
          if (body.params?.name === "storefront_discovery_policy") {
            expect(body.params).toEqual({
              name: "storefront_discovery_policy",
              arguments: {},
            });
          }
          if (body.params?.name === "catalog_search") {
            expect(body.params).toEqual({
              name: "catalog_search",
              arguments: {
                query: "test",
                limit: 1,
              },
            });
          }
          if (body.params?.name === "catalog_lookup") {
            expect(body.params).toEqual({
              name: "catalog_lookup",
              arguments: {
                ids: ["gid://scalius/product/prod_release_check"],
              },
            });
          }
          if (body.params?.name === "catalog_product") {
            expect(body.params).toEqual({
              name: "catalog_product",
              arguments: {
                id: "gid://scalius/product/prod_release_check",
              },
            });
          }
          if (body.params?.name === "cart_validate") {
            expect(body.params).toEqual({
              name: "cart_validate",
              arguments: {
                items: [{
                  productId: "release-check-missing-product",
                  variantId: "release-check-missing-variant",
                  quantity: 1,
                  unitPrice: 1,
                }],
              },
            });
          }
          return mcpSseResponse({
            jsonrpc: "2.0",
            id: body.id,
            result: body.params?.name === "cart_validate"
              ? agentCartValidationMcpResult()
              : body.params?.name === "catalog_categories"
                ? agentCatalogCategoriesMcpResult()
                : body.params?.name === "storefront_discovery_policy"
                  ? agentDiscoveryPolicyMcpResult()
                  : body.params?.name === "catalog_search"
                    ? agentCatalogSearchMcpResult()
                    : body.params?.name === "catalog_lookup"
                      ? agentCatalogLookupMcpResult(body.params?.arguments?.ids?.[0])
                      : body.params?.name === "catalog_product"
                        ? agentCatalogProductMcpResult(body.params?.arguments?.id)
                        : agentCatalogProfileMcpResult(),
          });
        }
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await verifyStorefrontAgentDeploy({
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
      "POST /mcp tools/call:catalog_categories",
      "POST /mcp tools/call:storefront_discovery_policy",
      "POST /mcp tools/call:catalog_search",
      "POST /mcp tools/call:catalog_lookup",
      "POST /mcp tools/call:catalog_product",
      "POST /mcp tools/call:cart_validate",
      "GET /internal/conversations/conv_abcdefghijklmnopqrstuv/events",
    ]);
    expect(result.mcp.tools.toolNames).toEqual([
      "cart_validate",
      "catalog_categories",
      "catalog_lookup",
      "catalog_product",
      "catalog_profile",
      "catalog_search",
      "storefront_discovery_policy",
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
    expect(result.mcp.cartValidationTool).toMatchObject({
      name: "cart_validate",
      contentCount: 1,
      issueCount: 1,
      firstIssueCode: "PRODUCT_UNAVAILABLE",
    });
    expect(console.log).toHaveBeenCalledWith(
      "✓ Storefront Agent /health returned 200; MCP tools: cart_validate, catalog_categories, " +
      "catalog_lookup, catalog_product, catalog_profile, catalog_search, " +
      "storefront_discovery_policy; catalog_profile call ok (2 catalog capabilities, " +
      "endpoint https://storefront.example.test/ucp); cart_validate call ok; " +
      "public conversation transcripts hidden.",
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
            result: { protocolVersion: "2025-11-25", capabilities: {} },
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

    await expect(verifyStorefrontAgentDeploy({
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
            result: { protocolVersion: "2025-11-25", capabilities: {} },
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

    await expect(verifyStorefrontAgentDeploy({
      agentUrl: "https://agent.example.test",
      fetchImpl,
      timeoutMs: 5_000,
    })).rejects.toThrow("checkout/order/payment/customer/recovery or cart mutation terms");
  });
});

describe("deploy target wiring", () => {
  it("accepts non-commerce worker deploy targets", () => {
    expect(parseOnlyTarget(["--only", "ops-monitor"])).toEqual({
      ok: true,
      target: "ops-monitor",
    });
    expect(parseOnlyTarget(["--only", "admin-agent"])).toEqual({
      ok: true,
      target: "admin-agent",
    });
    expect(parseOnlyTarget(["--only", "storefront-agent"])).toEqual({
      ok: true,
      target: "storefront-agent",
    });

    expect(parseOnlyTarget(["--only", "unknown"])).toMatchObject({
      ok: false,
      message: expect.stringContaining(
        "admin-agent, storefront-agent, api, admin, storefront, ops-monitor",
      ),
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

  it("builds and deploys each Agent from its own app workspace", () => {
    expect(getTypecheckCommandForTarget("admin-agent")).toContain(
      "--filter @scalius/agent-runtime --filter @scalius/admin-agent typecheck",
    );
    expect(getTypecheckCommandForTarget("storefront-agent")).toContain(
      "--filter @scalius/agent-runtime --filter @scalius/storefront-agent typecheck",
    );
    expect(getBuildCommandForTarget("admin-agent")).toContain(
      "--filter @scalius/admin-agent build",
    );
    expect(getBuildCommandForTarget("storefront-agent")).toContain(
      "--filter @scalius/storefront-agent build",
    );

    const adminCommand = getDeployCommandForTarget("admin-agent");
    expect(adminCommand.cmd).toContain("exec wrangler deploy");
    expect(adminCommand.label).toBe("Deploy Admin Agent Worker");
    expect(adminCommand.cwd).toMatch(/apps\/admin-agent$/);

    const storefrontCommand = getDeployCommandForTarget("storefront-agent");
    expect(storefrontCommand.cmd).toContain("exec wrangler deploy");
    expect(storefrontCommand.label).toBe("Deploy Storefront Agent Worker");
    expect(storefrontCommand.cwd).toMatch(/apps\/storefront-agent$/);
  });
});
