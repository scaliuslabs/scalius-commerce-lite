import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "./storefront-runtime";
import {
  ADMIN_COOKIE,
  adminCategorySearchContext,
  adminCollectionSearchContext,
  adminPageSearchContext,
  bootAdmin,
  expectValidationToolError,
  fetchCall,
  json,
  mockJsonFetch,
  requestUrl,
} from "./runtime-test-support";

describe("admin MCP server — catalog content", () => {
  it("calls admin_category_search through the API binding with fixed search query and compact output", async () => {
    const longUserAgent = `vitest-admin-mcp-${"x".repeat(300)}`;
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        categories: [{
          id: "cat_1",
          name: "Summer Shoes",
          slug: "summer-shoes",
          isActive: true,
          status: "active",
          description: "raw category description",
          imageUrl: "https://cdn.example.test/private-category.jpg",
          imageCount: 2,
          metaTitle: "must-not-leak",
          metaDescription: "must-not-leak",
          canonicalPath: "/categories/summer-shoes",
          noIndex: true,
          excludeFromSitemap: false,
          productCount: 7,
          createdAt: "2026-07-07T08:00:00.000Z",
          updatedAt: "2026-07-07T10:30:00.000Z",
          deletedAt: "2026-07-08T00:00:00.000Z",
          privateNote: "must-not-leak",
          customerEmail: "customer@example.test",
          orderCount: 12,
          paymentStatus: "paid",
        }, {
          id: "cat_absolute",
          name: "Absolute Canonical",
          slug: "absolute-canonical",
          canonicalPath: "https://evil.example.test/categories/absolute-canonical",
          imageUrl: null,
          noIndex: false,
          excludeFromSitemap: true,
          productCount: 0,
          updatedAt: "2026-07-08T10:30:00.000Z",
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
      name: "admin_category_search",
      arguments: { query: "  summer shoes  ", limit: 3, page: 2 },
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetchCall(apiFetch);
    const url = new URL(requestUrl(input));
    expect(`${url.origin}${url.pathname}`).toBe("http://api.internal/api/v1/admin/categories");
    expect([...url.searchParams.entries()]).toEqual([
      ["search", "summer shoes"],
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
    const context = adminCategorySearchContext(result as Record<string, unknown>);
    expect(context).toEqual({
      source: { path: "/api/v1/admin/categories" },
      query: {
        query: "summer shoes",
        page: 2,
        limit: 3,
        sort: "updatedAt",
        order: "desc",
      },
      categories: [{
        id: "cat_1",
        name: "Summer Shoes",
        slug: "summer-shoes",
        productCount: 7,
        noIndex: true,
        excludeFromSitemap: false,
        canonicalPath: "/categories/summer-shoes",
        updatedAt: "2026-07-07T10:30:00.000Z",
      }, {
        id: "cat_absolute",
        name: "Absolute Canonical",
        slug: "absolute-canonical",
        productCount: 0,
        noIndex: false,
        excludeFromSitemap: true,
        updatedAt: "2026-07-08T10:30:00.000Z",
      }],
      pagination: {
        page: 2,
        limit: 3,
        total: 9,
        totalPages: 3,
      },
      limits: {
        maxCategories: 10,
        includesTrashed: false,
        includesDescriptions: false,
        includesMetaText: false,
        includesRawImages: false,
      },
    });
    const categories = context.categories as Array<Record<string, unknown>>;
    expect(categories).toHaveLength(2);
    const category = categories[0];
    if (!category) throw new Error("Expected compact admin category");
    expect(Object.keys(category).sort()).toEqual([
      "canonicalPath",
      "excludeFromSitemap",
      "id",
      "name",
      "noIndex",
      "productCount",
      "slug",
      "updatedAt",
    ]);
    expect(categories[1]).not.toHaveProperty("canonicalPath");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("raw category description");
    expect(serialized).not.toContain("https://cdn.example.test/private-category.jpg");
    expect(serialized).not.toContain("https://evil.example.test");
    expect(serialized).not.toContain("metaTitle");
    expect(serialized).not.toContain("metaDescription");
    expect(serialized).not.toContain("deletedAt");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("customer@example.test");
    expect(serialized).not.toContain(ADMIN_COOKIE);
  });

  it("keeps admin_category_search upstream failures fail-closed without leaking upstream bodies", async () => {
    const leak = `raw upstream leak ${ADMIN_COOKIE} admin@example.test +8801712345678`;
    const cases: Array<() => Response> = [
      () => json({ success: false, error: { code: "forbidden", message: leak } }, 403),
      () => json({ success: false, error: { code: "server_error", message: leak } }, 500),
      () => new Response(`not json ${leak}`, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
      () => json({ success: false, error: { code: "invalid", message: leak } }),
      () => json({ success: true, data: { categories: [], message: leak } }),
    ];

    for (const makeResponse of cases) {
      const apiFetch = vi.fn<FetchLike>().mockImplementation(() => Promise.resolve(makeResponse()));
      const { client } = await bootAdmin(apiFetch);

      const result = await client.callTool({
        name: "admin_category_search",
        arguments: { query: "summer" },
      });

      expect(apiFetch).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        adminCategorySearch: {
          source: { path: "/api/v1/admin/categories" },
          query: {
            query: "summer",
            page: 1,
            limit: 5,
            sort: "updatedAt",
            order: "desc",
          },
          categories: [],
          pagination: null,
          limits: {
            maxCategories: 10,
            includesTrashed: false,
            includesDescriptions: false,
            includesMetaText: false,
            includesRawImages: false,
          },
        },
        error: {
          code: "admin_category_unavailable",
        },
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(ADMIN_COOKIE);
      expect(serialized).not.toContain("admin@example.test");
      expect(serialized).not.toContain("+8801712345678");
      expect(serialized).not.toContain("raw upstream leak");
    }
  });

  it("returns a safe admin_category_search tool error when no cookie option is present", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { categories: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } },
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: null,
      userAgent: "vitest-admin-mcp",
    });

    const result = await client.callTool({
      name: "admin_category_search",
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

  it("rejects unbounded admin_category_search inputs before API fetches", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { categories: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } },
    });
    const { client } = await bootAdmin(apiFetch);

    await expectValidationToolError(client.callTool({
      name: "admin_category_search",
      arguments: { query: "", limit: 5 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_category_search",
      arguments: { query: "x".repeat(121), limit: 5 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_category_search",
      arguments: { query: "summer", limit: 11 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_category_search",
      arguments: { query: "summer", page: 21 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_category_search",
      arguments: {
        query: "summer",
        search: "old-field",
        includeTrashed: true,
        includeDescriptions: true,
        imageUrl: "https://cdn.example.test/private.jpg",
        deletedAt: "2026-07-08T00:00:00.000Z",
        Authorization: "Bearer must-not-forward",
      },
    }));

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("calls admin_collection_search through the API binding with fixed search query and compact output", async () => {
    const longUserAgent = `vitest-admin-mcp-${"x".repeat(300)}`;
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        collections: [{
          id: "col_1",
          name: "Summer Picks",
          slug: "must-not-leak-slug",
          type: "manual",
          config: "{\"productIds\":[\"prod_secret\"]}",
          sortOrder: 4,
          isActive: true,
          description: "raw collection description",
          imageUrl: "https://cdn.example.test/private-collection.jpg",
          products: [{ id: "prod_secret", name: "Hidden Product" }],
          productCount: 7,
          metaTitle: "must-not-leak",
          metaDescription: "must-not-leak",
          canonicalPath: "/collections/col_1",
          noIndex: true,
          excludeFromSitemap: false,
          createdAt: "2026-07-07T08:00:00.000Z",
          updatedAt: "2026-07-07T10:30:00.000Z",
          deletedAt: "2026-07-08T00:00:00.000Z",
          privateNote: "must-not-leak",
          customerEmail: "customer@example.test",
          orderCount: 12,
          paymentStatus: "paid",
        }, {
          id: "col_absolute",
          name: "Absolute Canonical",
          slug: "absolute-canonical",
          canonicalPath: "/collections/col_other",
          imageUrl: null,
          noIndex: false,
          excludeFromSitemap: true,
          productCount: 0,
          updatedAt: "2026-07-08T10:30:00.000Z",
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
      name: "admin_collection_search",
      arguments: { query: "  summer picks  ", limit: 3, page: 2 },
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetchCall(apiFetch);
    const url = new URL(requestUrl(input));
    expect(`${url.origin}${url.pathname}`).toBe("http://api.internal/api/v1/admin/collections");
    expect([...url.searchParams.entries()]).toEqual([
      ["search", "summer picks"],
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
    const context = adminCollectionSearchContext(result as Record<string, unknown>);
    expect(context).toEqual({
      source: { path: "/api/v1/admin/collections" },
      query: {
        query: "summer picks",
        page: 2,
        limit: 3,
        sort: "updatedAt",
        order: "desc",
      },
      collections: [{
        id: "col_1",
        name: "Summer Picks",
        productCount: 7,
        noIndex: true,
        excludeFromSitemap: false,
        canonicalPath: "/collections/col_1",
        updatedAt: "2026-07-07T10:30:00.000Z",
      }, {
        id: "col_absolute",
        name: "Absolute Canonical",
        productCount: 0,
        noIndex: false,
        excludeFromSitemap: true,
        updatedAt: "2026-07-08T10:30:00.000Z",
      }],
      pagination: {
        page: 2,
        limit: 3,
        total: 9,
        totalPages: 3,
      },
      limits: {
        maxCollections: 10,
        includesTrashed: false,
        includesProducts: false,
        includesDescriptions: false,
        includesMetaText: false,
        includesRawImages: false,
        includesDeletedFields: false,
      },
    });
    const collections = context.collections as Array<Record<string, unknown>>;
    expect(collections).toHaveLength(2);
    const collection = collections[0];
    if (!collection) throw new Error("Expected compact admin collection");
    expect(Object.keys(collection).sort()).toEqual([
      "canonicalPath",
      "excludeFromSitemap",
      "id",
      "name",
      "noIndex",
      "productCount",
      "updatedAt",
    ]);
    expect(collections[1]).not.toHaveProperty("canonicalPath");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("raw collection description");
    expect(serialized).not.toContain("https://cdn.example.test/private-collection.jpg");
    expect(serialized).not.toContain("/collections/col_other");
    expect(serialized).not.toContain("must-not-leak-slug");
    expect(serialized).not.toContain("absolute-canonical");
    expect(serialized).not.toContain("prod_secret");
    expect(serialized).not.toContain("Hidden Product");
    expect(serialized).not.toContain("config");
    expect(serialized).not.toContain("metaTitle");
    expect(serialized).not.toContain("metaDescription");
    expect(serialized).not.toContain("deletedAt");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("customer@example.test");
    expect(serialized).not.toContain(ADMIN_COOKIE);
  });

  it("keeps admin_collection_search upstream failures fail-closed without leaking upstream bodies", async () => {
    const leak = `raw upstream leak ${ADMIN_COOKIE} admin@example.test +8801712345678`;
    const cases: Array<() => Response> = [
      () => json({ success: false, error: { code: "forbidden", message: leak } }, 403),
      () => json({ success: false, error: { code: "server_error", message: leak } }, 500),
      () => new Response(`not json ${leak}`, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
      () => json({ success: false, error: { code: "invalid", message: leak } }),
      () => json({ success: true, data: { collections: [], message: leak } }),
    ];

    for (const makeResponse of cases) {
      const apiFetch = vi.fn<FetchLike>().mockImplementation(() => Promise.resolve(makeResponse()));
      const { client } = await bootAdmin(apiFetch);

      const result = await client.callTool({
        name: "admin_collection_search",
        arguments: { query: "summer" },
      });

      expect(apiFetch).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        adminCollectionSearch: {
          source: { path: "/api/v1/admin/collections" },
          query: {
            query: "summer",
            page: 1,
            limit: 5,
            sort: "updatedAt",
            order: "desc",
          },
          collections: [],
          pagination: null,
          limits: {
            maxCollections: 10,
            includesTrashed: false,
            includesProducts: false,
            includesDescriptions: false,
            includesMetaText: false,
            includesRawImages: false,
            includesDeletedFields: false,
          },
        },
        error: {
          code: "admin_collection_unavailable",
        },
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(ADMIN_COOKIE);
      expect(serialized).not.toContain("admin@example.test");
      expect(serialized).not.toContain("+8801712345678");
      expect(serialized).not.toContain("raw upstream leak");
    }
  });

  it("returns a safe admin_collection_search tool error when no cookie option is present", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { collections: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } },
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: null,
      userAgent: "vitest-admin-mcp",
    });

    const result = await client.callTool({
      name: "admin_collection_search",
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

  it("rejects unbounded admin_collection_search inputs before API fetches", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { collections: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } },
    });
    const { client } = await bootAdmin(apiFetch);

    await expectValidationToolError(client.callTool({
      name: "admin_collection_search",
      arguments: { query: "", limit: 5 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_collection_search",
      arguments: { query: "x".repeat(121), limit: 5 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_collection_search",
      arguments: { query: "summer", limit: 11 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_collection_search",
      arguments: { query: "summer", page: 21 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_collection_search",
      arguments: {
        query: "summer",
        search: "old-field",
        trashed: true,
        includeProducts: true,
        includeDescriptions: true,
        includeDeleted: true,
        metaDescription: "must-not-forward",
        imageUrl: "https://cdn.example.test/private.jpg",
        Authorization: "Bearer must-not-forward",
      },
    }));

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("calls admin_page_search through the API binding with fixed search query and compact output", async () => {
    const longUserAgent = `vitest-admin-mcp-${"x".repeat(300)}`;
    const apiFetch = mockJsonFetch({
      success: true,
      data: {
        pages: [{
          id: "page_1",
          title: "About Us",
          slug: "about-us",
          isPublished: true,
          noIndex: true,
          excludeFromSitemap: false,
          canonicalPath: "/about-us",
          hideHeader: false,
          hideFooter: true,
          hideTitle: false,
          publishedAt: "2026-07-07T08:00:00.000Z",
          updatedAt: "2026-07-07T10:30:00.000Z",
          content: "<p>raw page content</p>",
          metaTitle: "must-not-leak",
          metaDescription: "must-not-leak",
          featuredImage: "https://cdn.example.test/private-page.jpg",
          deletedAt: "2026-07-08T00:00:00.000Z",
          deletedBy: "admin_secret",
          privateNote: "must-not-leak",
          customerEmail: "customer@example.test",
          mutationAuthority: "must-not-leak",
        }, {
          id: "page_override_canonical",
          title: "Contact",
          slug: "contact",
          isPublished: false,
          noIndex: false,
          excludeFromSitemap: true,
          canonicalPath: "/contact-us",
          hideHeader: "not-boolean",
          hideFooter: null,
          hideTitle: true,
          publishedAt: null,
          updatedAt: "2026-07-08T10:30:00.000Z",
        }, {
          id: "page_blank_canonical",
          title: "Careers",
          slug: "careers",
          isPublished: true,
          canonicalPath: "",
          updatedAt: 1783516200,
        }, {
          id: "page_reserved_canonical",
          title: "Search",
          slug: "search",
          isPublished: true,
          canonicalPath: "/search",
          updatedAt: "2026-07-08T11:30:00.000Z",
        }],
        pagination: {
          page: 2,
          limit: 4,
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
      name: "admin_page_search",
      arguments: { query: "  about us  ", limit: 4, page: 2 },
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetchCall(apiFetch);
    const url = new URL(requestUrl(input));
    expect(`${url.origin}${url.pathname}`).toBe("http://api.internal/api/v1/admin/pages");
    expect([...url.searchParams.entries()]).toEqual([
      ["search", "about us"],
      ["page", "2"],
      ["limit", "4"],
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
    const context = adminPageSearchContext(result as Record<string, unknown>);
    expect(context).toEqual({
      source: { path: "/api/v1/admin/pages" },
      query: {
        query: "about us",
        page: 2,
        limit: 4,
        sort: "updatedAt",
        order: "desc",
      },
      pages: [{
        id: "page_1",
        title: "About Us",
        slug: "about-us",
        isPublished: true,
        noIndex: true,
        excludeFromSitemap: false,
        canonicalPath: "/about-us",
        hideHeader: false,
        hideFooter: true,
        hideTitle: false,
        publishedAt: "2026-07-07T08:00:00.000Z",
        updatedAt: "2026-07-07T10:30:00.000Z",
      }, {
        id: "page_override_canonical",
        title: "Contact",
        slug: "contact",
        isPublished: false,
        noIndex: false,
        excludeFromSitemap: true,
        canonicalPath: "/contact-us",
        hideTitle: true,
        updatedAt: "2026-07-08T10:30:00.000Z",
      }, {
        id: "page_blank_canonical",
        title: "Careers",
        slug: "careers",
        isPublished: true,
        updatedAt: 1783516200,
      }, {
        id: "page_reserved_canonical",
        title: "Search",
        slug: "search",
        isPublished: true,
        updatedAt: "2026-07-08T11:30:00.000Z",
      }],
      pagination: {
        page: 2,
        limit: 4,
        total: 9,
        totalPages: 3,
      },
      limits: {
        maxPages: 10,
        includesTrashed: false,
        includesContent: false,
        includesMetaText: false,
        includesRawImages: false,
        includesDeletedFields: false,
      },
    });
    const pages = context.pages as Array<Record<string, unknown>>;
    expect(pages).toHaveLength(4);
    const page = pages[0];
    if (!page) throw new Error("Expected compact admin page");
    expect(Object.keys(page).sort()).toEqual([
      "canonicalPath",
      "excludeFromSitemap",
      "hideFooter",
      "hideHeader",
      "hideTitle",
      "id",
      "isPublished",
      "noIndex",
      "publishedAt",
      "slug",
      "title",
      "updatedAt",
    ]);
    expect(pages[1]).toHaveProperty("canonicalPath", "/contact-us");
    expect(pages[1]).not.toHaveProperty("hideHeader");
    expect(pages[1]).not.toHaveProperty("hideFooter");
    expect(pages[2]).not.toHaveProperty("canonicalPath");
    expect(pages[3]).not.toHaveProperty("canonicalPath");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("raw page content");
    expect(serialized).not.toContain("https://cdn.example.test/private-page.jpg");
    expect(serialized).not.toContain('canonicalPath":"/search');
    expect(serialized).not.toContain("metaTitle");
    expect(serialized).not.toContain("metaDescription");
    expect(serialized).not.toContain("featuredImage");
    expect(serialized).not.toContain("deletedAt");
    expect(serialized).not.toContain("deletedBy");
    expect(serialized).not.toContain("mutationAuthority");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("customer@example.test");
    expect(serialized).not.toContain(ADMIN_COOKIE);
  });

  it("keeps admin_page_search upstream failures fail-closed without leaking upstream bodies", async () => {
    const leak = `raw upstream leak ${ADMIN_COOKIE} admin@example.test +8801712345678`;
    const cases: Array<() => Response> = [
      () => json({ success: false, error: { code: "forbidden", message: leak } }, 403),
      () => json({ success: false, error: { code: "server_error", message: leak } }, 500),
      () => new Response(`not json ${leak}`, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
      () => json({ success: false, error: { code: "invalid", message: leak } }),
      () => json({ success: true, data: { pages: [], message: leak } }),
    ];

    for (const makeResponse of cases) {
      const apiFetch = vi.fn<FetchLike>().mockImplementation(() => Promise.resolve(makeResponse()));
      const { client } = await bootAdmin(apiFetch);

      const result = await client.callTool({
        name: "admin_page_search",
        arguments: { query: "about" },
      });

      expect(apiFetch).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        adminPageSearch: {
          source: { path: "/api/v1/admin/pages" },
          query: {
            query: "about",
            page: 1,
            limit: 5,
            sort: "updatedAt",
            order: "desc",
          },
          pages: [],
          pagination: null,
          limits: {
            maxPages: 10,
            includesTrashed: false,
            includesContent: false,
            includesMetaText: false,
            includesRawImages: false,
            includesDeletedFields: false,
          },
        },
        error: {
          code: "admin_page_unavailable",
        },
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(ADMIN_COOKIE);
      expect(serialized).not.toContain("admin@example.test");
      expect(serialized).not.toContain("+8801712345678");
      expect(serialized).not.toContain("raw upstream leak");
    }
  });

  it("returns a safe admin_page_search tool error when no cookie option is present", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { pages: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } },
    });
    const { client } = await bootAdmin(apiFetch, {
      cookie: null,
      userAgent: "vitest-admin-mcp",
    });

    const result = await client.callTool({
      name: "admin_page_search",
      arguments: { query: "about" },
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

  it("rejects unbounded admin_page_search inputs before API fetches", async () => {
    const apiFetch = mockJsonFetch({
      success: true,
      data: { pages: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } },
    });
    const { client } = await bootAdmin(apiFetch);

    await expectValidationToolError(client.callTool({
      name: "admin_page_search",
      arguments: { query: "", limit: 5 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_page_search",
      arguments: { query: "   ", limit: 5 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_page_search",
      arguments: { query: "x".repeat(121), limit: 5 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_page_search",
      arguments: { query: "about", limit: 11 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_page_search",
      arguments: { query: "about", page: 21 },
    }));
    await expectValidationToolError(client.callTool({
      name: "admin_page_search",
      arguments: {
        query: "about",
        search: "old-field",
        trashed: true,
        includeContent: true,
        includeMeta: true,
        includeDeleted: true,
        content: "<p>must-not-forward</p>",
        featuredImage: "https://cdn.example.test/private.jpg",
        Authorization: "Bearer must-not-forward",
      },
    }));

    expect(apiFetch).not.toHaveBeenCalled();
  });
});
