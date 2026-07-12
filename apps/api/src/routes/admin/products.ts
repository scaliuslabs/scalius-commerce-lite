import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import * as ProductsAdmin from "@scalius/core/modules/products/products.admin";
import * as ProductsVariants from "@scalius/core/modules/products/products.variants";
import { createProductSchema, updateProductSchema } from "@scalius/core/modules/products/products.validation";
import {
    productOptionMatrixSchema,
    saveProductOptionMatrix,
} from "@scalius/core/modules/products/products.option-matrix";
import type { Database } from "@scalius/database/client";
import { categories, products } from "@scalius/database/schema";
import {
    createVariantSchema,
    updateVariantSchema
} from "@scalius/core/modules/products/products.types";
import { NotFoundError, ValidationError } from "../../utils/api-error";
import { ok, created, noContent } from "../../utils/api-response";
import {
    successEnvelope,
    paginatedEnvelope,
    errorResponses,
    noContentResponse,
} from "../../schemas/responses";
import {
    productSummarySchema,
    productDetailSchema,
    productStatsSchema,
    productVariantSchema,
    productVariantMutationSchema,
    selectedProductOptionSchema,
} from "../../schemas/entities";
import {
    invalidateCatalogCaches,
    MAX_STOREFRONT_EXACT_HTML_PATHS,
    type WaitUntilExecutionContext,
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
    c: { env?: Env; executionCtx?: WaitUntilExecutionContext },
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

const expectedAggregateRevisionSchema = z.coerce.number().int().min(1);
const aggregateRevisionResponseSchema = z.object({
    aggregateRevision: z.number().int().min(1),
});
const expectedAggregateRevisionQuerySchema = z.object({
    expectedAggregateRevision: expectedAggregateRevisionSchema,
});

const bulkDeleteSchema = z.object({
    products: z.array(z.object({
        id: z.string(),
        expectedAggregateRevision: z.number().int().min(1),
    })).min(1).max(90),
    permanent: z.boolean().default(false)
});
const bulkDeleteOutcomeSchema = z.object({
    id: z.string(),
    status: z.enum(["trashed", "deleted", "blocked", "failed"]),
    code: z.string().nullable(),
    message: z.string().nullable(),
});

const productMutationConflictResponse = {
    description: "Product revision or domain conflict",
    content: {
        "application/json": {
            schema: z.union([
                z.object({
                    success: z.literal(false),
                    error: z.object({
                        code: z.literal("PRODUCT_REVISION_CONFLICT"),
                        message: z.string(),
                        details: z.object({
                            expectedRevision: z.number().int().min(1),
                            currentRevision: z.number().int().min(1).nullable(),
                        }),
                    }),
                }),
                z.object({
                    success: z.literal(false),
                    error: z.object({
                        code: z.literal("PRODUCT_MEDIA_SKU_REFERENCE_CONFLICT"),
                        message: z.string(),
                        details: z.object({
                            affectedCount: z.number().int().positive(),
                            affectedAssociationIds: z.array(z.string()).max(20),
                            affectedSkus: z.array(z.object({
                                id: z.string(),
                                sku: z.string(),
                                imageId: z.string(),
                            })).max(5),
                        }),
                    }),
                }),
                z.object({
                    success: z.literal(false),
                    error: z.object({
                        code: z.string(),
                        message: z.string(),
                        details: z.unknown().optional(),
                    }),
                }),
            ]),
        },
    },
} as const;

const conflictMutationErrorResponses = {
    ...errorResponses,
    409: productMutationConflictResponse,
} as const;

// ── Barcode Lookup ──

const barcodeLookupRoute = createRoute({
    method: "get",
    path: "/lookup-barcode",
    tags: ["Admin - Products"],
    summary: "Look up a product variant by barcode",
    request: {
        query: z.object({
            barcode: z.string().trim().min(1).openapi({ description: "Barcode value to search for" }),
        }),
    },
    responses: {
        200: {
            description: "Variant found",
            content: { "application/json": { schema: successEnvelope(z.object({
                variant: z.object({
                    id: z.string(),
                    sku: z.string(),
                    imageId: z.string().nullable(),
                    selectedOptions: z.array(selectedProductOptionSchema),
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
        409: productMutationConflictResponse,
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
            content: { "application/json": { schema: successEnvelope(z.object({
                id: z.string(),
                aggregateRevision: z.number().int().min(1),
            })) } },
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
        200: {
            description: "Products deleted",
            content: { "application/json": { schema: successEnvelope(z.object({
                products: z.array(z.object({
                    id: z.string(),
                    aggregateRevision: z.number().int().min(1),
                })),
                deletedIds: z.array(z.string()),
                outcomes: z.array(bulkDeleteOutcomeSchema),
            })) } },
        },
        ...conflictMutationErrorResponses,
    }
});

app.openapi(bulkDeleteRoute, async (c) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    const productIds = data.products.map((product) => product.id);
    const htmlPaths = await productStorefrontHtmlPathsByIds(db, productIds);
    const result = await ProductsAdmin.bulkDeleteProducts(db, data.products, data.permanent);
    const deletedIds = result.outcomes
        .filter((outcome) => outcome.status === "deleted")
        .map((outcome) => outcome.id);
    if (!data.permanent || deletedIds.length > 0) {
        await invalidateCatalogCaches("products", c, { htmlPaths });
    }
    return ok(c, {
        products: result.revisions.map((revision, index) => ({
            id: data.products[index]!.id,
            aggregateRevision: revision.aggregateRevision,
        })),
        deletedIds,
        outcomes: result.outcomes,
    });
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
            content: { "application/json": { schema: successEnvelope(aggregateRevisionResponseSchema) } },
        },
        ...conflictMutationErrorResponses,
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
        const result = await ProductsAdmin.updateProduct(db, id, data);
        await invalidateCatalogCaches("products", c, { htmlPaths });
        return ok(c, result);
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
        query: expectedAggregateRevisionQuerySchema,
    },
    responses: {
        200: {
            description: "Product moved to trash",
            content: { "application/json": { schema: successEnvelope(aggregateRevisionResponseSchema) } },
        },
        ...conflictMutationErrorResponses,
    }
});

app.openapi(deleteProductRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const { expectedAggregateRevision } = c.req.valid("query");
    const htmlPaths = await productStorefrontHtmlPathsByIds(db, [id]);
    const result = await ProductsAdmin.deleteProduct(db, id, expectedAggregateRevision);
    await invalidateCatalogCaches("products", c, { htmlPaths });
    return ok(c, result);
});

// ── Restore Product ──

const restoreProductRoute = createRoute({
    method: "post",
    path: "/{id}/restore",
    tags: ["Admin - Products"],
    summary: "Restore a soft-deleted product",
    request: {
        params: z.object({ id: z.string() }),
        query: expectedAggregateRevisionQuerySchema,
    },
    responses: {
        200: {
            description: "Product restored",
            content: { "application/json": { schema: successEnvelope(aggregateRevisionResponseSchema) } },
        },
        ...conflictMutationErrorResponses,
    }
});

app.openapi(restoreProductRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const { expectedAggregateRevision } = c.req.valid("query");
    const htmlPaths = await productStorefrontHtmlPathsByIds(db, [id]);
    const result = await ProductsAdmin.restoreProduct(db, id, expectedAggregateRevision);
    await invalidateCatalogCaches("products", c, { htmlPaths });
    return ok(c, result);
});

// ── Permanent Delete Product ──

const permanentDeleteRoute = createRoute({
    method: "delete",
    path: "/{id}/permanent",
    tags: ["Admin - Products"],
    summary: "Permanently delete a product",
    request: {
        params: z.object({ id: z.string() }),
        query: expectedAggregateRevisionQuerySchema,
    },
    responses: {
        204: noContentResponse,
        ...conflictMutationErrorResponses,
    }
});

app.openapi(permanentDeleteRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const { expectedAggregateRevision } = c.req.valid("query");
    const htmlPaths = await productStorefrontHtmlPathsByIds(db, [id]);
    await ProductsAdmin.permanentlyDeleteProduct(db, id, expectedAggregateRevision);
    await invalidateCatalogCaches("products", c, { htmlPaths });
    return noContent(c);
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
            content: { "application/json": { schema: successEnvelope(productVariantMutationSchema as z.ZodTypeAny) } },
        },
        ...conflictMutationErrorResponses,
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
        ...conflictMutationErrorResponses,
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
            content: { "application/json": { schema: successEnvelope(productVariantMutationSchema as z.ZodTypeAny) } },
        },
        ...conflictMutationErrorResponses,
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
        query: expectedAggregateRevisionQuerySchema,
    },
    responses: {
        200: {
            description: "Variant deleted",
            content: { "application/json": { schema: successEnvelope(aggregateRevisionResponseSchema) } },
        },
        ...conflictMutationErrorResponses,
    }
});

app.openapi(deleteVariantRoute, async (c) => {
    const db = c.get("db");
    const { id, variantId } = c.req.valid("param");
    const { expectedAggregateRevision } = c.req.valid("query");
    try {
        const result = await ProductsVariants.deleteVariant(
            db,
            id,
            variantId,
            expectedAggregateRevision,
        );
        await invalidateProductCatalogCaches(db, c, [id]);
        return ok(c, result);
    } catch (error: unknown) {
        if (error instanceof Error && error.message === "Variant not found") throw new NotFoundError(error.message);
        throw error;
    }
});

const saveOptionMatrixRoute = createRoute({
    method: "put",
    path: "/{id}/options/matrix",
    tags: ["Admin - Products"],
    summary: "Save the complete normalized product option matrix",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: productOptionMatrixSchema } } },
    },
    responses: {
        200: {
            description: "Option matrix saved",
            content: { "application/json": { schema: successEnvelope(aggregateRevisionResponseSchema) } },
        },
        ...conflictMutationErrorResponses,
    },
});

app.openapi(saveOptionMatrixRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const user = c.get("user");
    const result = await saveProductOptionMatrix(db, id, c.req.valid("json"), user?.id);
    await invalidateProductCatalogCaches(db, c, [id]);
    return ok(c, result);
});

export { app as adminProductsRoutes };
