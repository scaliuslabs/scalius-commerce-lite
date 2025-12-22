import type { APIRoute } from "astro";
import { db } from "../../../../../db";
import { productVariants } from "../../../../../db/schema";
import { sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";

const createVariantSchema = z.object({
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

export const GET: APIRoute = async ({ params }) => {
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

    // Get all non-deleted variants for the product
    const variants = await db
      .select({
        id: productVariants.id,
        size: productVariants.size,
        color: productVariants.color,
        weight: productVariants.weight,
        sku: productVariants.sku,
        price: productVariants.price,
        stock: productVariants.stock,
        discountType: productVariants.discountType,
        discountPercentage: productVariants.discountPercentage,
        discountAmount: productVariants.discountAmount,
        colorSortOrder: productVariants.colorSortOrder,
        sizeSortOrder: productVariants.sizeSortOrder,
        createdAt: sql<string>`datetime(${productVariants.createdAt}, 'unixepoch', 'localtime')`,
        updatedAt: sql<string>`datetime(${productVariants.updatedAt}, 'unixepoch', 'localtime')`,
      })
      .from(productVariants)
      .where(
        sql`${productVariants.productId} = ${productId} AND ${productVariants.deletedAt} IS NULL`,
      )
      .orderBy(productVariants.colorSortOrder, productVariants.sizeSortOrder, productVariants.createdAt);

    return new Response(
      JSON.stringify({
        variants: variants.map((variant) => ({
          ...variant,
          createdAt: new Date(variant.createdAt),
          updatedAt: new Date(variant.updatedAt),
        })),
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    console.error("Error getting variants:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 },
    );
  }
};

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
    const data = createVariantSchema.parse(json);

    // Check if SKU is unique
    const existingVariant = await db
      .select({ id: productVariants.id })
      .from(productVariants)
      .where(
        sql`${productVariants.sku} = ${data.sku} AND ${productVariants.deletedAt} IS NULL`,
      )
      .get();

    if (existingVariant) {
      return new Response(
        JSON.stringify({
          error: "A variant with this SKU already exists",
        }),
        { status: 400 },
      );
    }

    // Create variant
    const [variant] = await db
      .insert(productVariants)
      .values({
        id: "var_" + nanoid(),
        productId,
        size: data.size,
        color: data.color,
        weight: data.weight,
        sku: data.sku,
        price: data.price,
        stock: data.stock,
        discountType: data.discountType || "percentage",
        discountPercentage: data.discountPercentage || null,
        discountAmount: data.discountAmount || null,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      })
      .returning();

    return new Response(JSON.stringify(variant), {
      status: 201,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Error creating variant:", error);

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
