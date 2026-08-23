import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import * as ProductsAdmin from "@scalius/core/modules/products/products.admin";
import * as ProductsVariants from "@scalius/core/modules/products/products.variants";
import { createProductSchema, updateProductSchema } from "@scalius/core/modules/products/products.validation";
import {
    productOptionMatrixSchema,
    saveProductOptionMatrix,
} from "@scalius/core/modules/products/products.option-matrix";
import {
    createVariantSchema,
    updateVariantSchema
} from "@scalius/core/modules/products/products.types";
import { PRODUCT_CONDITION_VALUES } from "@scalius/shared/product-condition";
import {
    getProductSemanticSection,
    productSemanticSectionPatchSchema,
    productSemanticSectionQuerySchema,
    productSemanticSectionSchema,
    updateProductSemanticSection,
} from "@scalius/core/modules/products/products.semantic-sections";
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
    type WaitUntilExecutionContext,
} from "../../utils/cache-invalidation";

const app = new OpenAPIHono<{ Bindings: Env }>();

const productPickerSummarySchema = z.object({
    id: z.string(),
    name: z.string(),
    price: z.number(),
    categoryId: z.string().nullable(),
    primaryImage: z.string().nullable(),
    discountPercentage: z.number().nullable(),
});

const productAgentSummarySchema = z.object({
    id: z.string().max(180),
    name: z.string().max(100),
    slug: z.string().max(100),
    price: z.number(),
    isActive: z.boolean(),
    aggregateRevision: z.number().int().min(1),
    category: z.object({ name: z.string().max(100) }),
    variantCount: z.number().int().nonnegative(),
    sku: z.string().max(100).optional(),
});

const semanticPageSchema = {
    total: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    nextOffset: z.number().int().nonnegative().nullable(),
} as const;
const semanticTextChunkSchema = {
    value: z.string().max(12_000),
    totalCharacters: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
    isNull: z.boolean(),
} as const;
const semanticOptionSchema = z.object({
    id: z.string(),
    name: z.string(),
    position: z.number().int(),
    standardMapping: z.enum(["size", "color", "material", "pattern", "none"]),
    values: z.array(z.object({ id: z.string(), value: z.string(), position: z.number().int() })).max(150),
});
const productSemanticSectionResponseSchema = z.discriminatedUnion("section", [
    z.object({
        section: z.literal("base"),
        aggregateRevision: z.number().int().min(1),
        product: z.object({
            id: z.string(),
            name: z.string(),
            price: z.number(),
            categoryId: z.string().nullable(),
            categoryName: z.string().nullable(),
            slug: z.string(),
            canonicalPath: z.string().nullable(),
            noIndex: z.boolean(),
            excludeFromSitemap: z.boolean(),
            excludeFromProductFeed: z.boolean(),
            productCondition: z.enum(PRODUCT_CONDITION_VALUES).nullable(),
            isActive: z.boolean(),
            discountType: z.enum(["percentage", "flat"]).nullable(),
            discountPercentage: z.number().nullable(),
            discountAmount: z.number().nullable(),
            freeDelivery: z.boolean(),
            createdAt: z.union([z.string(), z.number()]),
            updatedAt: z.union([z.string(), z.number()]),
            deletedAt: z.union([z.string(), z.number()]).nullable(),
            textLengths: z.object({
                description: z.number().int().nonnegative(),
                metaTitle: z.number().int().nonnegative(),
                metaDescription: z.number().int().nonnegative(),
            }),
            counts: z.object({
                media: z.number().int().nonnegative(),
                attributes: z.number().int().nonnegative(),
                additionalInfo: z.number().int().nonnegative(),
                options: z.number().int().nonnegative(),
                variants: z.number().int().nonnegative(),
            }),
        }),
    }),
    z.object({
        section: z.literal("text"),
        field: z.enum(["description", "metaTitle", "metaDescription"]),
        aggregateRevision: z.number().int().min(1),
        ...semanticTextChunkSchema,
    }),
    z.object({
        section: z.literal("media"),
        aggregateRevision: z.number().int().min(1),
        items: z.array(z.object({
            id: z.string(),
            mediaId: z.string(),
            altText: z.string().nullable(),
            isPrimary: z.boolean(),
            sortOrder: z.number().int(),
        })).max(20),
        ...semanticPageSchema,
    }),
    z.object({
        section: z.literal("attributes"),
        aggregateRevision: z.number().int().min(1),
        items: z.array(z.object({ attributeId: z.string(), value: z.string() })).max(50),
        ...semanticPageSchema,
    }),
    z.object({
        section: z.literal("additional_info"),
        aggregateRevision: z.number().int().min(1),
        items: z.array(z.object({
            id: z.string(),
            sortOrder: z.number().int(),
            titleCharacters: z.number().int().nonnegative(),
            contentCharacters: z.number().int().nonnegative(),
        })).max(50),
        ...semanticPageSchema,
    }),
    z.object({
        section: z.literal("additional_info_text"),
        itemId: z.string(),
        field: z.enum(["title", "content"]),
        sortOrder: z.number().int(),
        aggregateRevision: z.number().int().min(1),
        ...semanticTextChunkSchema,
    }),
    z.object({
        section: z.literal("options"),
        aggregateRevision: z.number().int().min(1),
        items: z.array(semanticOptionSchema).max(1),
        ...semanticPageSchema,
    }),
    z.object({
        section: z.literal("variants"),
        aggregateRevision: z.number().int().min(1),
        items: z.array(z.object({
            id: z.string(),
            selectedOptionValueIds: z.array(z.string()).max(5),
            selectedOptions: z.array(selectedProductOptionSchema).max(5),
            imageId: z.string().nullable(),
            weight: z.number().nullable(),
            sku: z.string(),
            price: z.number(),
            stock: z.number().int(),
            trackInventory: z.boolean(),
            barcode: z.string().nullable(),
            barcodeType: z.enum(["ean13", "upc", "isbn", "gtin", "code128", "custom"]).nullable(),
            discountType: z.enum(["percentage", "flat"]).nullable(),
            discountPercentage: z.number().nullable(),
            discountAmount: z.number().nullable(),
        })).max(10),
        ...semanticPageSchema,
    }),
]);

function parseLookupIds(ids: string | undefined): string[] {
    return Array.from(new Set((ids ?? "").split(",").map((id) => id.trim()).filter(Boolean))).slice(0, 100);
}

async function invalidateProductCatalogCaches(
    c: { env?: Env; executionCtx?: WaitUntilExecutionContext },
) {
    await invalidateCatalogCaches("products", c);
}

// ── Product Stats ──

const statsRoute = createRoute({
    method: "get",
    path: "/stats",
    operationId: "dashboard.products.stats",
    tags: ["Admin - Products"],
    summary: "Get product and category dashboard statistics",
    description: "Answer quick product, catalog, category, and merchandising count questions.",
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
    operationId: "dashboard.products.lookup_barcode",
    tags: ["Admin - Products"],
    summary: "Look up a product variant by barcode",
    request: {
        query: z.object({
            barcode: z.string().trim().min(1).max(50).openapi({ description: "Barcode value to search for" }),
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
    operationId: "dashboard.products.list",
    tags: ["Admin - Products"],
    summary: "List all products",
    request: {
        query: z.object({
            page: z.coerce.number().int().min(1).default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().int().min(1).max(100).default(10).openapi({ description: "Items per page" }),
            search: z.string().trim().max(120).optional().openapi({ description: "Search term" }),
            category: z.string().optional().openapi({ description: "Category ID filter" }),
            trashed: z.enum(["true", "false"]).optional().openapi({ description: "Show trashed items" }),
            view: z.enum(["full", "compact"]).optional().default("full").openapi({ description: "Compact lists omit rich descriptions" }),
            sort: z.enum(["name", "price", "category", "createdAt", "updatedAt"]).optional().default("updatedAt").openapi({ description: "Sort field" }),
            order: z.enum(["asc", "desc"]).optional().default("desc").openapi({ description: "Sort order" })
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
        includeDescription: query.view !== "compact",
        sort: query.sort as "name" | "price" | "category" | "createdAt" | "updatedAt" | undefined,
        order: query.order as "asc" | "desc" | undefined
    });
    return ok(c, result);
});

// ── Bounded Product Summaries for Agents ──

const listAgentSummariesRoute = createRoute({
    method: "get",
    path: "/summaries",
    operationId: "dashboard.products.list_summaries",
    tags: ["Admin - Products"],
    summary: "List bounded product summaries",
    request: {
        query: z.object({
            page: z.coerce.number().int().min(1).default(1),
            limit: z.coerce.number().int().min(1).max(50).default(20),
            search: z.string().trim().max(120).optional(),
            category: z.string().max(180).optional(),
            trashed: z.enum(["true", "false"]).optional(),
            sort: z.enum(["name", "price", "category", "createdAt", "updatedAt"]).optional().default("updatedAt"),
            order: z.enum(["asc", "desc"]).optional().default("desc"),
        }),
    },
    responses: {
        200: {
            description: "Bounded product summaries with pagination",
            content: { "application/json": { schema: paginatedEnvelope("products", productAgentSummarySchema) } },
        },
        ...errorResponses,
    },
});

app.openapi(listAgentSummariesRoute, async (c) => {
    const db = c.get("db");
    const query = c.req.valid("query");
    const result = await ProductsAdmin.listProductAgentSummaries(db, {
        page: query.page,
        limit: query.limit,
        search: query.search || undefined,
        categoryId: query.category || undefined,
        showTrashed: query.trashed === "true",
        sort: query.sort,
        order: query.order,
    });
    return ok(c, result);
});

// ── Product Picker Summaries ──

const getByIdsRoute = createRoute({
    method: "get",
    path: "/by-ids",
    operationId: "dashboard.products.get_by_ids",
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
    operationId: "dashboard.products.create",
    tags: ["Admin - Products"],
    summary: "Create a product",
    description: "Create the complete product atomically. Discover categoryId with dashboard.categories.form_options and attributeId with dashboard.attributes.list_summaries. Media must first be committed through dashboard.media.upload_initiate, upload_part, and upload_complete. Product-media IDs (pmed_*) are caller-local association IDs; option/value/variant draft IDs only correlate this request. Each variant selectedOptionValueIds must follow option order, and variant imageId references a pmed_* association rather than a media_* asset.",
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
        await invalidateCatalogCaches("products", c);
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
    operationId: "dashboard.products.bulk_delete",
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
    const result = await ProductsAdmin.bulkDeleteProducts(db, data.products, data.permanent);
    const deletedIds = result.outcomes
        .filter((outcome) => outcome.status === "deleted")
        .map((outcome) => outcome.id);
    if (!data.permanent || deletedIds.length > 0) {
        await invalidateCatalogCaches("products", c);
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

// ── Bounded Product Sections ──

const getProductSectionRoute = createRoute({
    method: "get",
    path: "/{id}/sections/{section}",
    operationId: "dashboard.products.get_section",
    tags: ["Admin - Products"],
    summary: "Read one bounded semantic section of a product",
    request: {
        params: z.object({
            id: z.string(),
            section: productSemanticSectionSchema,
        }),
        query: productSemanticSectionQuerySchema,
    },
    responses: {
        200: {
            description: "Bounded product section",
            content: {
                "application/json": {
                    schema: successEnvelope(productSemanticSectionResponseSchema),
                },
            },
        },
        ...errorResponses,
    },
});

app.openapi(getProductSectionRoute, async (c) => {
    const db = c.get("db");
    const { id, section } = c.req.valid("param");
    const result = await getProductSemanticSection(
        db,
        id,
        section,
        c.req.valid("query"),
    );
    if (!result) throw new NotFoundError("Product not found");
    return ok(c, result);
});

const writableProductSectionSchema = z.enum([
    "base",
    "text",
    "media",
    "attributes",
    "additional_info",
    "additional_info_text",
]);

const updateProductSectionRoute = createRoute({
    method: "patch",
    path: "/{id}/sections/{section}",
    operationId: "dashboard.products.update_section",
    tags: ["Admin - Products"],
    summary: "Update one semantic section with product revision control",
    request: {
        params: z.object({
            id: z.string(),
            section: writableProductSectionSchema,
        }),
        body: {
            content: {
                "application/json": { schema: productSemanticSectionPatchSchema },
            },
        },
    },
    responses: {
        200: {
            description: "Product section updated",
            content: {
                "application/json": {
                    schema: successEnvelope(aggregateRevisionResponseSchema),
                },
            },
        },
        ...conflictMutationErrorResponses,
    },
});

app.openapi(updateProductSectionRoute, async (c) => {
    const db = c.get("db");
    const { id, section } = c.req.valid("param");
    const patch = c.req.valid("json");
    if (patch.section !== section) {
        throw new ValidationError("Body section must match the section path parameter.");
    }
    try {
        const result = await updateProductSemanticSection(db, id, patch);
        if (!result) throw new NotFoundError("Product not found");
        await invalidateCatalogCaches("products", c);
        return ok(c, result);
    } catch (error: unknown) {
        if (error instanceof Error) {
            if (error.message === "Product not found") throw new NotFoundError(error.message);
            if (error.message.includes("slug")) throw new ValidationError(error.message);
        }
        throw error;
    }
});

// ── Get Product By ID ──

const getByIdRoute = createRoute({
    method: "get",
    path: "/{id}",
    operationId: "dashboard.products.get",
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
    operationId: "dashboard.products.update",
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
        const result = await ProductsAdmin.updateProduct(db, id, data);
        await invalidateCatalogCaches("products", c);
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
    operationId: "dashboard.products.trash",
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
    const result = await ProductsAdmin.deleteProduct(db, id, expectedAggregateRevision);
    await invalidateCatalogCaches("products", c);
    return ok(c, result);
});

// ── Restore Product ──

const restoreProductRoute = createRoute({
    method: "post",
    path: "/{id}/restore",
    operationId: "dashboard.products.restore",
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
    const result = await ProductsAdmin.restoreProduct(db, id, expectedAggregateRevision);
    await invalidateCatalogCaches("products", c);
    return ok(c, result);
});

// ── Permanent Delete Product ──

const permanentDeleteRoute = createRoute({
    method: "delete",
    path: "/{id}/permanent",
    operationId: "dashboard.products.delete_permanently",
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
    await ProductsAdmin.permanentlyDeleteProduct(db, id, expectedAggregateRevision);
    await invalidateCatalogCaches("products", c);
    return noContent(c);
});

// ── Create Variant ──

const createVariantRoute = createRoute({
    method: "post",
    path: "/{id}/variants",
    operationId: "dashboard.product_variants.create",
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
        await invalidateProductCatalogCaches(c);
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
    operationId: "dashboard.product_variants.list",
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
    operationId: "dashboard.product_variants.update",
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
        await invalidateProductCatalogCaches(c);
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
    operationId: "dashboard.product_variants.retire",
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
        await invalidateProductCatalogCaches(c);
        return ok(c, result);
    } catch (error: unknown) {
        if (error instanceof Error && error.message === "Variant not found") throw new NotFoundError(error.message);
        throw error;
    }
});

const saveOptionMatrixRoute = createRoute({
    method: "put",
    path: "/{id}/options/matrix",
    operationId: "dashboard.product_options.save_matrix",
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
    await invalidateProductCatalogCaches(c);
    return ok(c, result);
});

export { app as adminProductsRoutes };
