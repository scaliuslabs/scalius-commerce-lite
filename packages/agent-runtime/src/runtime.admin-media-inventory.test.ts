import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "./storefront-runtime";
import {
  ADMIN_COOKIE,
  adminInventoryLookupContext,
  adminMediaSearchContext,
  bootAdmin,
  expectValidationToolError,
  fetchCall,
  json,
  mockJsonFetch,
  requestUrl,
} from "./runtime-test-support";

describe("admin MCP server — media and inventory", () => {
  it("calls admin_media_search through the API binding with fixed search query and compact output", async () => {
    const longUserAgent = `vitest-admin-mcp-${"x".repeat(300)}`;
    const overlongMediaUrl = `https://cdn.example.test/${"x".repeat(1000)}`;
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        files: [{
          id: "media_1",
          filename: "summer-shoes.jpg",
          url: "https://cdn.example.test/media/summer-shoes.jpg",
          mimeType: "image/jpeg",
          size: 123456,
          altText: "Summer shoes",
          width: 1200,
          height: 800,
          folderId: "folder_summer",
          createdAt: "2026-07-07T10:00:00.000Z",
          updatedAt: "2026-07-07T10:30:00.000Z",
          deletedAt: "2026-07-08T00:00:00.000Z",
          deletedBy: "admin_2",
          storageKey: "private/storage/key",
          checksum: "sha256-secret",
          uploadMetadata: { ip: "127.0.0.1", userAgent: "must-not-leak" },
          providerError: `raw provider leak ${ADMIN_COOKIE}`,
          mutationUrl: "https://cdn.example.test/delete/media_1",
        }, {
          id: "media_2",
          filename: "local-banner.png",
          url: "/uploads/local-banner.png",
          mimeType: "image/png",
          size: 0,
          width: 0,
          height: 0,
          folderId: "folder_summer",
          createdAt: 1783516200,
          updatedAt: "2026-07-07T11:30:00.000Z",
        }, {
          id: "media_unsafe",
          filename: "unsafe.jpg",
          url: "https://user:pass@cdn.example.test/media/unsafe.jpg",
          mimeType: "image/jpeg",
          size: 50,
          createdAt: "2026-07-07T12:00:00.000Z",
          updatedAt: "2026-07-07T12:30:00.000Z",
        }, {
          id: "media_query",
          filename: "query.jpg",
          url: "https://cdn.example.test/media/query.jpg?token=secret",
          mimeType: "image/jpeg",
          size: 60,
        }, {
          id: "media_protocol_relative",
          filename: "protocol-relative.jpg",
          url: "//cdn.example.test/media/protocol-relative.jpg",
          mimeType: "image/jpeg",
          size: 70,
        }, {
          id: "media_long_url",
          filename: "long-url.jpg",
          url: overlongMediaUrl,
          mimeType: "image/jpeg",
          size: 80,
        }],
        pagination: {
          page: 2,
          limit: 3,
          total: 9,
          totalPages: 3,
          cursor: "must-not-leak",
        },
      },
      rawMessage: `must-not-leak ${ADMIN_COOKIE}`,
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: ADMIN_COOKIE,
      userAgent: longUserAgent,
    });

    const result = await client.callTool({
      name: "admin_media_search",
      arguments: {
        query: "  summer shoes  ",
        limit: 3,
        page: 2,
        folderId: "  folder_summer  ",
        mimeType: "  image/jpeg  ",
      },
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetchCall(apiFetch);
    const url = new URL(requestUrl(input));
    expect(`${url.origin}${url.pathname}`).toBe("http://api.internal/api/v1/admin/media");
    expect([...url.searchParams.entries()]).toEqual([
      ["page", "2"],
      ["limit", "3"],
      ["search", "summer shoes"],
      ["folderId", "folder_summer"],
      ["mimeType", "image/jpeg"],
      ["sortBy", "createdAt"],
      ["sortOrder", "desc"],
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
    const context = adminMediaSearchContext(result as Record<string, unknown>);
    expect(context).toEqual({
      source: { path: "/api/v1/admin/media" },
      query: {
        page: 2,
        limit: 3,
        sortBy: "createdAt",
        sortOrder: "desc",
        query: "summer shoes",
        folderId: "folder_summer",
        mimeType: "image/jpeg",
      },
      files: [{
        id: "media_1",
        filename: "summer-shoes.jpg",
        url: "https://cdn.example.test/media/summer-shoes.jpg",
        mimeType: "image/jpeg",
        size: 123456,
        altText: "Summer shoes",
        width: 1200,
        height: 800,
        folderId: "folder_summer",
        createdAt: "2026-07-07T10:00:00.000Z",
        updatedAt: "2026-07-07T10:30:00.000Z",
      }, {
        id: "media_2",
        filename: "local-banner.png",
        url: "/uploads/local-banner.png",
        mimeType: "image/png",
        size: 0,
        width: 0,
        height: 0,
        folderId: "folder_summer",
        createdAt: 1783516200,
        updatedAt: "2026-07-07T11:30:00.000Z",
      }, {
        id: "media_unsafe",
        filename: "unsafe.jpg",
        mimeType: "image/jpeg",
        size: 50,
        createdAt: "2026-07-07T12:00:00.000Z",
        updatedAt: "2026-07-07T12:30:00.000Z",
      }, {
        id: "media_query",
        filename: "query.jpg",
        mimeType: "image/jpeg",
        size: 60,
      }, {
        id: "media_protocol_relative",
        filename: "protocol-relative.jpg",
        mimeType: "image/jpeg",
        size: 70,
      }, {
        id: "media_long_url",
        filename: "long-url.jpg",
        mimeType: "image/jpeg",
        size: 80,
      }],
      pagination: {
        page: 2,
        limit: 3,
        total: 9,
        totalPages: 3,
      },
      limits: {
        maxFiles: 10,
        includesDeletedFields: false,
        includesStorageKeys: false,
        includesUploadMetadata: false,
        includesMutationAuthority: false,
      },
    });
    const files = context.files as Array<Record<string, unknown>>;
    expect(files).toHaveLength(6);
    const file = files[0];
    if (!file) throw new Error("Expected compact admin media file");
    expect(Object.keys(file).sort()).toEqual([
      "altText",
      "createdAt",
      "filename",
      "folderId",
      "height",
      "id",
      "mimeType",
      "size",
      "updatedAt",
      "url",
      "width",
    ]);
    expect(files[2]).not.toHaveProperty("url");
    expect(files[3]).not.toHaveProperty("url");
    expect(files[4]).not.toHaveProperty("url");
    expect(files[5]).not.toHaveProperty("url");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("deletedAt");
    expect(serialized).not.toContain("deletedBy");
    expect(serialized).not.toContain("private/storage/key");
    expect(serialized).not.toContain("sha256-secret");
    expect(serialized).not.toContain("uploadMetadata");
    expect(serialized).not.toContain("raw provider leak");
    expect(serialized).not.toContain("delete/media_1");
    expect(serialized).not.toContain("user:pass");
    expect(serialized).not.toContain("?token=secret");
    expect(serialized).not.toContain("//cdn.example.test/media/protocol-relative.jpg");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain(ADMIN_COOKIE);
  });

  it("allows admin_media_search latest listing without a query while keeping limits bounded", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        files: Array.from({ length: 11 }, (_, index) => ({
          id: `media_${index}`,
          filename: `latest-${index}.jpg`,
          url: `/uploads/latest-${index}.jpg`,
          mimeType: "image/jpeg",
          size: index,
        })),
        pagination: {
          page: 1,
          limit: 10,
          total: 11,
          totalPages: 2,
        },
      },
    });
    const { client } = await bootAdmin(apiFetch);

    const result = await client.callTool({
      name: "admin_media_search",
      arguments: { limit: 10 },
    });

    const [input] = fetchCall(apiFetch);
    const url = new URL(requestUrl(input));
    expect([...url.searchParams.entries()]).toEqual([
      ["page", "1"],
      ["limit", "10"],
      ["sortBy", "createdAt"],
      ["sortOrder", "desc"],
    ]);
    expect(url.searchParams.has("search")).toBe(false);

    const context = adminMediaSearchContext(result as Record<string, unknown>);
    expect(context.query).toEqual({
      page: 1,
      limit: 10,
      sortBy: "createdAt",
      sortOrder: "desc",
    });
    expect(context.files).toHaveLength(10);
    expect(context.limits).toMatchObject({ maxFiles: 10 });
  });

  it("returns a safe admin_media_search tool error when no cookie option is present", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { files: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } },
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: null,
      userAgent: "vitest-admin-mcp",
    });

    const result = await client.callTool({
      name: "admin_media_search",
      arguments: { query: "summer" },
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

  it("rejects unbounded admin_media_search inputs before API fetches", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { files: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } },
    });
    const { client } = await bootAdmin(apiFetch);

    await expectValidationToolError(client.callTool({
      name: "admin_media_search",
      arguments: { query: "x".repeat(121), limit: 5 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_media_search",
      arguments: { limit: 11 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_media_search",
      arguments: { page: 21 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_media_search",
      arguments: { folderId: "x".repeat(161) },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_media_search",
      arguments: { mimeType: "x".repeat(81) },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_media_search",
      arguments: {
        query: "summer",
        search: "old-field",
        sortBy: "filename",
        sortOrder: "asc",
        upload: true,
        delete: true,
        moveToFolderId: "folder_other",
        filters: { width: 1200 },
        includeDeleted: true,
        storageKey: "private/storage/key",
        Authorization: "Bearer must-not-forward",
      },
    }));

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("keeps admin_media_search upstream failures fail-closed without leaking upstream bodies", async () => {
    const leak = `raw upstream leak ${ADMIN_COOKIE} admin@example.test +8801712345678`;
    const cases: Array<() => Response> = [
      () => json({ success: false, error: { code: "forbidden", message: leak } }, 403),
      () => json({ success: false, error: { code: "server_error", message: leak } }, 500),
      () => new Response(`not json ${leak}`, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
      () => json({ success: false, error: { code: "invalid", message: leak } }),
      () => json({ success: true, data: { files: [], message: leak } }),
    ];

    for (const makeResponse of cases) {
      const apiFetch = vi.fn<FetchLike>().mockImplementation(() => Promise.resolve(makeResponse()));
      const { client } = await bootAdmin(apiFetch);

      const result = await client.callTool({
        name: "admin_media_search",
        arguments: { query: "summer" },
      });

      expect(apiFetch).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        adminMediaSearch: {
          source: { path: "/api/v1/admin/media" },
          query: {
            page: 1,
            limit: 5,
            sortBy: "createdAt",
            sortOrder: "desc",
            query: "summer",
          },
          files: [],
          pagination: null,
          limits: {
            maxFiles: 10,
            includesDeletedFields: false,
            includesStorageKeys: false,
            includesUploadMetadata: false,
            includesMutationAuthority: false,
          },
        },
        error: {
          code: "admin_media_unavailable",
        },
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(ADMIN_COOKIE);
      expect(serialized).not.toContain("admin@example.test");
      expect(serialized).not.toContain("+8801712345678");
      expect(serialized).not.toContain("raw upstream leak");
    }
  });

  it("calls admin_inventory_lookup through the API binding with fixed variant query and compact output", async () => {
    const longUserAgent = `vitest-admin-mcp-${"x".repeat(300)}`;
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        variants: [{
          id: "var_1",
          productId: "prod_1",
          productName: "Running Shoes",
          sku: "RUN-42",
          size: "42",
          color: "Black",
          stock: 20,
          reservedStock: 4,
          available: 16,
          lowStockThreshold: 5,
          price: 1200,
          version: 7,
          barcode: "BARCODE-SECRET",
          barcodeType: "code128",
          movements: [{ id: "move_secret" }],
          alerts: [{ id: "alert_secret" }],
          orderId: "order_secret",
          notes: "private operator note",
          createdBy: "admin_private",
          mutationUrl: "https://api.example.test/adjust",
          unknownSecret: "must-not-leak",
        }, {
          id: "var_2",
          productId: "prod_2",
          productName: "Plain Tee",
          sku: "TEE-DEFAULT",
          size: null,
          color: null,
          stock: 0,
          reservedStock: 0,
          available: 0,
          lowStockThreshold: 2,
        }],
        pagination: {
          page: 2,
          limit: 3,
          total: 12,
          totalPages: 4,
          cursor: "must-not-leak",
        },
        stats: {
          totalVariants: 12,
          totalOnHand: 100,
          totalReserved: 15,
          totalAvailable: 85,
          outOfStockCount: 2,
          lowStockCount: 3,
          privateCostValue: "must-not-leak",
        },
      },
      rawMessage: `raw upstream leak ${ADMIN_COOKIE}`,
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: ADMIN_COOKIE,
      userAgent: longUserAgent,
    });

    const result = await client.callTool({
      name: "admin_inventory_lookup",
      arguments: {
        query: "  running shoes  ",
        limit: 3,
        page: 2,
        status: "low",
        sort: "sku",
        order: "desc",
      },
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetchCall(apiFetch);
    const url = new URL(requestUrl(input));
    expect(`${url.origin}${url.pathname}`).toBe("http://api.internal/api/v1/admin/inventory");
    expect([...url.searchParams.entries()]).toEqual([
      ["section", "variants"],
      ["search", "running shoes"],
      ["page", "2"],
      ["limit", "3"],
      ["status", "low"],
      ["sort", "sku"],
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
    const context = adminInventoryLookupContext(result as Record<string, unknown>);
    expect(context).toEqual({
      source: { path: "/api/v1/admin/inventory" },
      query: {
        section: "variants",
        page: 2,
        limit: 3,
        status: "low",
        sort: "sku",
        order: "desc",
        query: "running shoes",
      },
      variants: [{
        id: "var_1",
        productId: "prod_1",
        productName: "Running Shoes",
        sku: "RUN-42",
        size: "42",
        color: "Black",
        stock: 20,
        reservedStock: 4,
        available: 16,
        lowStockThreshold: 5,
      }, {
        id: "var_2",
        productId: "prod_2",
        productName: "Plain Tee",
        sku: "TEE-DEFAULT",
        stock: 0,
        reservedStock: 0,
        available: 0,
        lowStockThreshold: 2,
      }],
      pagination: {
        page: 2,
        limit: 3,
        total: 12,
        totalPages: 4,
      },
      stats: {
        totalVariants: 12,
        totalOnHand: 100,
        totalReserved: 15,
        totalAvailable: 85,
        outOfStockCount: 2,
        lowStockCount: 3,
      },
      limits: {
        maxVariants: 10,
        section: "variants",
        includesMovements: false,
        includesAlerts: false,
        includesBarcode: false,
        includesPrices: false,
        includesVersion: false,
        canMutateStock: false,
      },
    });
    const variants = context.variants as Array<Record<string, unknown>>;
    expect(variants).toHaveLength(2);
    const variant = variants[0];
    if (!variant) throw new Error("Expected compact inventory variant");
    expect(Object.keys(variant).sort()).toEqual([
      "available",
      "color",
      "id",
      "lowStockThreshold",
      "productId",
      "productName",
      "reservedStock",
      "size",
      "sku",
      "stock",
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("1200");
    expect(serialized).not.toContain("BARCODE-SECRET");
    expect(serialized).not.toContain("code128");
    expect(serialized).not.toContain("move_secret");
    expect(serialized).not.toContain("alert_secret");
    expect(serialized).not.toContain("order_secret");
    expect(serialized).not.toContain("private operator note");
    expect(serialized).not.toContain("admin_private");
    expect(serialized).not.toContain("https://api.example.test/adjust");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("raw upstream leak");
    expect(serialized).not.toContain(ADMIN_COOKIE);
  });

  it("allows admin_inventory_lookup latest listing without a query while keeping defaults bounded", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        variants: [{
          id: "var_latest",
          productId: "prod_latest",
          productName: "Latest Variant",
          sku: "LATEST",
          stock: 6,
          reservedStock: 1,
          available: 5,
          lowStockThreshold: 2,
        }],
        pagination: {
          page: 1,
          limit: 5,
          total: 1,
          totalPages: 1,
        },
        stats: {
          totalVariants: 1,
          totalOnHand: 6,
          totalReserved: 1,
          totalAvailable: 5,
          outOfStockCount: 0,
          lowStockCount: 0,
        },
      },
    });
    const { client } = await bootAdmin(apiFetch);

    const result = await client.callTool({
      name: "admin_inventory_lookup",
      arguments: {},
    });

    const [input] = fetchCall(apiFetch);
    const url = new URL(requestUrl(input));
    expect([...url.searchParams.entries()]).toEqual([
      ["section", "variants"],
      ["page", "1"],
      ["limit", "5"],
      ["status", "all"],
      ["sort", "available"],
      ["order", "asc"],
    ]);
    expect(url.searchParams.has("search")).toBe(false);

    const context = adminInventoryLookupContext(result as Record<string, unknown>);
    expect(context.query).toEqual({
      section: "variants",
      page: 1,
      limit: 5,
      status: "all",
      sort: "available",
      order: "asc",
    });
    expect(context.variants).toHaveLength(1);
    expect(context.limits).toMatchObject({ maxVariants: 10, section: "variants" });
  });

  it("returns a safe admin_inventory_lookup tool error when no cookie option is present", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        variants: [],
        pagination: { page: 1, limit: 5, total: 0, totalPages: 0 },
        stats: {
          totalVariants: 0,
          totalOnHand: 0,
          totalReserved: 0,
          totalAvailable: 0,
          outOfStockCount: 0,
          lowStockCount: 0,
        },
      },
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: null,
      userAgent: "vitest-admin-mcp",
    });

    const result = await client.callTool({
      name: "admin_inventory_lookup",
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

  it("rejects unbounded admin_inventory_lookup inputs before API fetches", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        variants: [],
        pagination: { page: 1, limit: 5, total: 0, totalPages: 0 },
        stats: {
          totalVariants: 0,
          totalOnHand: 0,
          totalReserved: 0,
          totalAvailable: 0,
          outOfStockCount: 0,
          lowStockCount: 0,
        },
      },
    });
    const { client } = await bootAdmin(apiFetch);

    await expectValidationToolError(client.callTool({
      name: "admin_inventory_lookup",
      arguments: { query: "x".repeat(121), limit: 5 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_inventory_lookup",
      arguments: { limit: 11 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_inventory_lookup",
      arguments: { page: 21 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_inventory_lookup",
      arguments: { status: "damaged" },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_inventory_lookup",
      arguments: { sort: "updatedAt" },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_inventory_lookup",
      arguments: { order: "newest" },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_inventory_lookup",
      arguments: {
        query: "RUN",
        section: "movements",
        includeAlerts: true,
        includeMovements: true,
        adjust: true,
        setStock: 10,
        barcode: "BARCODE-SECRET",
        price: 1200,
        Authorization: "Bearer must-not-forward",
      },
    }));

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("keeps admin_inventory_lookup upstream failures fail-closed without leaking upstream bodies", async () => {
    const leak = `raw upstream leak ${ADMIN_COOKIE} admin@example.test +8801712345678`;
    const cases: Array<() => Response> = [
      () => json({ success: false, error: { code: "forbidden", message: leak } }, 403),
      () => json({ success: false, error: { code: "server_error", message: leak } }, 500),
      () => new Response(`not json ${leak}`, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
      () => json({ success: false, error: { code: "invalid", message: leak } }),
      () => json({
        success: true,
        data: {
          pagination: { page: 1, limit: 5, total: 0, totalPages: 0 },
          stats: {
            totalVariants: 0,
            totalOnHand: 0,
            totalReserved: 0,
            totalAvailable: 0,
            outOfStockCount: 0,
            lowStockCount: 0,
          },
          message: leak,
        },
      }),
      () => json({
        success: true,
        data: {
          variants: [],
          stats: {
            totalVariants: 0,
            totalOnHand: 0,
            totalReserved: 0,
            totalAvailable: 0,
            outOfStockCount: 0,
            lowStockCount: 0,
          },
          message: leak,
        },
      }),
      () => json({
        success: true,
        data: {
          variants: [],
          pagination: { page: 1, limit: 5, total: 0, totalPages: 0 },
          message: leak,
        },
      }),
      () => json({
        success: true,
        data: {
          variants: [],
          pagination: { page: 1, limit: 5, total: 0, totalPages: 0 },
          stats: {},
          message: leak,
        },
      }),
      () => json({
        success: true,
        data: {
          variants: [],
          pagination: { page: 1, limit: 5, total: 0, totalPages: 0 },
          stats: { totalVariants: "0" },
          message: leak,
        },
      }),
    ];

    for (const makeResponse of cases) {
      const apiFetch = vi.fn<FetchLike>().mockImplementation(() => Promise.resolve(makeResponse()));
      const { client } = await bootAdmin(apiFetch);

      const result = await client.callTool({
        name: "admin_inventory_lookup",
        arguments: { query: "RUN" },
      });

      expect(apiFetch).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        adminInventoryLookup: {
          source: { path: "/api/v1/admin/inventory" },
          query: {
            section: "variants",
            page: 1,
            limit: 5,
            status: "all",
            sort: "available",
            order: "asc",
            query: "RUN",
          },
          variants: [],
          pagination: null,
          stats: null,
          limits: {
            maxVariants: 10,
            section: "variants",
            includesMovements: false,
            includesAlerts: false,
            includesBarcode: false,
            includesPrices: false,
            includesVersion: false,
            canMutateStock: false,
          },
        },
        error: {
          code: "admin_inventory_unavailable",
          message: "Admin inventory is temporarily unavailable.",
        },
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(ADMIN_COOKIE);
      expect(serialized).not.toContain("admin@example.test");
      expect(serialized).not.toContain("+8801712345678");
      expect(serialized).not.toContain("raw upstream leak");
    }
  });

  it("slices admin_inventory_lookup variants to the documented maximum", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        variants: Array.from({ length: 12 }, (_, index) => ({
          id: `var_${index}`,
          productId: `prod_${index}`,
          productName: `Product ${index}`,
          sku: `SKU-${index}`,
          stock: index,
          reservedStock: 0,
          available: index,
          lowStockThreshold: 2,
        })),
        pagination: {
          page: 1,
          limit: 10,
          total: 12,
          totalPages: 2,
        },
        stats: {
          totalVariants: 12,
          totalOnHand: 66,
          totalReserved: 0,
          totalAvailable: 66,
          outOfStockCount: 1,
          lowStockCount: 2,
        },
      },
    });
    const { client } = await bootAdmin(apiFetch);

    const result = await client.callTool({
      name: "admin_inventory_lookup",
      arguments: { limit: 10 },
    });

    const context = adminInventoryLookupContext(result as Record<string, unknown>);
    expect(context.variants).toHaveLength(10);
    expect(context.limits).toMatchObject({ maxVariants: 10 });
  });
});
