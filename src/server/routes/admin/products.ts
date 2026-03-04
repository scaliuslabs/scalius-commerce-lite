import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import * as ProductsService from "@/modules/products/products.service";
import { createProductSchema, updateProductSchema } from "@/modules/products/products.validation";

const app = new Hono<{
    Variables: {
        db: any; // using any to bypass the missing type declaration issue for now
        user: any;
        session: any;
    };
    Bindings: {
        CACHE: KVNamespace;
    };
}>();

const bulkDeleteSchema = z.object({
    productIds: z.array(z.string()),
    permanent: z.boolean().default(false),
});

// GET /api/v1/admin/products
app.get("/", async (c) => {
    try {
        const query = c.req.query();
        const result = await ProductsService.getProducts({
            page: parseInt(query.page || "1"),
            limit: parseInt(query.limit || "10"),
            search: query.search || undefined,
            categoryId: query.category || undefined,
            showTrashed: query.trashed === "true",
            sort: (query.sort || "updatedAt") as any,
            order: (query.order || "desc") as "asc" | "desc",
        });
        return c.json(result);
    } catch (error: any) {
        return c.json({ error: error.message || "Internal Server Error" }, 500);
    }
});

// POST /api/v1/admin/products
app.post("/", zValidator("json", createProductSchema), async (c) => {
    try {
        const data = c.req.valid("json");
        const result = await ProductsService.createProduct(data);
        return c.json(result, 201);
    } catch (error: any) {
        if (error.message?.includes("slug")) {
            return c.json({ error: error.message }, 400);
        }
        return c.json({ error: error.message || "Internal Server Error" }, 500);
    }
});

// POST /api/v1/admin/products/bulk-delete
app.post("/bulk-delete", zValidator("json", bulkDeleteSchema), async (c) => {
    try {
        const data = c.req.valid("json");
        await ProductsService.bulkDeleteProducts(data.productIds, data.permanent);
        return new Response(null, { status: 204 });
    } catch (error: any) {
        if (error.message?.includes("delete")) {
            return c.json({ error: error.message }, 409);
        }
        return c.json({ error: error.message || "Internal Server Error" }, 500);
    }
});

// PUT /api/v1/admin/products/:id
app.put("/:id", zValidator("json", updateProductSchema), async (c) => {
    try {
        const productId = c.req.param("id");
        if (!productId) return c.json({ error: "Product ID is required" }, 400);

        const data = c.req.valid("json");
        await ProductsService.updateProduct(productId, data);
        return c.json({ success: true }, 200);
    } catch (error: any) {
        if (error.message === "Product not found") return c.json({ error: error.message }, 404);
        if (error.message?.includes("slug")) return c.json({ error: error.message }, 400);
        return c.json({ error: error.message || "Internal Server Error" }, 500);
    }
});

// DELETE /api/v1/admin/products/:id
app.delete("/:id", async (c) => {
    try {
        const productId = c.req.param("id");
        if (!productId) return c.json({ error: "Product ID is required" }, 400);

        await ProductsService.deleteProduct(productId);
        return new Response(null, { status: 204 });
    } catch (error: any) {
        return c.json({ error: error.message || "Internal Server Error" }, 500);
    }
});

import {
    createVariantSchema,
    updateVariantSchema,
    bulkCreateVariantsSchema,
    bulkDeleteVariantsSchema,
    bulkUpdateVariantsSchema,
    updateSortOrderSchema,
} from "@/modules/products/products.service";

// POST /api/v1/admin/products/:id/variants
app.post("/:id/variants", zValidator("json", createVariantSchema), async (c) => {
    try {
        const productId = c.req.param("id");
        if (!productId) return c.json({ error: "Product ID is required" }, 400);

        const data = c.req.valid("json");
        const result = await ProductsService.createVariant(productId, data);
        return c.json(result, 201);
    } catch (error: any) {
        if (error.message?.includes("SKU")) return c.json({ error: error.message }, 400);
        return c.json({ error: error.message || "Internal Server Error" }, 500);
    }
});

// GET /api/v1/admin/products/:id/variants
app.get("/:id/variants", async (c) => {
    try {
        const productId = c.req.param("id");
        if (!productId) return c.json({ error: "Product ID is required" }, 400);

        const variants = await ProductsService.getProductVariants(productId);
        return c.json({ variants }, 200);
    } catch (error: any) {
        return c.json({ error: error.message || "Internal Server Error" }, 500);
    }
});

// PUT /api/v1/admin/products/:id/variants/:variantId
app.put("/:id/variants/:variantId", zValidator("json", updateVariantSchema), async (c) => {
    try {
        const productId = c.req.param("id");
        const variantId = c.req.param("variantId");
        if (!productId || !variantId) return c.json({ error: "Product ID and Variant ID are required" }, 400);

        const data = c.req.valid("json");
        const result = await ProductsService.updateVariant(productId, variantId, data);
        return c.json(result, 200);
    } catch (error: any) {
        if (error.message === "Variant not found") return c.json({ error: error.message }, 404);
        if (error.message?.includes("SKU")) return c.json({ error: error.message }, 400);
        return c.json({ error: error.message || "Internal Server Error" }, 500);
    }
});

// DELETE /api/v1/admin/products/:id/variants/:variantId
app.delete("/:id/variants/:variantId", async (c) => {
    try {
        const productId = c.req.param("id");
        const variantId = c.req.param("variantId");
        if (!productId || !variantId) return c.json({ error: "Product ID and Variant ID are required" }, 400);

        await ProductsService.deleteVariant(productId, variantId);
        return new Response(null, { status: 204 });
    } catch (error: any) {
        if (error.message === "Variant not found") return c.json({ error: error.message }, 404);
        return c.json({ error: error.message || "Internal Server Error" }, 500);
    }
});

// POST /api/v1/admin/products/:id/variants/bulk-create
app.post("/:id/variants/bulk-create", zValidator("json", bulkCreateVariantsSchema), async (c) => {
    try {
        const productId = c.req.param("id");
        if (!productId) return c.json({ error: "Product ID is required" }, 400);

        const data = c.req.valid("json");
        const variants = await ProductsService.bulkCreateVariants(productId, data.variants);
        return c.json({ success: true, variants, count: variants.length }, 201);
    } catch (error: any) {
        if (error.message?.includes("SKU")) return c.json({ error: error.message }, 400);
        return c.json({ error: error.message || "Internal Server Error" }, 500);
    }
});

// POST /api/v1/admin/products/:id/variants/bulk-delete
app.post("/:id/variants/bulk-delete", zValidator("json", bulkDeleteVariantsSchema), async (c) => {
    try {
        const productId = c.req.param("id");
        if (!productId) return c.json({ error: "Product ID is required" }, 400);

        const data = c.req.valid("json");
        await ProductsService.bulkDeleteVariants(productId, data.variantIds);
        return new Response(null, { status: 204 });
    } catch (error: any) {
        return c.json({ error: error.message || "Internal Server Error" }, 500);
    }
});

// POST /api/v1/admin/products/:id/variants/bulk-update
app.post("/:id/variants/bulk-update", zValidator("json", bulkUpdateVariantsSchema), async (c) => {
    try {
        const productId = c.req.param("id");
        if (!productId) return c.json({ error: "Product ID is required" }, 400);

        const data = c.req.valid("json");
        if (data.updates.length === 0) return c.json({ error: "No updates provided" }, 400);

        await ProductsService.bulkUpdateVariants(productId, data.updates);
        return c.json({ success: true }, 200);
    } catch (error: any) {
        return c.json({ error: error.message || "Internal Server Error" }, 500);
    }
});

// POST /api/v1/admin/products/:id/variants/:variantId/duplicate
app.post("/:id/variants/:variantId/duplicate", async (c) => {
    try {
        const productId = c.req.param("id");
        const variantId = c.req.param("variantId");
        if (!productId || !variantId) return c.json({ error: "Product ID and Variant ID are required" }, 400);

        const variant = await ProductsService.duplicateVariant(productId, variantId);
        return c.json(variant, 201);
    } catch (error: any) {
        if (error.message === "Variant not found") return c.json({ error: error.message }, 404);
        return c.json({ error: error.message || "Internal Server Error" }, 500);
    }
});

// GET /api/v1/admin/products/:id/variants/sort-order
app.get("/:id/variants/sort-order", async (c) => {
    try {
        const productId = c.req.param("id");
        if (!productId) return c.json({ error: "Product ID is required" }, 400);

        const result = await ProductsService.getVariantSortOrder(productId);
        return c.json(result, 200);
    } catch (error: any) {
        return c.json({ error: error.message || "Internal Server Error" }, 500);
    }
});

// POST /api/v1/admin/products/:id/variants/sort-order
app.post("/:id/variants/sort-order", zValidator("json", updateSortOrderSchema), async (c) => {
    try {
        const productId = c.req.param("id");
        if (!productId) return c.json({ error: "Product ID is required" }, 400);

        const data = c.req.valid("json");
        await ProductsService.updateVariantSortOrder(productId, data);
        return c.json({ success: true, message: "Sort order updated successfully" }, 200);
    } catch (error: any) {
        return c.json({ error: error.message || "Internal Server Error" }, 500);
    }
});

export { app as adminProductsRoutes };
