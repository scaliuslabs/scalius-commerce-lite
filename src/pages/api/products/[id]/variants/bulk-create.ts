import type { APIRoute } from "astro";
import { db } from "../../../../../db";
import { productVariants } from "../../../../../db/schema";
import { sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";

const bulkVariantSchema = z.object({
  size: z.string().nullable(),
  color: z.string().nullable(),
  weight: z.number().min(0).nullable(),
  sku: z.string().min(3, "SKU must be at least 3 characters"),
  price: z.number().min(0, "Price must be greater than or equal to 0"),
  stock: z.number().min(0, "Stock must be greater than or equal to 0"),
  discountType: z.enum(["percentage", "flat"]),
  discountPercentage: z.number().min(0).max(100).nullable(),
  discountAmount: z.number().min(0).nullable(),
});

const bulkCreateSchema = z.object({
  variants: z.array(bulkVariantSchema).min(1, "At least one variant is required"),
});

export const POST: APIRoute = async ({ request, params }) => {
  try {
    const { id: productId } = params;
    if (!productId) {
      return new Response(
        JSON.stringify({
          error: "Product ID is required",
        }),
        { status: 400 },
      );
    }

    const json = await request.json();
    const data = bulkCreateSchema.parse(json);

    // Check for duplicate SKUs in the request
    const skus = data.variants.map((v) => v.sku);
    const duplicateSkus = skus.filter((sku, index) => skus.indexOf(sku) !== index);

    if (duplicateSkus.length > 0) {
      return new Response(
        JSON.stringify({
          error: "Duplicate SKUs found in request",
          duplicates: duplicateSkus,
        }),
        { status: 400 },
      );
    }

    // Check if any SKUs already exist
    const existingVariants = await db
      .select({ sku: productVariants.sku })
      .from(productVariants)
      .where(
        sql`${productVariants.sku} IN ${skus} AND ${productVariants.deletedAt} IS NULL`,
      )
      .all();

    if (existingVariants.length > 0) {
      return new Response(
        JSON.stringify({
          error: "One or more SKUs already exist",
          existingSkus: existingVariants.map((v) => v.sku),
        }),
        { status: 400 },
      );
    }

    // Create all variants
    const variantsToCreate = data.variants.map((variant) => ({
      id: "var_" + nanoid(),
      productId,
      size: variant.size,
      color: variant.color,
      weight: variant.weight,
      sku: variant.sku,
      price: variant.price,
      stock: variant.stock,
      discountType: variant.discountType,
      discountPercentage: variant.discountPercentage,
      discountAmount: variant.discountAmount,
      createdAt: sql`unixepoch()`,
      updatedAt: sql`unixepoch()`,
    }));

    const createdVariants = await db
      .insert(productVariants)
      .values(variantsToCreate)
      .returning();

    return new Response(
      JSON.stringify({
        success: true,
        variants: createdVariants,
        count: createdVariants.length,
      }),
      {
        status: 201,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    console.error("Error bulk creating variants:", error);

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
