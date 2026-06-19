import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponseFromError } from "../../utils/api-response";

const mocks = vi.hoisted(() => ({
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
  bulkDeleteProducts: vi.fn(),
  deleteProduct: vi.fn(),
  restoreProduct: vi.fn(),
  permanentlyDeleteProduct: vi.fn(),
  getProductStats: vi.fn(),
  listProducts: vi.fn(),
  getProductsByIds: vi.fn(),
  getProductDetails: vi.fn(),
  createVariant: vi.fn(),
  updateVariant: vi.fn(),
  deleteVariant: vi.fn(),
  bulkCreateVariants: vi.fn(),
  bulkDeleteVariants: vi.fn(),
  bulkUpdateVariants: vi.fn(),
  duplicateVariant: vi.fn(),
  getProductVariants: vi.fn(),
  getVariantSortOrder: vi.fn(),
  updateVariantSortOrder: vi.fn(),
  invalidateCatalogCaches: vi.fn(),
}));

vi.mock("@scalius/core/modules/products/products.admin", () => ({
  createProduct: mocks.createProduct,
  updateProduct: mocks.updateProduct,
  bulkDeleteProducts: mocks.bulkDeleteProducts,
  deleteProduct: mocks.deleteProduct,
  restoreProduct: mocks.restoreProduct,
  permanentlyDeleteProduct: mocks.permanentlyDeleteProduct,
  getProductStats: mocks.getProductStats,
  listProducts: mocks.listProducts,
  getProductsByIds: mocks.getProductsByIds,
  getProductDetails: mocks.getProductDetails,
  bulkUpdateVariants: mocks.bulkUpdateVariants,
}));

vi.mock("@scalius/core/modules/products/products.variants", () => ({
  createVariant: mocks.createVariant,
  updateVariant: mocks.updateVariant,
  deleteVariant: mocks.deleteVariant,
  bulkCreateVariants: mocks.bulkCreateVariants,
  bulkDeleteVariants: mocks.bulkDeleteVariants,
  duplicateVariant: mocks.duplicateVariant,
  getProductVariants: mocks.getProductVariants,
  getVariantSortOrder: mocks.getVariantSortOrder,
  updateVariantSortOrder: mocks.updateVariantSortOrder,
}));

vi.mock("../../utils/cache-invalidation", async () => {
  const actual = await vi.importActual<typeof import("../../utils/cache-invalidation")>(
    "../../utils/cache-invalidation",
  );
  return {
    ...actual,
    invalidateCatalogCaches: mocks.invalidateCatalogCaches,
  };
});

import { adminProductsRoutes } from "./products";

function createProductBody(overrides: Record<string, unknown> = {}) {
  return {
    id: "prod_1",
    name: "Hilsa Fish",
    description: "Fresh river hilsa for testing",
    price: 1200,
    categoryId: "cat_new",
    isActive: true,
    freeDelivery: false,
    metaTitle: null,
    metaDescription: null,
    slug: "hilsa-fish",
    images: [
      {
        id: "img_1",
        url: "https://cloud.example.com/hilsa.webp",
        filename: "hilsa.webp",
        size: 1234,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function createVariantBody(overrides: Record<string, unknown> = {}) {
  return {
    size: null,
    color: null,
    weight: null,
    sku: "SKU-1",
    price: 1200,
    stock: 10,
    barcode: null,
    barcodeType: null,
    discountType: "percentage",
    discountPercentage: null,
    discountAmount: null,
    ...overrides,
  };
}

function createDb() {
  const productRows = [
    { productSlug: "old-hilsa", categorySlug: "old-fish" },
  ];
  const categoryRows = [{ slug: "new-fish" }];

  return {
    select: vi.fn((fields: Record<string, unknown>) => {
      const query = {
        from: vi.fn(() => query),
        leftJoin: vi.fn(() => query),
        where: vi.fn(() =>
          Promise.resolve(
            Object.hasOwn(fields, "productSlug") ? productRows : categoryRows,
          ),
        ),
      };
      return query;
    }),
  };
}

function createTestApp() {
  const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
  const db = createDb();
  const env = {
    CACHE: { id: "api-cache-kv" },
    PURGE_URL: "https://storefront.example.com/api/purge-cache",
    PURGE_TOKEN: "secret-token",
  } as unknown as Env;

  mocks.createProduct.mockResolvedValue({ id: "prod_new" });
  mocks.updateProduct.mockResolvedValue(undefined);
  mocks.bulkDeleteProducts.mockResolvedValue(undefined);
  mocks.deleteProduct.mockResolvedValue(undefined);
  mocks.restoreProduct.mockResolvedValue(undefined);
  mocks.permanentlyDeleteProduct.mockResolvedValue(undefined);
  mocks.createVariant.mockResolvedValue({ id: "var_1" });
  mocks.updateVariant.mockResolvedValue({ id: "var_1" });
  mocks.deleteVariant.mockResolvedValue(undefined);
  mocks.bulkCreateVariants.mockResolvedValue([{ id: "var_1" }]);
  mocks.bulkDeleteVariants.mockResolvedValue(undefined);
  mocks.bulkUpdateVariants.mockResolvedValue(undefined);
  mocks.duplicateVariant.mockResolvedValue({ id: "var_2" });
  mocks.updateVariantSortOrder.mockResolvedValue(undefined);
  mocks.invalidateCatalogCaches.mockResolvedValue(undefined);

  app.onError((error, c) => {
    const { body, status } = errorResponseFromError(error);
    return c.json(body, status);
  });
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    await next();
  });
  app.route("/admin/products", adminProductsRoutes);
  return { app, db, env };
}

async function requestJson(
  app: OpenAPIHono<{ Bindings: Env }>,
  env: Env,
  path: string,
  method: string,
  body?: unknown,
) {
  return app.request(
    `/api/v1/admin/products${path}`,
    {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}

describe("admin product cache invalidation", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("warms the new product detail page after product creation", async () => {
    const { app, env } = createTestApp();

    const response = await requestJson(
      app,
      env,
      "",
      "POST",
      createProductBody({ slug: "new-hilsa" }),
    );

    expect(response.status).toBe(201);
    expect(mocks.invalidateCatalogCaches).toHaveBeenCalledWith(
      "products",
      expect.objectContaining({ env }),
      { htmlPaths: ["/products/new-hilsa", "/categories/new-fish"] },
    );
  });

  it("warms old and new product detail pages after slug/category updates", async () => {
    const { app, env } = createTestApp();

    const response = await requestJson(
      app,
      env,
      "/prod_1",
      "PUT",
      createProductBody({ slug: "new-hilsa" }),
    );

    expect(response.status).toBe(200);
    expect(mocks.invalidateCatalogCaches).toHaveBeenCalledWith(
      "products",
      expect.objectContaining({ env }),
      {
        htmlPaths: [
          "/products/old-hilsa",
          "/categories/old-fish",
          "/products/new-hilsa",
          "/categories/new-fish",
        ],
      },
    );
  });

  it.each([
    { label: "bulk delete", path: "/bulk-delete", method: "POST", body: { productIds: ["prod_1"], permanent: false } },
    { label: "soft delete", path: "/prod_1", method: "DELETE" },
    { label: "restore", path: "/prod_1/restore", method: "POST" },
    { label: "permanent delete", path: "/prod_1/permanent", method: "DELETE" },
  ])("warms the affected product detail page before $label", async ({ path, method, body }) => {
    const { app, env } = createTestApp();

    const response = await requestJson(app, env, path, method, body);

    expect([200, 204]).toContain(response.status);
    expect(mocks.invalidateCatalogCaches).toHaveBeenCalledWith(
      "products",
      expect.objectContaining({ env }),
      { htmlPaths: ["/products/old-hilsa", "/categories/old-fish"] },
    );
  });

  it.each([
    { label: "create variant", path: "/prod_1/variants", method: "POST", body: createVariantBody(), status: 201 },
    { label: "update variant", path: "/prod_1/variants/var_1", method: "PUT", body: createVariantBody(), status: 200 },
    { label: "delete variant", path: "/prod_1/variants/var_1", method: "DELETE", status: 204 },
    {
      label: "bulk create variants",
      path: "/prod_1/variants/bulk-create",
      method: "POST",
      body: {
        variants: [
          {
            ...createVariantBody(),
            discountType: "percentage",
            discountPercentage: null,
            discountAmount: null,
          },
        ],
      },
      status: 201,
    },
    { label: "bulk delete variants", path: "/prod_1/variants/bulk-delete", method: "POST", body: { variantIds: ["var_1"] }, status: 204 },
    { label: "bulk update variants", path: "/prod_1/variants/bulk-update", method: "POST", body: { updates: [{ id: "var_1", price: 1300 }] }, status: 200 },
    { label: "duplicate variant", path: "/prod_1/variants/var_1/duplicate", method: "POST", status: 201 },
    {
      label: "sort variants",
      path: "/prod_1/variants/sort-order",
      method: "POST",
      body: { colors: [{ value: "red", sortOrder: 1 }], sizes: [] },
      status: 200,
    },
  ])("warms the parent product detail page after $label", async ({ path, method, body, status }) => {
    const { app, env } = createTestApp();

    const response = await requestJson(app, env, path, method, body);

    expect(response.status).toBe(status);
    expect(mocks.invalidateCatalogCaches).toHaveBeenCalledWith(
      "products",
      expect.objectContaining({ env }),
      { htmlPaths: ["/products/old-hilsa", "/categories/old-fish"] },
    );
  });
});
