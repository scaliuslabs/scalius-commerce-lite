import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveAdmin: vi.fn(),
  resolveStorefront: vi.fn(),
  dashboard: vi.fn(),
  productStats: vi.fn(),
  adminProducts: vi.fn(),
  adminProduct: vi.fn(),
  catalogSearch: vi.fn(),
  catalogList: vi.fn(),
  catalogProduct: vi.fn(),
  currency: vi.fn(),
}));

vi.mock("./flue-command-authority", () => ({
  resolveAdminFlueCommandAuthority: mocks.resolveAdmin,
  resolveStorefrontFlueCommandAuthority: mocks.resolveStorefront,
}));
vi.mock("@scalius/core/modules/analytics/dashboard.service", () => ({
  getDashboardSummaryStats: mocks.dashboard,
}));
vi.mock("@scalius/core/modules/products/products.admin", () => ({
  getProductStats: mocks.productStats,
  listProducts: mocks.adminProducts,
  getProductDetails: mocks.adminProduct,
}));
vi.mock("@scalius/core/modules/products/products.storefront", () => ({
  searchStorefrontProducts: mocks.catalogSearch,
  getStorefrontProducts: mocks.catalogList,
  getStorefrontProductBySlug: mocks.catalogProduct,
}));
vi.mock("@scalius/core/modules/settings/site-settings.service", () => ({
  getCurrencySettings: mocks.currency,
}));

import {
  SCALIUS_COMMAND_MAX_RESPONSE_BYTES,
  runScaliusCommand,
} from "@scalius/shared/assistant-command-client";
import {
  FLUE_COMMAND_PROJECTION_LIMITS,
  executeAdminFlueCommand,
  executeStorefrontFlueCommand,
} from "./flue-command-execution";

const INSTANCE_ID = `v1.${"i".repeat(43)}`;
const context = { get: () => ({ database: true }), env: {} } as never;

describe("Flue Scalius command execution", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveAdmin.mockResolvedValue({
      session: { id: "as_1" },
      permissions: new Set(["dashboard.view", "products.view"]),
    });
    mocks.resolveStorefront.mockResolvedValue({ id: "as_2" });
    mocks.currency.mockResolvedValue({
      currencyCode: "BDT",
      currencySymbol: "৳",
      usdExchangeRate: "1",
    });
    mocks.dashboard.mockResolvedValue({
      totalProducts: 29,
      totalCustomers: 7,
      currentMonth: {
        orders: 3,
        revenue: 1200,
        orderGrowth: 0,
        revenueGrowth: 0,
        orderStatus: { delivered: 1, processing: 1, shipping: 1, cancelled: 0 },
      },
      lastMonth: { orders: 2, revenue: 900 },
    });
    mocks.productStats.mockResolvedValue({
      totalProducts: 29,
      activeProducts: 24,
      productsWithImages: 20,
      categoriesCount: 4,
    });
  });

  it("discovers only capabilities allowed by current Admin permissions", async () => {
    mocks.resolveAdmin.mockResolvedValue({
      session: { id: "as_1" },
      permissions: new Set(["products.view"]),
    });
    const help = await executeAdminFlueCommand(context, {
      instanceId: INSTANCE_ID,
      program: "help product counts",
    });
    expect(help).toMatchObject({
      success: true,
      data: {
        command: "help",
        capabilities: expect.arrayContaining([
          expect.objectContaining({ id: "admin.api.get.products.stats" }),
        ]),
      },
    });
    expect(JSON.stringify(help)).not.toContain("dashboard.metrics-summary");
    expect(mocks.resolveAdmin).toHaveBeenCalledWith(context, INSTANCE_ID);
  });

  it("returns authoritative product counts instead of visible-row guesses", async () => {
    const response = await executeAdminFlueCommand(context, {
      instanceId: INSTANCE_ID,
      program: "call admin.api.get.products.stats -- {}",
    });
    expect(response).toEqual({
      success: true,
      data: {
        command: "call",
        capability: {
          id: "admin.api.get.products.stats",
          title: "Product counts",
        },
        result: {
          stats: {
            totalProducts: 29,
            activeProducts: 24,
            productsWithImages: 20,
            categoriesCount: 4,
          },
        },
      },
    });
    expect(mocks.productStats).toHaveBeenCalledOnce();
  });

  it("bounds and compacts Admin product search with truthful pagination", async () => {
    mocks.adminProducts.mockResolvedValue({
      products: [{
        id: "prod_1",
        name: "Trail shoes",
        slug: "trail-shoes",
        price: 1200,
        isActive: true,
        category: { name: "Shoes" },
        variantCount: 2,
        imageCount: 1,
        primaryImage: "https://cdn.test/trail.jpg",
        updatedAt: new Date("2026-07-10T00:00:00.000Z"),
      }],
      pagination: { total: 29, page: 1, limit: 4, totalPages: 8 },
    });
    const response = await executeAdminFlueCommand(context, {
      instanceId: INSTANCE_ID,
      program: 'call admin.api.get.products -- {"search":"shoes","limit":4}',
    });
    expect(response).toMatchObject({
      success: true,
      data: {
        result: {
          products: [{
            id: "prod_1",
            name: "Trail shoes",
            route: "/admin/products/prod_1",
          }],
          pagination: { total: 29, totalPages: 8 },
        },
      },
    });
    expect(mocks.adminProducts).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ search: "shoes", page: 1, limit: 4, showTrashed: false }),
    );
  });

  it("grounds Storefront product questions in buyer-visible catalog search", async () => {
    mocks.catalogSearch.mockResolvedValue({
      data: [{
        id: "prod_shoe",
        name: "Everyday shoes",
        slug: "everyday-shoes",
        price: 1000,
        discountType: "percentage",
        discountPercentage: 10,
        discountAmount: null,
        imageUrl: "https://cdn.test/shoe.jpg",
        variants: [{ trackInventory: true, stock: 2, reservedStock: 1 }],
      }],
      pagination: {
        page: 1,
        limit: 5,
        total: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPrevPage: false,
      },
    });
    const response = await executeStorefrontFlueCommand(context, {
      instanceId: INSTANCE_ID,
      program: 'call catalog.search -- {"query":"shoes"}',
    });
    expect(response).toMatchObject({
      success: true,
      data: {
        result: {
          currency: { code: "BDT" },
          products: [{
            name: "Everyday shoes",
            route: "/products/everyday-shoes",
            price: 1000,
            currentPrice: 900,
            availableForSale: true,
          }],
          pagination: { total: 1 },
        },
      },
    });
    expect(mocks.resolveStorefront).toHaveBeenCalledWith(context, INSTANCE_ID);
  });

  it("returns available product options with merchant labels and no private stock quantities", async () => {
    mocks.catalogProduct.mockResolvedValue({
      product: {
        id: "prod_1",
        name: "Trail shoes",
        slug: "trail-shoes",
        price: 1200,
        discountedPrice: 1100,
        freeDelivery: false,
        variantOption1Label: "Size",
        variantOption2Label: "Color",
      },
      category: { name: "Shoes" },
      images: [{ url: "https://cdn.test/trail.jpg", alt: "Trail shoes" }],
      variants: [{
        id: "var_1",
        size: "42",
        color: "Black",
        price: 1200,
        trackInventory: true,
        stock: 2,
        reservedStock: 1,
        discountType: null,
        discountPercentage: null,
        discountAmount: null,
      }],
    });
    const response = await executeStorefrontFlueCommand(context, {
      instanceId: INSTANCE_ID,
      program: 'call catalog.product -- {"slug":"trail-shoes"}',
    });
    expect(response).toMatchObject({
      success: true,
      data: {
        result: {
          product: {
            options: [{
              id: "var_1",
              values: [{ name: "Size", value: "42" }, { name: "Color", value: "Black" }],
              availableForSale: true,
            }],
          },
        },
      },
    });
    expect(JSON.stringify(response)).not.toMatch(/reservedStock|"stock"/u);
  });

  it("applies a valid variant discount first and otherwise falls back to the product discount", async () => {
    mocks.catalogProduct.mockResolvedValue({
      product: {
        id: "prod_1",
        name: "Discount truth",
        slug: "discount-truth",
        price: 100,
        discountedPrice: 90,
        discountType: "percentage",
        discountPercentage: 10,
        discountAmount: null,
        variantOption1Label: "Option",
        variantOption2Label: null,
      },
      category: null,
      images: [],
      variants: [
        {
          id: "var_product_fallback",
          size: "Fallback",
          price: 200,
          discountType: null,
          discountPercentage: null,
          discountAmount: null,
          trackInventory: false,
        },
        {
          id: "var_invalid_fallback",
          size: "Invalid",
          price: 200,
          discountType: "flat",
          discountPercentage: null,
          discountAmount: 0,
          trackInventory: false,
        },
        {
          id: "var_override",
          size: "Override",
          price: 200,
          discountType: "flat",
          discountPercentage: null,
          discountAmount: 30,
          trackInventory: false,
        },
      ],
    });

    const response = await executeStorefrontFlueCommand(context, {
      instanceId: INSTANCE_ID,
      program: 'call catalog.product -- {"slug":"discount-truth"}',
    });
    expect(response).toMatchObject({
      success: true,
      data: {
        result: {
          product: {
            options: [
              { id: "var_product_fallback", price: 200, currentPrice: 180 },
              { id: "var_invalid_fallback", price: 200, currentPrice: 180 },
              { id: "var_override", price: 200, currentPrice: 170 },
            ],
          },
        },
      },
    });
  });

  it("keeps mutation preparation and arbitrary capabilities fail closed", async () => {
    const prepared = await executeAdminFlueCommand(context, {
      instanceId: INSTANCE_ID,
      program: 'prepare admin.api.post.products -- {"name":"Unsafe"}',
    });
    expect(prepared).toEqual({
      success: false,
      error: {
        code: "mutation_not_ready",
        message: "This mutation has no verified preview and confirmation adapter yet. Use the visible Admin controls.",
        retryable: false,
      },
    });
    const missing = await executeStorefrontFlueCommand(context, {
      instanceId: INSTANCE_ID,
      program: "show catalog.checkout",
    });
    expect(missing).toMatchObject({
      success: false,
      error: { code: "capability_not_found", retryable: false },
    });

    const storefrontHelp = await executeStorefrontFlueCommand(context, {
      instanceId: INSTANCE_ID,
      program: "help",
    });
    const storefrontPrepared = await executeStorefrontFlueCommand(context, {
      instanceId: INSTANCE_ID,
      program: 'prepare catalog.cart.add -- {"quantity":1}',
    });
    expect(JSON.stringify(storefrontHelp)).not.toMatch(/merchant|Admin/u);
    expect(storefrontPrepared).toMatchObject({
      success: false,
      error: {
        code: "mutation_not_ready",
        message: expect.stringMatching(/storefront controls/u),
      },
    });
    expect(JSON.stringify(storefrontPrepared)).not.toMatch(/merchant|Admin/u);
  });

  it("emits results accepted by the exact Worker client contract", async () => {
    const body = await executeAdminFlueCommand(context, {
      instanceId: INSTANCE_ID,
      program: "call admin.api.get.products.stats -- {}",
    });
    if (!body.success) throw new Error("Expected command success");
    const result = await runScaliusCommand({
      surface: "admin",
      instanceId: INSTANCE_ID,
      program: "call admin.api.get.products.stats -- {}",
      api: {
        fetch: vi.fn(async () => Response.json(body)),
      },
      timeoutMs: 100,
    });
    expect(result).toMatchObject({ ok: true, authoritative: true, data: body.data });
  });

  it("keeps every maximum command projection inside the exact Worker response envelope", async () => {
    const maxName = "N".repeat(180);
    const maxCategory = "C".repeat(120);
    const maxOption = "O".repeat(100);
    const maxUrl = `https://cdn.test/${"u".repeat(470)}.jpg`;
    expect(maxUrl.length).toBeLessThanOrEqual(FLUE_COMMAND_PROJECTION_LIMITS.urlChars);

    mocks.adminProducts.mockResolvedValue({
      products: Array.from({ length: FLUE_COMMAND_PROJECTION_LIMITS.productResults }, (_, index) => ({
        id: `prod_${index}`,
        name: maxName,
        slug: `product-${index}`,
        price: 999_999.99,
        isActive: true,
        category: { name: maxCategory },
        variantCount: 999,
        imageCount: 999,
        primaryImage: maxUrl,
        updatedAt: new Date("2026-07-10T00:00:00.000Z"),
      })),
      pagination: { total: 999, page: 1, limit: 4, totalPages: 250 },
    });
    mocks.adminProduct.mockResolvedValue({
      id: "prod_1",
      name: maxName,
      slug: "max-product",
      price: 999_999.99,
      isActive: true,
      category: { name: maxCategory },
      variants: Array.from({ length: 200 }, () => ({})),
      images: Array.from({ length: 200 }, () => ({})),
    });
    const catalogCards = Array.from(
      { length: FLUE_COMMAND_PROJECTION_LIMITS.productResults },
      (_, index) => ({
        id: `catalog_${index}`,
        name: maxName,
        slug: `catalog-${index}`,
        price: 999_999.99,
        discountedPrice: 888_888.88,
        discountType: "percentage",
        discountPercentage: 10,
        discountAmount: null,
        imageUrl: maxUrl,
        availableForSale: true,
        variants: [{ trackInventory: false }],
      }),
    );
    mocks.catalogSearch.mockResolvedValue({
      data: catalogCards,
      pagination: {
        page: 1,
        limit: 4,
        total: 999,
        totalPages: 250,
        hasNextPage: true,
        hasPrevPage: false,
      },
    });
    mocks.catalogList.mockResolvedValue({
      products: catalogCards,
      pagination: {
        page: 1,
        limit: 4,
        total: 999,
        totalPages: 250,
        hasNextPage: true,
        hasPrevPage: false,
      },
    });
    mocks.catalogProduct.mockResolvedValue({
      product: {
        id: "prod_max",
        name: maxName,
        slug: "max-product",
        price: 999_999.99,
        discountedPrice: 888_888.88,
        discountType: "percentage",
        discountPercentage: 10,
        discountAmount: null,
        freeDelivery: true,
        variantOption1Label: "First option",
        variantOption2Label: "Second option",
      },
      category: { name: maxCategory },
      images: Array.from(
        { length: FLUE_COMMAND_PROJECTION_LIMITS.productImages + 2 },
        () => ({ url: maxUrl, alt: maxName }),
      ),
      variants: Array.from(
        { length: FLUE_COMMAND_PROJECTION_LIMITS.productOptions + 8 },
        (_, index) => ({
          id: `variant_${index}`,
          size: maxOption,
          color: maxOption,
          price: 999_999.99,
          discountType: null,
          discountPercentage: null,
          discountAmount: null,
          trackInventory: false,
        }),
      ),
    });

    const cases = [
      ["admin", "call admin.api.get.dashboard.metrics-summary -- {}"],
      ["admin", "call admin.api.get.products.stats -- {}"],
      ["admin", 'call admin.api.get.products -- {"limit":4}'],
      ["admin", 'call admin.api.get.products.by-id -- {"id":"prod_1"}'],
      ["storefront", 'call catalog.search -- {"query":"product","limit":4}'],
      ["storefront", 'call catalog.list -- {"limit":4}'],
      ["storefront", 'call catalog.product -- {"slug":"max-product"}'],
    ] as const;

    for (const [surface, program] of cases) {
      const body = surface === "admin"
        ? await executeAdminFlueCommand(context, { instanceId: INSTANCE_ID, program })
        : await executeStorefrontFlueCommand(context, { instanceId: INSTANCE_ID, program });
      if (!body.success) throw new Error(`Expected ${program} to succeed`);
      expect(new TextEncoder().encode(JSON.stringify(body)).byteLength)
        .toBeLessThanOrEqual(SCALIUS_COMMAND_MAX_RESPONSE_BYTES);
      const admitted = await runScaliusCommand({
        surface,
        instanceId: INSTANCE_ID,
        program,
        api: { fetch: vi.fn(async () => Response.json(body)) },
        timeoutMs: 100,
      });
      expect(admitted).toMatchObject({
        ok: true,
        authoritative: true,
        data: body.data,
      });
    }

    const productBody = await executeStorefrontFlueCommand(context, {
      instanceId: INSTANCE_ID,
      program: 'call catalog.product -- {"slug":"max-product"}',
    });
    expect(productBody).toMatchObject({
      success: true,
      data: {
        result: {
          product: {
            imageSummary: { total: 6, returned: 4, truncated: true },
            optionSummary: { total: 20, returned: 12, truncated: true },
          },
        },
      },
    });
  });
});
