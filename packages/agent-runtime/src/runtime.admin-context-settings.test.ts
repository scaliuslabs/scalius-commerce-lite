import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "./storefront-runtime";
import {
  ADMIN_COOKIE,
  adminAnalyticsSummaryContext,
  adminDashboardSummaryContext,
  adminPermissionsBody,
  adminSettingsSummaryContext,
  bootAdmin,
  expectValidationToolError,
  fetchCall,
  firstContentBlock,
  json,
  mockJsonFetch,
  requestUrl,
} from "./runtime-test-support";

describe("admin MCP server — context, dashboard, and settings", () => {
  it("returns a safe MCP tool error when the permissions endpoint rejects the cookie", async () => {
    const apiFetch = mockJsonFetch({
      success: false,
      error: {
        code: "unauthorized",
        message: `raw upstream leak ${ADMIN_COOKIE}`,
      },
    }, 401);
    const { client } = await bootAdmin(apiFetch);

    const result = await client.callTool({
      name: "admin_session_context",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "admin_session_invalid",
        status: 401,
      },
    });
    expect(JSON.stringify(result)).not.toContain(ADMIN_COOKIE);
    expect(JSON.stringify(result)).not.toContain("raw upstream leak");
  });

  it("returns a safe admin_navigation_context tool error when no cookie option is present", async () => {
    const apiFetch = mockJsonFetch(adminPermissionsBody());
    const { client } = await bootAdmin(apiFetch, {
      cookie: null,
      userAgent: "vitest-admin-mcp",
    });

    const result = await client.callTool({
      name: "admin_navigation_context",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "admin_session_required",
        status: 401,
      },
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("calls admin_dashboard_summary through the API binding with strict safe aggregate projection", async () => {
    const longUserAgent = `vitest-admin-mcp-${"x".repeat(300)}`;
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        stats: {
          totalProducts: 12,
          totalCustomers: 34,
          totalRevenue: 999999,
          currentMonth: {
            orders: 5,
            revenue: 1234.5,
            orderGrowth: -2.5,
            revenueGrowth: 4,
            orderStatus: {
              delivered: 1,
              processing: 2,
              shipping: 1,
              cancelled: 1,
              returned: 99,
            },
            recentOrders: [{
              id: "ord_secret_123",
              customerName: "Jane Buyer",
              email: "jane@example.test",
              phone: "+8801712345678",
              providerPayload: { token: "provider-secret-payload" },
              paymentEvidence: "receipt-proof-secret",
            }],
            dailyActivity: [{ date: "2026-07-08", revenue: 777 }],
          },
          lastMonth: {
            orders: 4,
            revenue: 1000,
            totalRevenue: 8888,
            customerEmail: "last-month@example.test",
          },
          unknownField: "must-not-leak",
        },
        recentOrders: [{ id: "ord_top_level_secret" }],
        customerName: "Top Level Buyer",
        email: "top-level@example.test",
        phone: "+8801999999999",
        providerPayload: { raw: "top-level-provider-secret" },
      },
      rawMessage: `must-not-leak ${ADMIN_COOKIE}`,
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: ADMIN_COOKIE,
      userAgent: longUserAgent,
    });

    const result = await client.callTool({
      name: "admin_dashboard_summary",
      arguments: {},
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetchCall(apiFetch);
    expect(requestUrl(input)).toBe("http://api.internal/api/v1/admin/dashboard/metrics-summary");
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Cookie")).toBe(ADMIN_COOKIE);
    expect(headers.get("User-Agent")).toBe(longUserAgent.slice(0, 256));
    expect(headers.get("Authorization")).toBeNull();
    expect([...headers.keys()].sort()).toEqual(["accept", "cookie", "user-agent"]);

    expect(result.isError).toBeUndefined();
    const context = adminDashboardSummaryContext(result as Record<string, unknown>);
    expect(context).toEqual({
      source: {
        path: "/api/v1/admin/dashboard/metrics-summary",
        permission: "dashboard.view",
      },
      stats: {
        totalProducts: 12,
        totalCustomers: 34,
        currentMonth: {
          orders: 5,
          revenue: 1234.5,
          orderGrowth: -2.5,
          revenueGrowth: 4,
          orderStatus: {
            delivered: 1,
            processing: 2,
            shipping: 1,
            cancelled: 1,
          },
        },
        lastMonth: {
          orders: 4,
          revenue: 1000,
        },
      },
      limits: {
        includesRecentOrders: false,
        includesOrderIds: false,
        includesCustomerPii: false,
        includesCustomerContacts: false,
        includesPaymentEvidence: false,
        includesProviderPayloads: false,
        includesLifetimeRevenue: false,
        includesDailyActivity: false,
        canMutate: false,
      },
    });
    expect(firstContentBlock(result)).toEqual({
      type: "text",
      text: "Admin dashboard summary aggregates are available.",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("ord_secret_123");
    expect(serialized).not.toContain("ord_top_level_secret");
    expect(serialized).not.toContain("Jane Buyer");
    expect(serialized).not.toContain("Top Level Buyer");
    expect(serialized).not.toContain("jane@example.test");
    expect(serialized).not.toContain("top-level@example.test");
    expect(serialized).not.toContain("+8801712345678");
    expect(serialized).not.toContain("+8801999999999");
    expect(serialized).not.toContain("provider-secret-payload");
    expect(serialized).not.toContain("top-level-provider-secret");
    expect(serialized).not.toContain("receipt-proof-secret");
    expect(serialized).not.toContain("dailyActivity");
    expect(serialized).not.toContain("totalRevenue");
    expect(serialized).not.toContain("unknownField");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain(ADMIN_COOKIE);
  });

  it("returns a safe admin_dashboard_summary tool error when no cookie option is present", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { stats: { totalProducts: 0 } },
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: null,
      userAgent: "vitest-admin-mcp",
    });

    const result = await client.callTool({
      name: "admin_dashboard_summary",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "admin_session_required",
        status: 401,
      },
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("rejects unexpected admin_dashboard_summary inputs before API fetches", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { stats: { totalProducts: 0 } },
    });
    const { client } = await bootAdmin(apiFetch);

    await expectValidationToolError(client.callTool({
      name: "admin_dashboard_summary",
      arguments: {
        includeRecentOrders: true,
        customerEmail: "customer@example.test",
        orderId: "ord_secret_123",
        Authorization: "Bearer must-not-forward",
      },
    }));

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("keeps admin_dashboard_summary upstream failures fail-closed without leaking upstream bodies", async () => {
    const leak = `raw upstream leak ${ADMIN_COOKIE} admin@example.test +8801712345678 ord_secret provider-secret`;
    const cases: Array<() => Response> = [
      () => json({ success: false, error: { code: "forbidden", message: leak } }, 403),
      () => json({ success: false, error: { code: "server_error", message: leak } }, 500),
      () => new Response(`not json ${leak}`, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
      () => json({ success: false, error: { code: "invalid", message: leak } }),
      () => json({ success: true, data: { stats: [], message: leak } }),
      () => json({ success: true, data: { message: leak } }),
    ];

    for (const makeResponse of cases) {
      const apiFetch = vi.fn<FetchLike>().mockImplementation(() => Promise.resolve(makeResponse()));
      const { client } = await bootAdmin(apiFetch);

      const result = await client.callTool({
        name: "admin_dashboard_summary",
        arguments: {},
      });

      expect(apiFetch).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        adminDashboardSummary: {
          source: {
            path: "/api/v1/admin/dashboard/metrics-summary",
            permission: "dashboard.view",
          },
          stats: null,
          limits: {
            includesRecentOrders: false,
            includesOrderIds: false,
            includesCustomerPii: false,
            includesCustomerContacts: false,
            includesPaymentEvidence: false,
            includesProviderPayloads: false,
            includesLifetimeRevenue: false,
            includesDailyActivity: false,
            canMutate: false,
          },
        },
        error: {
          code: "admin_dashboard_summary_unavailable",
        },
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(ADMIN_COOKIE);
      expect(serialized).not.toContain("admin@example.test");
      expect(serialized).not.toContain("+8801712345678");
      expect(serialized).not.toContain("ord_secret");
      expect(serialized).not.toContain("provider-secret");
      expect(serialized).not.toContain("raw upstream leak");
    }
  });

  it("calls admin_settings_summary through the API binding with exact redacted settings projection", async () => {
    const longUserAgent = `vitest-admin-mcp-${"x".repeat(300)}`;
    const settingsSummary = {
      general: {
        storeName: "Scalius Test Store",
        storefrontUrlConfigured: true,
        currency: "BDT",
      },
      checkout: {
        phoneRequired: true,
        guestCheckoutEnabled: false,
        partialPaymentsEnabled: true,
      },
      discovery: {
        productFeedEnabled: true,
        sitemapEnabled: true,
        ucpCatalogOnly: true,
      },
      providerReadiness: {
        paymentGateways: { configuredCount: 2, activeCount: 1 },
        notifications: { emailReady: true, smsReady: false, whatsappReady: true },
      },
    };
    const apiFetch = mockJsonFetch({
      success: true,
      data: settingsSummary,
      ignoredRootSecret: `must-not-leak ${ADMIN_COOKIE} provider-secret`,
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: ADMIN_COOKIE,
      userAgent: longUserAgent,
    });

    const result = await client.callTool({
      name: "admin_settings_summary",
      arguments: {},
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetchCall(apiFetch);
    expect(requestUrl(input)).toBe("http://api.internal/api/v1/admin/settings/mcp-summary");
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Cookie")).toBe(ADMIN_COOKIE);
    expect(headers.get("User-Agent")).toBe(longUserAgent.slice(0, 256));
    expect(headers.get("Authorization")).toBeNull();
    expect([...headers.keys()].sort()).toEqual(["accept", "cookie", "user-agent"]);

    expect(result.isError).toBeUndefined();
    expect(adminSettingsSummaryContext(result as Record<string, unknown>)).toEqual(settingsSummary);
    expect(firstContentBlock(result)).toEqual({
      type: "text",
      text: "Admin settings summary is available.",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("ignoredRootSecret");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("provider-secret");
    expect(serialized).not.toContain(ADMIN_COOKIE);
  });

  it("returns a safe admin_settings_summary tool error when no cookie option is present", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { general: { storeName: "Scalius Test Store" } },
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: null,
      userAgent: "vitest-admin-mcp",
    });

    const result = await client.callTool({
      name: "admin_settings_summary",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "admin_session_required",
        status: 401,
      },
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("rejects unexpected admin_settings_summary inputs before API fetches", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { general: { storeName: "Scalius Test Store" } },
    });
    const { client } = await bootAdmin(apiFetch);

    await expectValidationToolError(client.callTool({
      name: "admin_settings_summary",
      arguments: {
        includeSecrets: true,
        providerCredential: "provider-secret",
        Authorization: "Bearer must-not-forward",
      },
    }));

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("keeps admin_settings_summary upstream failures fail-closed without leaking upstream bodies", async () => {
    const leak = `raw upstream leak ${ADMIN_COOKIE} admin@example.test +8801712345678 provider-secret`;
    const cases: Array<{ makeResponse: () => Response; expectedStatus: number }> = [
      {
        makeResponse: () => json({ success: false, error: { code: "unauthorized", message: leak } }, 401),
        expectedStatus: 401,
      },
      {
        makeResponse: () => json({ success: false, error: { code: "forbidden", message: leak } }, 403),
        expectedStatus: 403,
      },
      {
        makeResponse: () => json({ success: false, error: { code: "server_error", message: leak } }, 500),
        expectedStatus: 503,
      },
      {
        makeResponse: () => new Response(`not json ${leak}`, {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
        expectedStatus: 503,
      },
      {
        makeResponse: () => json({ success: false, error: { code: "invalid", message: leak } }),
        expectedStatus: 503,
      },
      {
        makeResponse: () => json({ success: true, data: [], message: leak }),
        expectedStatus: 503,
      },
      {
        makeResponse: () => json({ success: true, data: null, message: leak }),
        expectedStatus: 503,
      },
    ];

    for (const { makeResponse, expectedStatus } of cases) {
      const apiFetch = vi.fn<FetchLike>().mockImplementation(() => Promise.resolve(makeResponse()));
      const { client } = await bootAdmin(apiFetch);

      const result = await client.callTool({
        name: "admin_settings_summary",
        arguments: {},
      });

      expect(apiFetch).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        adminSettingsSummary: null,
        error: {
          code: "admin_settings_summary_unavailable",
          status: expectedStatus,
        },
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(ADMIN_COOKIE);
      expect(serialized).not.toContain("admin@example.test");
      expect(serialized).not.toContain("+8801712345678");
      expect(serialized).not.toContain("provider-secret");
      expect(serialized).not.toContain("raw upstream leak");
    }
  });

  it("calls admin_analytics_summary through the API binding with redacted provider readiness", async () => {
    const longUserAgent = `vitest-admin-mcp-${"x".repeat(300)}`;
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        summary: {
          totalProviders: 6,
          browserReadyProviders: 1,
          draftProviders: 1,
          blockedProviders: 1,
          notConfiguredProviders: 3,
          serverReadyProviders: 1,
        },
        providers: [{
          provider: "facebook_pixel",
          label: "Facebook Pixel",
          browser: {
            status: "blocked",
            configured: false,
            activeScriptCount: 2,
            readyScriptCount: 1,
            draftScriptCount: 1,
            blockedScriptCount: 1,
            message: "Blocked script message must not leak pixel ID 123456",
            issues: [
              "Access token must not leak",
              "Pixel ID 123456 must not leak",
            ],
            config: "<script>secret pixel</script>",
          },
          serverSide: {
            status: "ready",
            configured: true,
            label: "Server ready",
            message: "Meta CAPI is enabled with access token secret-token.",
            accessToken: "secret-token",
            pixelId: "123456",
          },
          config: "<script>secret browser config</script>",
          unknownSecret: `must-not-leak ${ADMIN_COOKIE}`,
        }],
      },
      ignoredRootSecret: "accessToken secret-token",
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: ADMIN_COOKIE,
      userAgent: longUserAgent,
    });

    const result = await client.callTool({
      name: "admin_analytics_summary",
      arguments: {},
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetchCall(apiFetch);
    expect(requestUrl(input)).toBe("http://api.internal/api/v1/admin/analytics/health");
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Cookie")).toBe(ADMIN_COOKIE);
    expect(headers.get("User-Agent")).toBe(longUserAgent.slice(0, 256));
    expect(headers.get("Authorization")).toBeNull();
    expect([...headers.keys()].sort()).toEqual(["accept", "cookie", "user-agent"]);

    expect(result.isError).toBeUndefined();
    expect(adminAnalyticsSummaryContext(result as Record<string, unknown>)).toEqual({
      source: {
        path: "/api/v1/admin/analytics/health",
        permission: "analytics.view",
        version: "admin-analytics-summary:v1",
      },
      summary: {
        totalProviders: 6,
        browserReadyProviders: 1,
        draftProviders: 1,
        blockedProviders: 1,
        notConfiguredProviders: 3,
        serverReadyProviders: 1,
      },
      providers: [{
        provider: "facebook_pixel",
        label: "Facebook Pixel",
        browser: {
          status: "blocked",
          configured: false,
          activeScriptCount: 2,
          readyScriptCount: 1,
          draftScriptCount: 1,
          blockedScriptCount: 1,
          issueCount: 2,
        },
        serverSide: {
          status: "ready",
          configured: true,
          label: "Server ready",
        },
      }],
      limits: {
        includesScriptConfig: false,
        includesAnalyticsSnippets: false,
        includesCustomCode: false,
        includesProviderIdentifiers: false,
        includesCredentials: false,
        includesRawIssues: false,
        includesProviderMessages: false,
        includesProviderPayloads: false,
        canMutate: false,
      },
    });
    expect(firstContentBlock(result)).toEqual({
      type: "text",
      text: "Admin analytics summary is available.",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("message");
    expect(serialized).not.toContain("issues");
    expect(serialized).not.toContain("Access token");
    expect(serialized).not.toContain("Pixel ID");
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("123456");
    expect(serialized).not.toContain("<script>");
    expect(serialized).not.toContain("unknownSecret");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain(ADMIN_COOKIE);
  });

  it("returns a safe admin_analytics_summary tool error when no cookie option is present", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        summary: {
          totalProviders: 0,
          browserReadyProviders: 0,
          draftProviders: 0,
          blockedProviders: 0,
          notConfiguredProviders: 0,
          serverReadyProviders: 0,
        },
        providers: [],
      },
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: null,
      userAgent: "vitest-admin-mcp",
    });

    const result = await client.callTool({
      name: "admin_analytics_summary",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "admin_session_required",
        status: 401,
      },
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("rejects unexpected admin_analytics_summary inputs before API fetches", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        summary: {
          totalProviders: 0,
          browserReadyProviders: 0,
          draftProviders: 0,
          blockedProviders: 0,
          notConfiguredProviders: 0,
          serverReadyProviders: 0,
        },
        providers: [],
      },
    });
    const { client } = await bootAdmin(apiFetch);

    await expectValidationToolError(client.callTool({
      name: "admin_analytics_summary",
      arguments: {
        includeConfig: true,
        includeIssues: true,
        accessToken: "secret-token",
        Authorization: "Bearer must-not-forward",
      },
    }));

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("keeps admin_analytics_summary upstream failures fail-closed without leaking upstream bodies", async () => {
    const leak = `raw upstream leak ${ADMIN_COOKIE} admin@example.test accessToken secret-token pixel 123456`;
    const cases: Array<{ makeResponse: () => Response; expectedStatus: number }> = [
      {
        makeResponse: () => json({ success: false, error: { code: "unauthorized", message: leak } }, 401),
        expectedStatus: 401,
      },
      {
        makeResponse: () => json({ success: false, error: { code: "forbidden", message: leak } }, 403),
        expectedStatus: 403,
      },
      {
        makeResponse: () => json({ success: false, error: { code: "server_error", message: leak } }, 500),
        expectedStatus: 503,
      },
      {
        makeResponse: () => new Response(`not json ${leak}`, {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
        expectedStatus: 503,
      },
      {
        makeResponse: () => json({ success: true, data: { providers: [] }, message: leak }),
        expectedStatus: 503,
      },
      {
        makeResponse: () => json({
          success: true,
          data: {
            summary: {
              totalProviders: 1,
              browserReadyProviders: 0,
              draftProviders: 0,
              blockedProviders: 1,
              notConfiguredProviders: 0,
              serverReadyProviders: 0,
            },
            providers: [{
              provider: "facebook_pixel",
              label: "Facebook Pixel",
              browser: {
                status: "leaky",
                configured: false,
                activeScriptCount: 1,
                readyScriptCount: 0,
                draftScriptCount: 0,
                blockedScriptCount: 1,
                issues: [leak],
              },
              serverSide: {
                status: "blocked",
                configured: false,
                label: "Server blocked",
                message: leak,
              },
            }],
          },
        }),
        expectedStatus: 503,
      },
    ];

    for (const { makeResponse, expectedStatus } of cases) {
      const apiFetch = vi.fn<FetchLike>().mockImplementation(() => Promise.resolve(makeResponse()));
      const { client } = await bootAdmin(apiFetch);

      const result = await client.callTool({
        name: "admin_analytics_summary",
        arguments: {},
      });

      expect(apiFetch).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        adminAnalyticsSummary: {
          source: {
            path: "/api/v1/admin/analytics/health",
            permission: "analytics.view",
            version: "admin-analytics-summary:v1",
          },
          summary: null,
          providers: [],
          limits: {
            includesScriptConfig: false,
            includesAnalyticsSnippets: false,
            includesCustomCode: false,
            includesProviderIdentifiers: false,
            includesCredentials: false,
            includesRawIssues: false,
            includesProviderMessages: false,
            includesProviderPayloads: false,
            canMutate: false,
          },
        },
        error: {
          code: "admin_analytics_summary_unavailable",
          status: expectedStatus,
        },
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(ADMIN_COOKIE);
      expect(serialized).not.toContain("admin@example.test");
      expect(serialized).not.toContain("secret-token");
      expect(serialized).not.toContain("123456");
      expect(serialized).not.toContain("raw upstream leak");
    }
  });
});
