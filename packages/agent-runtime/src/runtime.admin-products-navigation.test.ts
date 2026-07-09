import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "./storefront-runtime";
import {
  ADMIN_COOKIE,
  adminNavigationContext,
  adminNavigationPaths,
  adminPermissionsBody,
  adminProductSearchContext,
  bootAdmin,
  expectValidationToolError,
  fetchCall,
  json,
  mockJsonFetch,
  requestUrl,
} from "./runtime-test-support";

describe("admin MCP server — products and navigation", () => {
  it("calls admin_product_search through the API binding with fixed search query and compact output", async () => {
    const longUserAgent = `vitest-admin-mcp-${"x".repeat(300)}`;
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        products: [{
          id: "prod_1",
          name: "Khaki Shoes",
          slug: "khaki-shoes",
          isActive: true,
          category: { name: "Shoes", description: "category-private" },
          variantCount: 2,
          imageCount: 4,
          updatedAt: "2026-07-07T10:30:00.000Z",
          sku: "SKU-SECRET",
          price: 1200,
          discountType: "flat",
          discountAmount: 100,
          discountPercentage: 5,
          primaryImage: "https://cdn.example.test/private.jpg",
          deletedAt: "2026-07-08T00:00:00.000Z",
          stock: 99,
          barcode: "BARCODE-SECRET",
          description: "raw product description",
          internalOnly: "must-not-leak",
        }],
        pagination: {
          page: 2,
          limit: 3,
          total: 9,
          totalPages: 3,
          rawCursor: "must-not-leak",
        },
      },
      rawMessage: `must-not-leak ${ADMIN_COOKIE}`,
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: ADMIN_COOKIE,
      userAgent: longUserAgent,
    });

    const result = await client.callTool({
      name: "admin_product_search",
      arguments: { query: "  khaki shoes  ", limit: 3, page: 2 },
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetchCall(apiFetch);
    const url = new URL(requestUrl(input));
    expect(`${url.origin}${url.pathname}`).toBe("http://api.internal/api/v1/admin/products");
    expect([...url.searchParams.entries()]).toEqual([
      ["search", "khaki shoes"],
      ["page", "2"],
      ["limit", "3"],
      ["sort", "updatedAt"],
      ["order", "desc"],
    ]);
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
    const context = adminProductSearchContext(result as Record<string, unknown>);
    expect(context).toEqual({
      source: { path: "/api/v1/admin/products" },
      query: {
        query: "khaki shoes",
        page: 2,
        limit: 3,
        sort: "updatedAt",
        order: "desc",
      },
      products: [{
        id: "prod_1",
        name: "Khaki Shoes",
        slug: "khaki-shoes",
        isActive: true,
        categoryName: "Shoes",
        variantCount: 2,
        imageCount: 4,
        updatedAt: "2026-07-07T10:30:00.000Z",
      }],
      pagination: {
        page: 2,
        limit: 3,
        total: 9,
        totalPages: 3,
      },
      limits: {
        maxProducts: 10,
        includesTrashed: false,
        includesStock: false,
      },
    });
    const products = context.products as Array<Record<string, unknown>>;
    expect(products).toHaveLength(1);
    const product = products[0];
    if (!product) throw new Error("Expected compact admin product");
    expect(Object.keys(product).sort()).toEqual([
      "categoryName",
      "id",
      "imageCount",
      "isActive",
      "name",
      "slug",
      "updatedAt",
      "variantCount",
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("SKU-SECRET");
    expect(serialized).not.toContain("BARCODE-SECRET");
    expect(serialized).not.toContain("raw product description");
    expect(serialized).not.toContain("https://cdn.example.test/private.jpg");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain(ADMIN_COOKIE);
  });

  it("keeps admin_product_search upstream failures fail-closed without leaking upstream bodies", async () => {
    const leak = `raw upstream leak ${ADMIN_COOKIE} admin@example.test`;
    const cases: Array<() => Response> = [
      () => json({ success: false, error: { code: "forbidden", message: leak } }, 403),
      () => json({ success: false, error: { code: "server_error", message: leak } }, 500),
      () => new Response(`not json ${leak}`, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
      () => json({ success: false, error: { code: "invalid", message: leak } }),
    ];

    for (const makeResponse of cases) {
      const apiFetch = vi.fn<FetchLike>().mockImplementation(() => Promise.resolve(makeResponse()));
      const { client } = await bootAdmin(apiFetch);

      const result = await client.callTool({
        name: "admin_product_search",
        arguments: { query: "khaki" },
      });

      expect(apiFetch).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        adminProductSearch: {
          source: { path: "/api/v1/admin/products" },
          query: {
            query: "khaki",
            page: 1,
            limit: 5,
            sort: "updatedAt",
            order: "desc",
          },
          products: [],
          pagination: null,
          limits: {
            maxProducts: 10,
            includesTrashed: false,
            includesStock: false,
          },
        },
        error: {
          code: "admin_product_unavailable",
        },
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(ADMIN_COOKIE);
      expect(serialized).not.toContain("admin@example.test");
      expect(serialized).not.toContain("raw upstream leak");
    }
  });

  it("returns a safe admin_product_search tool error when no cookie option is present", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { products: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } },
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: null,
      userAgent: "vitest-admin-mcp",
    });

    const result = await client.callTool({
      name: "admin_product_search",
      arguments: { query: "khaki" },
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

  it("rejects unbounded admin_product_search inputs before API fetches", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { products: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } },
    });
    const { client } = await bootAdmin(apiFetch);

    await expectValidationToolError(client.callTool({
      name: "admin_product_search",
      arguments: { query: "", limit: 5 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_product_search",
      arguments: { query: "x".repeat(121), limit: 5 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_product_search",
      arguments: { query: "khaki", limit: 11 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_product_search",
      arguments: { query: "khaki", page: 21 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_product_search",
      arguments: {
        query: "khaki",
        search: "old-field",
        categoryId: "cat_1",
        includeTrashed: true,
        Authorization: "Bearer must-not-forward",
        receiptToken: "chk_secret",
      },
    }));

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("keeps admin_product_copy_context upstream failures fail-closed without leaking upstream bodies", async () => {
    const leak = `raw upstream leak ${ADMIN_COOKIE} admin@example.test SKU-SECRET BARCODE-SECRET`;
    const cases: Array<{ makeResponse: () => Response; expectedStatus: number }> = [
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
        makeResponse: () => json({
          success: true,
          data: {
            id: "prod_1",
            name: "Khaki Shoes",
            slug: "khaki-shoes",
            price: 1200,
            message: leak,
          },
        }),
        expectedStatus: 503,
      },
    ];

    for (const { makeResponse, expectedStatus } of cases) {
      const apiFetch = vi.fn<FetchLike>().mockImplementation(() => Promise.resolve(makeResponse()));
      const { client } = await bootAdmin(apiFetch);

      const result = await client.callTool({
        name: "admin_product_copy_context",
        arguments: { id: "prod_1" },
      });

      expect(apiFetch).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        adminProductCopyContext: {
          source: {
            path: "/api/v1/admin/products/{id}",
            permission: "products.view",
          },
          request: { id: "prod_1" },
          product: null,
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
        },
        error: {
          code: "admin_product_copy_context_unavailable",
          status: expectedStatus,
        },
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(ADMIN_COOKIE);
      expect(serialized).not.toContain("admin@example.test");
      expect(serialized).not.toContain("SKU-SECRET");
      expect(serialized).not.toContain("BARCODE-SECRET");
      expect(serialized).not.toContain("raw upstream leak");
    }
  });

  it("returns a safe admin_product_copy_context tool error when no cookie option is present", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        id: "prod_1",
        name: "Khaki Shoes",
        slug: "khaki-shoes",
        isActive: true,
        description: null,
      },
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: null,
      userAgent: "vitest-admin-mcp",
    });

    const result = await client.callTool({
      name: "admin_product_copy_context",
      arguments: { id: "prod_1" },
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

  it("rejects unbounded admin_product_copy_context inputs before API fetches", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        id: "prod_1",
        name: "Khaki Shoes",
        slug: "khaki-shoes",
        isActive: true,
        description: null,
      },
    });
    const { client } = await bootAdmin(apiFetch);

    await expectValidationToolError(client.callTool({
      name: "admin_product_copy_context",
      arguments: { id: "" },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_product_copy_context",
      arguments: { id: "x".repeat(161) },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_product_copy_context",
      arguments: {
        id: "prod_1",
        includeVariants: true,
        includeSku: true,
        includeStock: true,
        includeImages: true,
        includeDeleted: true,
        price: 1200,
        Authorization: "Bearer must-not-forward",
      },
    }));

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("bounds admin_navigation_context output for superadmins and drops unknown upstream fields", async () => {
    const apiFetch = mockJsonFetch(adminPermissionsBody());
    const { client } = await bootAdmin(apiFetch, {
      cookie: ADMIN_COOKIE,
      userAgent: "vitest-admin-mcp",
      permissionsBody: adminPermissionsBody({
        isSuperAdmin: true,
        permissions: Array.from({ length: 200 }, (_, index) => `synthetic.${index}`),
        email: "admin@example.test",
        providerCredentials: "must-not-leak",
      }),
    });

    const result = await client.callTool({
      name: "admin_navigation_context",
      arguments: {},
    });
    const context = adminNavigationContext(result as Record<string, unknown>);

    expect(result.isError).toBeUndefined();
    expect(adminNavigationPaths(context)).toHaveLength(24);
    expect(context).toMatchObject({
      defaultPath: "/admin",
      limits: {
        maxPages: 24,
        returnedPages: 24,
        catalogPages: 24,
        includesDynamicRoutes: false,
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("admin@example.test");
    expect(serialized).not.toContain("must-not-leak");
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
