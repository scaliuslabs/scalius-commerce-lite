import type { APIRoute } from "astro";
import { db } from "../../../../../db";
import { productVariants } from "../../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

const updateVariantSchema = z.object({
  size: z.string().nullable(),
  color: z.string().nullable(),
  weight: z.number().min(0).nullable(),
  sku: z.string().min(3, "SKU must be at least 3 characters"),
  price: z.number().min(0, "Price must be greater than or equal to 0"),
  stock: z.number().min(0, "Stock must be greater than or equal to 0"),
  discountType: z.enum(["percentage", "flat"]).optional(),
  discountPercentage: z.number().min(0).max(100).nullable().optional(),
  discountAmount: z.number().min(0).nullable().optional(),
});

export const PUT: APIRoute = async ({ request, params }) => {
  try {
    const { id: productId, variantId } = params;
    if (!productId || !variantId) {
      return new Response(
        JSON.stringify({
          error: "Product ID and Variant ID are required",
        }),
        { status: 400 },
      );
    }

    const json = await request.json();
    const data = updateVariantSchema.parse(json);

    // Check if variant exists
    const existingVariant = await db
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(
        sql`${productVariants.id} = ${variantId} AND ${productVariants.productId} = ${productId} AND ${productVariants.deletedAt} IS NULL`,
      )
      .get();

    if (!existingVariant) {
      return new Response(
        JSON.stringify({
          error: "Variant not found",
        }),
        { status: 404 },
      );
    }

    // Check if SKU is unique (excluding current variant)
    const existingSkuVariant = await db
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(
        sql`${productVariants.sku} = ${data.sku} AND ${productVariants.id} != ${variantId} AND ${productVariants.deletedAt} IS NULL`,
      )
      .get();

    if (existingSkuVariant) {
      return new Response(
        JSON.stringify({
          error: "A variant with this SKU already exists",
        }),
        { status: 400 },
      );
    }

    // Update variant
    const [variant] = await db
      .update(productVariants)
      .set({
        size: data.size,
        color: data.color,
        weight: data.weight,
        sku: data.sku,
        price: data.price,
        stock: data.stock,
        discountType: data.discountType || "percentage",
        discountPercentage: data.discountPercentage || null,
        discountAmount: data.discountAmount || null,
        updatedAt: sql`unixepoch()`,
      })
      .where(eq(productVariants.id, variantId))
      .returning();

    return new Response(JSON.stringify(variant), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Error updating variant:", error);

    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({
          error: "Invalid variant data",
          details: error.errors,
        }),
        { status: 400 },
      );
    }

    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 },
    );
  }
};

export const DELETE: APIRoute = async ({ params }) => {
  try {
    const { id: productId, variantId } = params;
    if (!productId || !variantId) {
      return new Response(
        JSON.stringify({
          error: "Product ID and Variant ID are required",
        }),
        { status: 400 },
      );
    }

    // Check if variant exists
    const existingVariant = await db
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(
        sql`${productVariants.id} = ${variantId} AND ${productVariants.productId} = ${productId} AND ${productVariants.deletedAt} IS NULL`,
      )
      .get();

    if (!existingVariant) {
      return new Response(
        JSON.stringify({
          error: "Variant not found",
        }),
        { status: 404 },
      );
    }

    // Permanently delete the variant
    await db.delete(productVariants).where(eq(productVariants.id, variantId));

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error deleting variant:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 },
    );
  }
};
