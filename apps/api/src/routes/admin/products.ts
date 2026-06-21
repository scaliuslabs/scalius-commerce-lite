import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import * as ProductsAdmin from "@scalius/core/modules/products/products.admin";
import * as ProductsVariants from "@scalius/core/modules/products/products.variants";
import { createProductSchema, updateProductSchema } from "@scalius/core/modules/products/products.validation";
import type { Database } from "@scalius/database/client";
import { categories, products } from "@scalius/database/schema";
import {
    createVariantSchema,
    updateVariantSchema,
    bulkCreateVariantsSchema,
    bulkDeleteVariantsSchema,
    bulkUpdateVariantsSchema,
    updateSortOrderSchema
} from "@scalius/core/modules/products/products.types";
import { NotFoundError, ConflictError, ValidationError } from "../../utils/api-error";
import { ok, created, noContent } from "../../utils/api-response";
import {
    successEnvelope,
    paginatedEnvelope,
    errorResponses,
    messageResponse,
    idResponse,
    noContentResponse,
} from "../../schemas/responses";
import {
    productSummarySchema,
    productDetailSchema,
    productStatsSchema,
    productVariantSchema,
} from "../../schemas/entities";
import {
    invalidateCatalogCaches,
    MAX_STOREFRONT_EXACT_HTML_PATHS,
} from "../../utils/cache-invalidation";
import { eq, inArray } from "drizzle-orm";

const app = new OpenAPIHono<{ Bindings: Env }>();

const productPickerSummarySchema = z.object({
    id: z.string(),
    name: z.string(),
    price: z.number(),
    categoryId: z.string().nullable(),
    primaryImage: z.string().nullable(),
    discountPercentage: z.number().nullable(),
});

function parseLookupIds(ids: string | undefined): string[] {
    return Array.from(new Set((ids ?? "").split(",").map((id) => id.trim()).filter(Boolean))).slice(0, 100);
}

function categoryHtmlPath(slug: string | null | undefined): string[] {
    return slug ? [`/categories/${slug}`] : [];
}

function productHtmlPath(slug: string | null | undefined): string[] {
    return slug ? [`/products/${slug}`] : [];
}

async function categoryHtmlPathsByIds(
    db: Database,
    categoryIds: readonly string[],
): Promise<string[]> {
    const ids = [...new Set(categoryIds.filter(Boolean))]
        .slice(0, MAX_STOREFRONT_EXACT_HTML_PATHS);
    if (ids.length === 0) return [];

    const rows = await db
        .select({ slug: categories.slug })
        .from(categories)
        .where(inArray(categories.id, ids));

    return rows.flatMap((category) => categoryHtmlPath(category.slug));
}

async function productStorefrontHtmlPathsByIds(
    db: Database,
    productIds: readonly string[],
): Promise<string[]> {
    const ids = [...new Set(productIds.filter(Boolean))]
        .slice(0, MAX_STOREFRONT_EXACT_HTML_PATHS);
    if (ids.length === 0) return [];

    const rows = await db
        .select({
            productSlug: products.slug,
            categorySlug: categories.slug,
        })
        .from(products)
        .leftJoin(categories, eq(categories.id, products.categoryId))
        .where(inArray(products.id, ids));

    return [
        ...rows.flatMap((row) => productHtmlPath(row.productSlug)),
        ...rows.flatMap((row) => categoryHtmlPath(row.categorySlug)),
    ];
}

async function invalidateProductCatalogCaches(
    db: Database,
    c: { env?: Env; executionCtx?: ExecutionContext },
    productIds: readonly string[],
    htmlPaths: readonly string[] = [],
) {
    await invalidateCatalogCaches("products", c, {
        htmlPaths: [
            ...(await productStorefrontHtmlPathsByIds(db, productIds)),
            ...htmlPaths,
        ],
    });
}

// ── Product Stats ──

const statsRoute = createRoute({
    method: "get",
    path: "/stats",
    tags: ["Admin - Products"],
    summary: "Get product and category dashboard statistics",
    responses: {
        200: {
            description: "Product stats",
            content: { "application/json": { schema: successEnvelope(productStatsSchema) } },
        },
        ...errorResponses,
    },
});

app.openapi(statsRoute, async (c) => {
    const db = c.get("db");
    const stats = await ProductsAdmin.getProductStats(db);
    return ok(c, stats);
});

const bulkDeleteSchema = z.object({
    productIds: z.array(z.string()),
    permanent: z.boolean().default(false)
});

// ── Barcode Lookup ──

const barcodeLookupRoute = createRoute({
    method: "get",
    path: "/lookup-barcode",
    tags: ["Admin - Products"],
    summary: "Look up a product variant by barcode",
    request: {
        query: z.object({
            barcode: z.string().min(1).openapi({ description: "Barcode value to search for" }),
        }),
    },
    responses: {
        200: {
            description: "Variant found",
            content: { "application/json": { schema: successEnvelope(z.object({
                variant: z.object({
                    id: z.string(),
                    sku: z.string(),
                    size: z.string().nullable(),
                    color: z.string().nullable(),
                    weight: z.number().nullable(),
                    price: z.number(),
                    stock: z.number(),
                    reservedStock: z.number(),
                    barcode: z.string().nullable(),
                    barcodeType: z.string().nullable(),
                }).passthrough(),
                product: z.object({
                    id: z.string(),
                    name: z.string(),
                    slug: z.string(),
                    price: z.number(),
                    isActive: z.boolean(),
                }).passthrough(),
            })) } },
        },
        404: errorResponses[404],
    },
});

app.openapi(barcodeLookupRoute, async (c) => {
    const db = c.get("db");
    const { barcode } = c.req.valid("query");
    const result = await ProductsVariants.lookupByBarcode(db, barcode);
    if (!result) {
        throw new NotFoundError("No variant found with this barcode");
    }
    return ok(c, result);
});

// ── List Products ──

const listRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Products"],
    summary: "List all products",
    request: {
        query: z.object({
            page: z.coerce.number().default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().max(100).default(10).openapi({ description: "Items per page" }),
            search: z.string().optional().openapi({ description: "Search term" }),
            category: z.string().optional().openapi({ description: "Category ID filter" }),
            trashed: z.string().optional().openapi({ description: "Show trashed items" }),
            sort: z.string().optional().default("updatedAt").openapi({ description: "Sort field" }),
            order: z.string().optional().default("desc").openapi({ description: "Sort order" })
        })
    },
    responses: {
        200: {
            description: "Product list with pagination",
            content: { "application/json": { schema: paginatedEnvelope("products", productSummarySchema) } },
        },
        ...errorResponses,
    }
});

app.openapi(listRoute, async (c) => {
    const db = c.get("db");
    const query = c.req.valid("query");
    const result = await ProductsAdmin.listProducts(db, {
        page: query.page,
        limit: query.limit,
        search: query.search || undefined,
        categoryId: query.category || undefined,
        showTrashed: query.trashed === "true",
        sort: query.sort as "name" | "price" | "category" | "createdAt" | "updatedAt" | undefined,
        order: query.order as "asc" | "desc" | undefined
    });
    return ok(c, result);
});

// ── Product Picker Summaries ──

const getByIdsRoute = createRoute({
    method: "get",
    path: "/by-ids",
    tags: ["Admin - Products"],
    summary: "Get lightweight product summaries for known IDs",
    request: {
        query: z.object({
            ids: z.string().optional().default("").openapi({
                description: "Comma-separated product IDs. At most 100 IDs are resolved.",
            }),
        }),
    },
    responses: {
        200: {
            description: "Product summaries",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        products: z.array(productPickerSummarySchema),
                    })),
                },
            },
        },
        ...errorResponses,
    },
});

app.openapi(getByIdsRoute, async (c) => {
    const db = c.get("db");
    const { ids } = c.req.valid("query");
    const products = await ProductsAdmin.getProductsByIds(db, parseLookupIds(ids));
    return ok(c, { products });
});

// ── Create Product ──

const createProductRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Admin - Products"],
    summary: "Create a product",
    request: {
        body: { content: { "application/json": { schema: createProductSchema } } }
    },
    responses: {
        201: {
            description: "Product created",
            content: { "application/json": { schema: idResponse } },
        },
        ...errorResponses,
    }
});

app.openapi(createProductRoute, async (c) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    try {
        const result = await ProductsAdmin.createProduct(db, data);
        await invalidateCatalogCaches("products", c, {
            htmlPaths: [
                ...productHtmlPath(data.slug),
                ...(await categoryHtmlPathsByIds(db, [data.categoryId])),
            ],
        });
        return created(c, result);
    } catch (error: unknown) {
        if (error instanceof Error && error.message?.includes("slug")) {
            throw new ValidationError(error.message);
        }
        throw error;
    }
});

// ── Bulk Delete Products ──

const bulkDeleteRoute = createRoute({
    method: "post",
    path: "/bulk-delete",
    tags: ["Admin - Products"],
    summary: "Bulk delete products",
    request: {
        body: { content: { "application/json": { schema: bulkDeleteSchema } } }
    },
    responses: {
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(bulkDeleteRoute, async (c) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    try {
        const htmlPaths = await productStorefrontHtmlPathsByIds(db, data.productIds);
        await ProductsAdmin.bulkDeleteProducts(db, data.productIds, data.permanent);
        await invalidateCatalogCaches("products", c, { htmlPaths });
        return noContent(c);
    } catch (error: unknown) {
        if (error instanceof Error && error.message?.includes("delete")) {
            throw new ConflictError(error.message);
        }
        throw error;
    }
});

// ── Get Product By ID ──

const getByIdRoute = createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Admin - Products"],
    summary: "Get a product by ID with all details",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: {
            description: "Product details",
            content: { "application/json": { schema: successEnvelope(productDetailSchema) } },
        },
        404: errorResponses[404],
    }
});

app.openapi(getByIdRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const product = await ProductsAdmin.getProductDetails(db, id);
    if (!product) throw new NotFoundError("Product not found");
    return ok(c, product);
});

// ── Update Product ──

const updateProductRoute = createRoute({
    method: "put",
    path: "/{id}",
    tags: ["Admin - Products"],
    summary: "Update a product",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: updateProductSchema } } }
    },
    responses: {
        200: {
            description: "Product updated",
            content: { "application/json": { schema: successEnvelope(z.object({})) } },
        },
        ...errorResponses,
    }
});

app.openapi(updateProductRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    try {
        const htmlPaths = [
            ...(await productStorefrontHtmlPathsByIds(db, [id])),
            ...productHtmlPath(data.slug),
            ...(await categoryHtmlPathsByIds(db, [data.categoryId])),
        ];
        await ProductsAdmin.updateProduct(db, id, data);
        await invalidateCatalogCaches("products", c, { htmlPaths });
        return ok(c, {});
    } catch (error: unknown) {
        if (error instanceof Error) {
            if (error.message === "Product not found") throw new NotFoundError(error.message);
            if (error.message?.includes("slug")) throw new ValidationError(error.message);
        }
        throw error;
    }
});

// ── Delete Product ──

const deleteProductRoute = createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Admin - Products"],
    summary: "Soft-delete a product",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(deleteProductRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const htmlPaths = await productStorefrontHtmlPathsByIds(db, [id]);
    await ProductsAdmin.deleteProduct(db, id);
    await invalidateCatalogCaches("products", c, { htmlPaths });
    return noContent(c);
});

// ── Restore Product ──

const restoreProductRoute = createRoute({
    method: "post",
    path: "/{id}/restore",
    tags: ["Admin - Products"],
    summary: "Restore a soft-deleted product",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: {
            description: "Product restored",
            content: { "application/json": { schema: successEnvelope(z.object({})) } },
        },
        ...errorResponses,
    }
});

app.openapi(restoreProductRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const htmlPaths = await productStorefrontHtmlPathsByIds(db, [id]);
    await ProductsAdmin.restoreProduct(db, id);
    await invalidateCatalogCaches("products", c, { htmlPaths });
    return ok(c, {});
});

// ── Permanent Delete Product ──

const permanentDeleteRoute = createRoute({
    method: "delete",
    path: "/{id}/permanent",
    tags: ["Admin - Products"],
    summary: "Permanently delete a product",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(permanentDeleteRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    try {
        const htmlPaths = await productStorefrontHtmlPathsByIds(db, [id]);
        await ProductsAdmin.permanentlyDeleteProduct(db, id);
        await invalidateCatalogCaches("products", c, { htmlPaths });
        return noContent(c);
    } catch (error: unknown) {
        if (error instanceof Error && error.message?.includes("delete")) {
            throw new ConflictError(error.message);
        }
        throw error;
    }
});

// ── Create Variant ──

const createVariantRoute = createRoute({
    method: "post",
    path: "/{id}/variants",
    tags: ["Admin - Products"],
    summary: "Create a product variant",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: createVariantSchema } } }
    },
    responses: {
        201: {
            description: "Variant created",
            content: { "application/json": { schema: successEnvelope(productVariantSchema as z.ZodTypeAny) } },
        },
        ...errorResponses,
    }
});

app.openapi(createVariantRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    try {
        const result = await ProductsVariants.createVariant(db, id, data);
        if (!result) throw new NotFoundError("Failed to create variant");
        await invalidateProductCatalogCaches(db, c, [id]);
        return created(c, result);
    } catch (error: unknown) {
        if (error instanceof Error && error.message?.includes("SKU")) throw new ValidationError(error.message);
        throw error;
    }
});

// ── List Variants ──

const listVariantsRoute = createRoute({
    method: "get",
    path: "/{id}/variants",
    tags: ["Admin - Products"],
    summary: "List variants for a product",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: {
            description: "Variant list",
            content: { "application/json": { schema: successEnvelope(z.object({
                variants: z.array(productVariantSchema),
            }) as z.ZodTypeAny) } },
        },
        ...errorResponses,
    }
});

app.openapi(listVariantsRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const variants = await ProductsVariants.getProductVariants(db, id);
    return ok(c, { variants });
});

// ── Update Variant ──

const updateVariantRoute = createRoute({
    method: "put",
    path: "/{id}/variants/{variantId}",
    tags: ["Admin - Products"],
    summary: "Update a product variant",
    request: {
        params: z.object({ id: z.string(), variantId: z.string() }),
        body: { content: { "application/json": { schema: updateVariantSchema } } }
    },
    responses: {
        200: {
            description: "Variant updated",
            content: { "application/json": { schema: successEnvelope(productVariantSchema as z.ZodTypeAny) } },
        },
        ...errorResponses,
    }
});

app.openapi(updateVariantRoute, async (c) => {
    const db = c.get("db");
    const { id, variantId } = c.req.valid("param");
    const data = c.req.valid("json");
    const user = c.get("user");
    try {
        const result = await ProductsVariants.updateVariant(db, id, variantId, data, user?.id);
        if (!result) throw new NotFoundError("Variant not found");
        await invalidateProductCatalogCaches(db, c, [id]);
        return ok(c, result);
    } catch (error: unknown) {
        if (error instanceof Error) {
            if (error.message === "Variant not found") throw new NotFoundError(error.message);
            if (error.message?.includes("SKU")) throw new ValidationError(error.message);
        }
        throw error;
    }
});

// ── Delete Variant ──

const deleteVariantRoute = createRoute({
    method: "delete",
    path: "/{id}/variants/{variantId}",
    tags: ["Admin - Products"],
    summary: "Delete a product variant",
    request: {
        params: z.object({ id: z.string(), variantId: z.string() }),
    },
    responses: {
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(deleteVariantRoute, async (c) => {
    const db = c.get("db");
    const { id, variantId } = c.req.valid("param");
    try {
        await ProductsVariants.deleteVariant(db, id, variantId);
        await invalidateProductCatalogCaches(db, c, [id]);
        return noContent(c);
    } catch (error: unknown) {
        if (error instanceof Error && error.message === "Variant not found") throw new NotFoundError(error.message);
        throw error;
    }
});

// ── Bulk Create Variants ──

const bulkCreateVariantsRoute = createRoute({
    method: "post",
    path: "/{id}/variants/bulk-create",
    tags: ["Admin - Products"],
    summary: "Bulk create variants",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: bulkCreateVariantsSchema } } }
    },
    responses: {
        201: {
            description: "Variants created",
            content: { "application/json": { schema: successEnvelope(z.object({
                variants: z.array(productVariantSchema),
                count: z.number(),
            }) as z.ZodTypeAny) } },
        },
        ...errorResponses,
    }
});

app.openapi(bulkCreateVariantsRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    try {
        const variants = await ProductsVariants.bulkCreateVariants(db, id, data.variants);
        await invalidateProductCatalogCaches(db, c, [id]);
        return created(c, { variants, count: variants.length });
    } catch (error: unknown) {
        if (error instanceof Error && error.message?.includes("SKU")) throw new ValidationError(error.message);
        throw error;
    }
});

// ── Bulk Delete Variants ──

const bulkDeleteVariantsRoute = createRoute({
    method: "post",
    path: "/{id}/variants/bulk-delete",
    tags: ["Admin - Products"],
    summary: "Bulk delete variants",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: bulkDeleteVariantsSchema } } }
    },
    responses: {
        204: noContentResponse,
        ...errorResponses,
    }
});

app.openapi(bulkDeleteVariantsRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    await ProductsVariants.bulkDeleteVariants(db, id, data.variantIds);
    await invalidateProductCatalogCaches(db, c, [id]);
    return noContent(c);
});

// ── Bulk Update Variants ──

const bulkUpdateVariantsRoute = createRoute({
    method: "post",
    path: "/{id}/variants/bulk-update",
    tags: ["Admin - Products"],
    summary: "Bulk update variants",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: bulkUpdateVariantsSchema } } }
    },
    responses: {
        200: {
            description: "Variants updated",
            content: { "application/json": { schema: successEnvelope(z.object({})) } },
        },
        ...errorResponses,
    }
});

app.openapi(bulkUpdateVariantsRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    const user = c.get("user");
    if (data.updates.length === 0) throw new ValidationError("No updates provided");
    await ProductsAdmin.bulkUpdateVariants(db, id, data.updates, user?.id);
    await invalidateProductCatalogCaches(db, c, [id]);
    return ok(c, {});
});

// ── Duplicate Variant ──

const duplicateVariantRoute = createRoute({
    method: "post",
    path: "/{id}/variants/{variantId}/duplicate",
    tags: ["Admin - Products"],
    summary: "Duplicate a variant",
    request: {
        params: z.object({ id: z.string(), variantId: z.string() }),
    },
    responses: {
        201: {
            description: "Variant duplicated",
            content: { "application/json": { schema: successEnvelope(productVariantSchema as z.ZodTypeAny) } },
        },
        ...errorResponses,
    }
});

app.openapi(duplicateVariantRoute, async (c) => {
    const db = c.get("db");
    const { id, variantId } = c.req.valid("param");
    try {
        const variant = await ProductsVariants.duplicateVariant(db, id, variantId);
        if (!variant) throw new NotFoundError("Failed to duplicate variant");
        await invalidateProductCatalogCaches(db, c, [id]);
        return created(c, variant);
    } catch (error: unknown) {
        if (error instanceof Error && error.message === "Variant not found") throw new NotFoundError(error.message);
        throw error;
    }
});

// ── Get Variant Sort Order ──

const getVariantSortOrderRoute = createRoute({
    method: "get",
    path: "/{id}/variants/sort-order",
    tags: ["Admin - Products"],
    summary: "Get variant sort order",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: {
            description: "Sort order data",
            content: { "application/json": { schema: successEnvelope(z.object({
                colors: z.array(z.object({ value: z.string(), sortOrder: z.number() })),
                sizes: z.array(z.object({ value: z.string(), sortOrder: z.number() })),
            })) } },
        },
        ...errorResponses,
    }
});

app.openapi(getVariantSortOrderRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const result = await ProductsVariants.getVariantSortOrder(db, id);
    return ok(c, result);
});

// ── Update Variant Sort Order ──

const updateVariantSortOrderRoute = createRoute({
    method: "post",
    path: "/{id}/variants/sort-order",
    tags: ["Admin - Products"],
    summary: "Update variant sort order",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: updateSortOrderSchema } } }
    },
    responses: {
        200: {
            description: "Sort order updated",
            content: { "application/json": { schema: messageResponse } },
        },
        ...errorResponses,
    }
});

app.openapi(updateVariantSortOrderRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    await ProductsVariants.updateVariantSortOrder(db, id, data);
    await invalidateProductCatalogCaches(db, c, [id]);
    return ok(c, { message: "Sort order updated successfully" });
});

export { app as adminProductsRoutes };
