import { describe, expect, it, vi } from "vitest";
import { createAdminAgentWorker } from "./admin-runtime";
import type { FetchLike } from "./storefront-runtime";
import {
  ADMIN_COOKIE,
  ADMIN_MCP_FORBIDDEN_MUTATION_TERMS,
  PUBLIC_ADMIN_MCP_URL,
  adminMcpRpc,
  adminNavigationContext,
  adminNavigationPaths,
  adminNotificationSettingsSummaryContext,
  adminNotificationSettingsSummaryFixture,
  adminPermissionsBody,
  adminProductCopyContext,
  adminSettingsSummaryContext,
  createEnv,
  createExecutionContext,
  fetchCall,
  firstContentBlock,
  initializeAdminMcp,
  json,
  mcpRequest,
  mockJsonFetch,
  requestUrl,
  requireMcpResult,
} from "./runtime-test-support";

describe("admin MCP route", () => {
  it("serves its health identity only on the exact internal host and path", async () => {
    const worker = createAdminAgentWorker();
    const response = await worker.fetch(
      new Request("http://admin-agent.internal/health"),
      createEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      success: true,
      status: "ok",
      service: "scalius-admin-agent",
    });
  });

  it("returns the same bland denial for every non-exact Admin URL before auth or API preflight", async () => {
    const apiFetch = mockJsonFetch(adminPermissionsBody());
    const worker = createAdminAgentWorker();
    const rejectedUrls = [
      PUBLIC_ADMIN_MCP_URL,
      "https://admin-agent.example.test/mcp/admin",
      "https://admin-agent.example.test/health",
      "https://admin-agent.internal/mcp",
      "http://agent.internal/mcp/admin",
      "http://admin-agent.internal/mcp/admin",
      "http://admin-agent.internal/mcp/",
      "http://admin-agent.internal/mcp?session=unexpected",
      "http://admin-agent.internal/%6dcp",
      "http://admin-agent.internal/mcp%2Fadmin",
      "http://other.internal/mcp",
    ];

    for (const url of rejectedUrls) {
      const response = await worker.fetch(
        mcpRequest({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }, {
          Cookie: ADMIN_COOKIE,
        }, url),
        createEnv(apiFetch),
        createExecutionContext(),
      );

      const body = await response.text();
      expect(response.status, url).toBe(404);
      expect(response.headers.get("Cache-Control"), url).toBe("no-store");
      expect(response.headers.get("Content-Type"), url).toContain(
        "application/json",
      );
      expect(JSON.parse(body), url).toEqual({
        success: false,
        error: "not_found",
      });
      expect(body.toLowerCase(), url).not.toContain("admin");
      expect(body.toLowerCase(), url).not.toContain("mcp");
    }
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("fails closed with no-store 401 before MCP handling when Cookie is missing", async () => {
    const apiFetch = mockJsonFetch(adminPermissionsBody());
    const worker = createAdminAgentWorker();
    const response = await worker.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
      createEnv(apiFetch),
      createExecutionContext(),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: "admin_session_required" },
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("does not accept bearer-only auth or call the API without a Cookie", async () => {
    const apiFetch = mockJsonFetch(adminPermissionsBody());
    const worker = createAdminAgentWorker();
    const response = await worker.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }, {
        Authorization: "Bearer not-a-session",
      }),
      createEnv(apiFetch),
      createExecutionContext(),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "admin_session_required" },
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("preflights with Cookie only and never forwards Authorization", async () => {
    const apiFetch = mockJsonFetch(adminPermissionsBody());
    const worker = createAdminAgentWorker();

    await initializeAdminMcp(worker, createEnv(apiFetch), {
      Cookie: ADMIN_COOKIE,
      Authorization: "Bearer must-not-forward",
      "User-Agent": "vitest-admin-client",
    });

    const [input, init] = fetchCall(apiFetch);
    expect(requestUrl(input)).toBe("http://api.internal/api/v1/admin/rbac/my-permissions");
    expect(init?.method).toBe("GET");
    const headers = new Headers(init?.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Cookie")).toBe(ADMIN_COOKIE);
    expect(headers.get("User-Agent")).toBe("vitest-admin-client");
    expect(headers.get("Authorization")).toBeNull();
    expect([...headers.keys()].sort()).toEqual(["accept", "cookie", "user-agent"]);
  });

  it("lists exactly the read-only admin tools after cookie preflight", async () => {
    const apiFetch = mockJsonFetch(adminPermissionsBody());
    const worker = createAdminAgentWorker();
    const env = createEnv(apiFetch);
    const init = await initializeAdminMcp(worker, env, { Cookie: ADMIN_COOKIE });
    const headers: Record<string, string> = { Cookie: ADMIN_COOKIE };
    if (init.sessionId) headers["Mcp-Session-Id"] = init.sessionId;
    if (init.protocolVersion) headers["MCP-Protocol-Version"] = init.protocolVersion;

    const message = await adminMcpRpc(worker, env, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }, headers);
    const result = requireMcpResult(message);
    expect(Array.isArray(result.tools)).toBe(true);
    const tools = result.tools as Array<Record<string, unknown>>;
    expect(tools.map((tool) => tool.name)).toEqual([
      "admin_session_context",
      "admin_navigation_context",
      "admin_product_search",
      "admin_product_copy_context",
      "admin_category_search",
      "admin_collection_search",
      "admin_page_search",
      "admin_order_search",
      "admin_customer_search",
      "admin_media_search",
      "admin_inventory_lookup",
      "admin_dashboard_summary",
      "admin_settings_summary",
      "admin_notification_settings_summary",
      "admin_analytics_summary",
    ]);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
    }
    const serialized = JSON.stringify(tools).toLowerCase();
    for (const unsafeTerm of ADMIN_MCP_FORBIDDEN_MUTATION_TERMS) {
      expect(serialized).not.toContain(unsafeTerm);
    }
  });

  it("calls admin_product_copy_context through the route with preflight and compact safe detail output", async () => {
    const longUserAgent = `vitest-admin-client-${"x".repeat(300)}`;
    const apiFetch = vi.fn<FetchLike>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "http://api.internal/api/v1/admin/products/prod_1") {
        return Promise.resolve(json({
          success: true,
          data: {
            id: "prod_1",
            name: "Khaki Shoes",
            title: "Ignored Title",
            slug: "khaki-shoes",
            isActive: false,
            category: { name: "Shoes", description: "category-private" },
            description: "<p>Soft &amp; light everyday shoe.</p><script>SKU-SECRET checkout payment</script>",
            price: 1299,
            discountAmount: 100,
            discountPercentage: 5,
            variants: [{
              id: "var_1",
              sku: "SKU-SECRET",
              stock: 99,
              barcode: "BARCODE-SECRET",
              price: 1299,
            }],
            sku: "SKU-SECRET",
            stock: 99,
            barcode: "BARCODE-SECRET",
            images: [{ url: "https://cdn.example.test/private.jpg" }],
            primaryImage: "https://cdn.example.test/private.jpg",
            metaTitle: "must-not-leak",
            metaDescription: "must-not-leak",
            canonicalPath: "/products/custom-canonical",
            additionalInfo: [{ title: "Care", content: "must-not-leak" }],
            attributes: [{ value: "must-not-leak" }],
            deletedAt: "2026-07-08T00:00:00.000Z",
            providerPayload: { raw: "provider-secret" },
            mutationUrl: "https://api.example.test/admin/products/prod_1",
            internalOnly: `must-not-leak ${ADMIN_COOKIE}`,
          },
          rawMessage: `must-not-leak ${ADMIN_COOKIE}`,
        }));
      }
      return Promise.resolve(json(adminPermissionsBody()));
    });
    const worker = createAdminAgentWorker();
    const env = createEnv(apiFetch);
    const init = await initializeAdminMcp(worker, env, {
      Cookie: ADMIN_COOKIE,
      Authorization: "Bearer must-not-forward",
      "User-Agent": longUserAgent,
    });
    const headers: Record<string, string> = {
      Cookie: ADMIN_COOKIE,
      Authorization: "Bearer must-not-forward",
      "User-Agent": longUserAgent,
    };
    if (init.sessionId) headers["Mcp-Session-Id"] = init.sessionId;
    if (init.protocolVersion) headers["MCP-Protocol-Version"] = init.protocolVersion;

    const callsBeforeTool = apiFetch.mock.calls.length;
    const message = await adminMcpRpc(worker, env, {
      jsonrpc: "2.0",
      id: 23,
      method: "tools/call",
      params: {
        name: "admin_product_copy_context",
        arguments: { id: "prod_1" },
      },
    }, headers);
    const result = requireMcpResult(message);

    expect(apiFetch.mock.calls.length).toBe(callsBeforeTool + 2);
    const [preflightInput, preflightInit] = fetchCall(apiFetch, callsBeforeTool);
    expect(requestUrl(preflightInput)).toBe("http://api.internal/api/v1/admin/rbac/my-permissions");
    expect(new Headers(preflightInit?.headers).get("Authorization")).toBeNull();

    const [detailInput, detailInit] = fetchCall(apiFetch, callsBeforeTool + 1);
    expect(requestUrl(detailInput)).toBe("http://api.internal/api/v1/admin/products/prod_1");
    expect(detailInit?.method).toBe("GET");
    expect(detailInit?.body).toBeUndefined();
    expect(detailInit?.signal).toBeInstanceOf(AbortSignal);
    const detailHeaders = new Headers(detailInit?.headers);
    expect(detailHeaders.get("Accept")).toBe("application/json");
    expect(detailHeaders.get("Cookie")).toBe(ADMIN_COOKIE);
    expect(detailHeaders.get("User-Agent")).toBe(longUserAgent.slice(0, 256));
    expect(detailHeaders.get("Authorization")).toBeNull();
    expect([...detailHeaders.keys()].sort()).toEqual(["accept", "cookie", "user-agent"]);

    expect(result.isError).toBeUndefined();
    const context = adminProductCopyContext(result);
    expect(context).toEqual({
      source: {
        path: "/api/v1/admin/products/{id}",
        permission: "products.view",
      },
      request: { id: "prod_1" },
      product: {
        id: "prod_1",
        name: "Khaki Shoes",
        slug: "khaki-shoes",
        isActive: false,
        status: "draft",
        route: "/products/custom-canonical",
        categoryName: "Shoes",
        description: {
          content: "Soft & light everyday shoe.",
          excerpt: "Soft & light everyday shoe.",
        },
      },
      limits: {
        maxDescriptionLength: 14000,
        maxDescriptionExcerptLength: 600,
        includesPrices: false,
        includesVariants: false,
        includesSku: false,
        includesStock: false,
        includesBarcodes: false,
        includesImages: false,
        includesDeletedFields: false,
        includesProviderPayloads: false,
        canMutate: false,
      },
    });
    const product = context.product as Record<string, unknown>;
    expect(Object.keys(product).sort()).toEqual([
      "categoryName",
      "description",
      "id",
      "isActive",
      "name",
      "route",
      "slug",
      "status",
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("Ignored Title");
    expect(serialized).not.toContain("category-private");
    expect(serialized).not.toContain("SKU-SECRET");
    expect(serialized).not.toContain("BARCODE-SECRET");
    expect(serialized).not.toContain("checkout");
    expect(serialized).not.toContain("payment");
    expect(serialized).not.toContain("1299");
    expect(serialized).not.toContain("https://cdn.example.test/private.jpg");
    expect(serialized).not.toContain("metaTitle");
    expect(serialized).not.toContain("metaDescription");
    expect(serialized).not.toContain("canonicalPath");
    expect(serialized).not.toContain("additionalInfo");
    expect(serialized).not.toContain("attributes");
    expect(serialized).not.toContain("deletedAt");
    expect(serialized).not.toContain("provider-secret");
    expect(serialized).not.toContain("mutationUrl");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain(ADMIN_COOKIE);
  });

  it("calls admin_settings_summary through the route with no-store response and cookie-only API forwarding", async () => {
    const settingsSummary = {
      general: {
        storeName: "Scalius Test Store",
        currency: "BDT",
      },
      checkout: {
        phoneRequired: true,
        guestCheckoutEnabled: false,
      },
      providers: {
        payment: { configuredCount: 1, activeCount: 1 },
        notifications: { emailReady: true, smsReady: false, whatsappReady: false },
      },
    };
    const apiFetch = vi.fn<FetchLike>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "http://api.internal/api/v1/admin/settings/mcp-summary") {
        return Promise.resolve(json({
          success: true,
          data: settingsSummary,
          ignoredRootSecret: `must-not-leak ${ADMIN_COOKIE}`,
        }));
      }
      return Promise.resolve(json(adminPermissionsBody()));
    });
    const worker = createAdminAgentWorker();
    const env = createEnv(apiFetch);
    const init = await initializeAdminMcp(worker, env, {
      Cookie: ADMIN_COOKIE,
      Authorization: "Bearer must-not-forward",
      "User-Agent": "vitest-admin-client",
    });
    const headers: Record<string, string> = {
      Cookie: ADMIN_COOKIE,
      Authorization: "Bearer must-not-forward",
      "User-Agent": "vitest-admin-client",
    };
    if (init.sessionId) headers["Mcp-Session-Id"] = init.sessionId;
    if (init.protocolVersion) headers["MCP-Protocol-Version"] = init.protocolVersion;

    const callsBeforeTool = apiFetch.mock.calls.length;
    const message = await adminMcpRpc(worker, env, {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: {
        name: "admin_settings_summary",
        arguments: {},
      },
    }, headers);
    const result = requireMcpResult(message);

    expect(apiFetch.mock.calls.length).toBe(callsBeforeTool + 2);
    const [preflightInput, preflightInit] = fetchCall(apiFetch, callsBeforeTool);
    expect(requestUrl(preflightInput)).toBe("http://api.internal/api/v1/admin/rbac/my-permissions");
    expect(new Headers(preflightInit?.headers).get("Authorization")).toBeNull();

    const [settingsInput, settingsInit] = fetchCall(apiFetch, callsBeforeTool + 1);
    expect(requestUrl(settingsInput)).toBe("http://api.internal/api/v1/admin/settings/mcp-summary");
    expect(settingsInit?.method).toBe("GET");
    expect(settingsInit?.body).toBeUndefined();
    const settingsHeaders = new Headers(settingsInit?.headers);
    expect(settingsHeaders.get("Accept")).toBe("application/json");
    expect(settingsHeaders.get("Cookie")).toBe(ADMIN_COOKIE);
    expect(settingsHeaders.get("User-Agent")).toBe("vitest-admin-client");
    expect(settingsHeaders.get("Authorization")).toBeNull();
    expect([...settingsHeaders.keys()].sort()).toEqual(["accept", "cookie", "user-agent"]);
    expect(result.isError).toBeUndefined();
    expect(adminSettingsSummaryContext(result)).toEqual(settingsSummary);
    expect(firstContentBlock(result)).toEqual({
      type: "text",
      text: "Admin settings summary is available.",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("ignoredRootSecret");
    expect(serialized).not.toContain("must-not-leak");
  });

  it("calls admin_notification_settings_summary through the route with no-store response and cookie-only API forwarding", async () => {
    const notificationSummary = adminNotificationSettingsSummaryFixture();
    const rawNotificationSummary = {
      ...notificationSummary,
      ignoredRawProviderError: `raw provider error ${ADMIN_COOKIE}`,
      customer: {
        ...(notificationSummary.customer as Record<string, unknown>),
        provider: "smsnetbd",
        events: [
          {
            ...((notificationSummary.customer as Record<string, unknown>).events as Record<string, unknown>[])[0],
            recipientEmail: "buyer@example.test",
            rawMessage: "HTTP 401 provider said nope",
          },
        ],
      },
    };
    const apiFetch = vi.fn<FetchLike>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "http://api.internal/api/v1/admin/settings/notification-channels/mcp-summary") {
        return Promise.resolve(json({
          success: true,
          data: {
            adminNotificationSettingsSummary: rawNotificationSummary,
          },
          ignoredRootSecret: `must-not-leak ${ADMIN_COOKIE}`,
        }));
      }
      return Promise.resolve(json(adminPermissionsBody()));
    });
    const worker = createAdminAgentWorker();
    const env = createEnv(apiFetch);
    const init = await initializeAdminMcp(worker, env, {
      Cookie: ADMIN_COOKIE,
      Authorization: "Bearer must-not-forward",
      "User-Agent": "vitest-admin-client",
    });
    const headers: Record<string, string> = {
      Cookie: ADMIN_COOKIE,
      Authorization: "Bearer must-not-forward",
      "User-Agent": "vitest-admin-client",
    };
    if (init.sessionId) headers["Mcp-Session-Id"] = init.sessionId;
    if (init.protocolVersion) headers["MCP-Protocol-Version"] = init.protocolVersion;

    const callsBeforeTool = apiFetch.mock.calls.length;
    const message = await adminMcpRpc(worker, env, {
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: {
        name: "admin_notification_settings_summary",
        arguments: {},
      },
    }, headers);
    const result = requireMcpResult(message);

    expect(apiFetch.mock.calls.length).toBe(callsBeforeTool + 2);
    const [preflightInput, preflightInit] = fetchCall(apiFetch, callsBeforeTool);
    expect(requestUrl(preflightInput)).toBe("http://api.internal/api/v1/admin/rbac/my-permissions");
    expect(new Headers(preflightInit?.headers).get("Authorization")).toBeNull();

    const [summaryInput, summaryInit] = fetchCall(apiFetch, callsBeforeTool + 1);
    expect(requestUrl(summaryInput)).toBe(
      "http://api.internal/api/v1/admin/settings/notification-channels/mcp-summary",
    );
    expect(summaryInit?.method).toBe("GET");
    expect(summaryInit?.body).toBeUndefined();
    const summaryHeaders = new Headers(summaryInit?.headers);
    expect(summaryHeaders.get("Accept")).toBe("application/json");
    expect(summaryHeaders.get("Cookie")).toBe(ADMIN_COOKIE);
    expect(summaryHeaders.get("User-Agent")).toBe("vitest-admin-client");
    expect(summaryHeaders.get("Authorization")).toBeNull();
    expect([...summaryHeaders.keys()].sort()).toEqual(["accept", "cookie", "user-agent"]);
    expect(result.isError).toBeUndefined();
    expect(adminNotificationSettingsSummaryContext(result)).toEqual(notificationSummary);
    expect(firstContentBlock(result)).toEqual({
      type: "text",
      text: "Admin notification settings summary is available.",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("ignoredRawProviderError");
    expect(serialized).not.toContain("raw provider error");
    expect(serialized).not.toContain("smsnetbd");
    expect(serialized).not.toContain("buyer@example.test");
    expect(serialized).not.toContain("rawMessage");
    expect(serialized).not.toContain("HTTP 401");
    expect(serialized).not.toContain("ignoredRootSecret");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain(ADMIN_COOKIE);
  });

  it("calls the RBAC endpoint for admin_session_context and returns compact structured content", async () => {
    const apiFetch = mockJsonFetch(adminPermissionsBody());
    const worker = createAdminAgentWorker();
    const env = createEnv(apiFetch);
    const init = await initializeAdminMcp(worker, env, { Cookie: ADMIN_COOKIE });
    const headers: Record<string, string> = { Cookie: ADMIN_COOKIE };
    if (init.sessionId) headers["Mcp-Session-Id"] = init.sessionId;
    if (init.protocolVersion) headers["MCP-Protocol-Version"] = init.protocolVersion;

    const callsBeforeTool = apiFetch.mock.calls.length;
    const message = await adminMcpRpc(worker, env, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "admin_session_context",
        arguments: {},
      },
    }, headers);
    const result = requireMcpResult(message);

    expect(apiFetch.mock.calls.length).toBe(callsBeforeTool + 1);
    expect(requestUrl(fetchCall(apiFetch, apiFetch.mock.calls.length - 1)[0])).toBe(
      "http://api.internal/api/v1/admin/rbac/my-permissions",
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      adminSessionContext: {
        userId: "admin_123",
        isSuperAdmin: false,
        roles: [{ id: "role_manager", name: "Manager" }],
        permissions: ["dashboard.view", "products.view"],
        overrides: { grants: ["orders.view"], denials: ["settings.edit"] },
      },
    });
    expect(firstContentBlock(result)).toMatchObject({
      type: "text",
      text: expect.stringContaining("adminSessionContext"),
    });
  });

  it("returns admin_navigation_context from effective RBAC permissions with bounded static pages", async () => {
    const apiFetch = mockJsonFetch(adminPermissionsBody({
      email: "admin@example.test",
      phone: "+8801000000000",
      permissions: [
        "dashboard.view",
        "products.view",
        "orders.view",
        "settings.general.view",
      ],
    }));
    const worker = createAdminAgentWorker();
    const env = createEnv(apiFetch);
    const init = await initializeAdminMcp(worker, env, { Cookie: ADMIN_COOKIE });
    const headers: Record<string, string> = { Cookie: ADMIN_COOKIE };
    if (init.sessionId) headers["Mcp-Session-Id"] = init.sessionId;
    if (init.protocolVersion) headers["MCP-Protocol-Version"] = init.protocolVersion;

    const callsBeforeTool = apiFetch.mock.calls.length;
    const message = await adminMcpRpc(worker, env, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "admin_navigation_context",
        arguments: {},
      },
    }, headers);
    const result = requireMcpResult(message);
    const context = adminNavigationContext(result);

    expect(apiFetch.mock.calls.length).toBe(callsBeforeTool + 1);
    expect(result.isError).toBeUndefined();
    expect(context).toMatchObject({
      source: {
        permissions: "/api/v1/admin/rbac/my-permissions",
        catalog: "admin-navigation-context:v1",
      },
      session: {
        userId: "admin_123",
        isSuperAdmin: false,
        roleCount: 1,
        permissionCount: 4,
        deniedPermissionCount: 1,
      },
      defaultPath: "/admin",
      limits: {
        maxPages: 24,
        returnedPages: 9,
        catalogPages: 24,
        includesDynamicRoutes: false,
      },
    });
    expect(adminNavigationPaths(context)).toEqual([
      "/admin",
      "/admin/products",
      "/admin/inventory",
      "/admin/orders",
      "/admin/abandoned-checkouts",
      "/admin/settings",
      "/admin/settings/theme",
      "/admin/settings/account",
      "/admin/settings/checkout",
    ]);
    expect(firstContentBlock(result)).toMatchObject({
      type: "text",
      text: expect.stringContaining("adminNavigationContext"),
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("admin@example.test");
    expect(serialized).not.toContain("+8801000000000");
  });

  it("returns an empty admin navigation catalog for a non-superadmin with no effective permissions", async () => {
    const apiFetch = mockJsonFetch(adminPermissionsBody({
      permissions: [],
      overrides: { grants: [], denials: [] },
    }));
    const worker = createAdminAgentWorker();
    const env = createEnv(apiFetch);
    const init = await initializeAdminMcp(worker, env, { Cookie: ADMIN_COOKIE });
    const headers: Record<string, string> = { Cookie: ADMIN_COOKIE };
    if (init.sessionId) headers["Mcp-Session-Id"] = init.sessionId;
    if (init.protocolVersion) headers["MCP-Protocol-Version"] = init.protocolVersion;

    const message = await adminMcpRpc(worker, env, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "admin_navigation_context",
        arguments: {},
      },
    }, headers);
    const result = requireMcpResult(message);
    const context = adminNavigationContext(result);

    expect(context).toMatchObject({
      defaultPath: null,
      limits: {
        returnedPages: 0,
        includesDynamicRoutes: false,
      },
      sections: [],
    });
  });

  it("keeps upstream admin auth failures fail-closed without leaking upstream bodies", async () => {
    const apiFetch = mockJsonFetch({
      success: false,
      error: {
        code: "forbidden",
        message: `raw upstream leak ${ADMIN_COOKIE} admin@example.test`,
      },
    }, 403);
    const worker = createAdminAgentWorker();
    const response = await worker.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }, {
        Cookie: ADMIN_COOKIE,
      }),
      createEnv(apiFetch),
      createExecutionContext(),
    );

    const body = await response.text();
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toContain("admin_session_forbidden");
    expect(body).not.toContain(ADMIN_COOKIE);
    expect(body).not.toContain("admin@example.test");
    expect(body).not.toContain("raw upstream leak");
  });
});
