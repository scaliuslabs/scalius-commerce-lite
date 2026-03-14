import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import * as ProductsService from "@scalius/core/modules/products/products.service";
import { createProductSchema, updateProductSchema } from "@scalius/core/modules/products/products.validation";
import {
    createVariantSchema,
    updateVariantSchema,
    bulkCreateVariantsSchema,
    bulkDeleteVariantsSchema,
    bulkUpdateVariantsSchema,
    updateSortOrderSchema
} from "@scalius/core/modules/products/products.service";
import { NotFoundError, ConflictError, ValidationError } from "../../utils/api-error";

import { ok, created, noContent } from "../../utils/api-response";
const app = new OpenAPIHono();

const bulkDeleteSchema = z.object({
    productIds: z.array(z.string()),
    permanent: z.boolean().default(false)
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
            limit: z.coerce.number().default(10).openapi({ description: "Items per page" }),
            search: z.string().optional().openapi({ description: "Search term" }),
            category: z.string().optional().openapi({ description: "Category ID filter" }),
            trashed: z.string().optional().openapi({ description: "Show trashed items" }),
            sort: z.string().optional().default("updatedAt").openapi({ description: "Sort field" }),
            order: z.string().optional().default("desc").openapi({ description: "Sort order" })
        })
    },
    responses: {
        200: { description: "Product list with pagination"  }
    }
});

app.openapi(listRoute, async (c) => {
    const db = c.get("db");
    const query = c.req.valid("query");
    const result = await ProductsService.getProducts(db, {
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
        201: { description: "Product created"  }
    }
});

app.openapi(createProductRoute, async (c) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    try {
        const result = await ProductsService.createProduct(db, data);
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
        204: { description: "Products deleted" }
    }
});

app.openapi(bulkDeleteRoute, async (c) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    try {
        await ProductsService.bulkDeleteProducts(db, data.productIds, data.permanent);
        return noContent(c);
    } catch (error: unknown) {
        if (error instanceof Error && error.message?.includes("delete")) {
            throw new ConflictError(error.message);
        }
        throw error;
    }
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
        200: { description: "Product updated"  }
    }
});

app.openapi(updateProductRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    try {
        await ProductsService.updateProduct(db, id, data);
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
        204: { description: "Product deleted" }
    }
});

app.openapi(deleteProductRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await ProductsService.deleteProduct(db, id);
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
        200: { description: "Product restored"  }
    }
});

app.openapi(restoreProductRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await ProductsService.restoreProduct(db, id);
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
        204: { description: "Product permanently deleted" }
    }
});

app.openapi(permanentDeleteRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    try {
        await ProductsService.permanentDeleteProduct(db, id);
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
        201: { description: "Variant created"  }
    }
});

app.openapi(createVariantRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    try {
        const result = await ProductsService.createVariant(db, id, data);
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
        200: { description: "Variant list"  }
    }
});

app.openapi(listVariantsRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const variants = await ProductsService.getProductVariants(db, id);
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
        200: { description: "Variant updated"  }
    }
});

app.openapi(updateVariantRoute, async (c) => {
    const db = c.get("db");
    const { id, variantId } = c.req.valid("param");
    const data = c.req.valid("json");
    try {
        const result = await ProductsService.updateVariant(db, id, variantId, data);
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
        204: { description: "Variant deleted" }
    }
});

app.openapi(deleteVariantRoute, async (c) => {
    const db = c.get("db");
    const { id, variantId } = c.req.valid("param");
    try {
        await ProductsService.deleteVariant(db, id, variantId);
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
        201: { description: "Variants created"  }
    }
});

app.openapi(bulkCreateVariantsRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    try {
        const variants = await ProductsService.bulkCreateVariants(db, id, data.variants);
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
        204: { description: "Variants deleted" }
    }
});

app.openapi(bulkDeleteVariantsRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    await ProductsService.bulkDeleteVariants(db, id, data.variantIds);
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
        200: { description: "Variants updated"  }
    }
});

app.openapi(bulkUpdateVariantsRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    if (data.updates.length === 0) throw new ValidationError("No updates provided");
    await ProductsService.bulkUpdateVariants(db, id, data.updates);
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
        201: { description: "Variant duplicated"  }
    }
});

app.openapi(duplicateVariantRoute, async (c) => {
    const db = c.get("db");
    const { id, variantId } = c.req.valid("param");
    try {
        const variant = await ProductsService.duplicateVariant(db, id, variantId);
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
        200: { description: "Sort order data"  }
    }
});

app.openapi(getVariantSortOrderRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const result = await ProductsService.getVariantSortOrder(db, id);
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
        200: { description: "Sort order updated"  }
    }
});

app.openapi(updateVariantSortOrderRoute, async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    const data = c.req.valid("json");
    await ProductsService.updateVariantSortOrder(db, id, data);
    return ok(c, { message: "Sort order updated successfully" });
});

export { app as adminProductsRoutes };
