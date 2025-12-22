import type { APIRoute } from "astro";
import { db } from "../../../../../db";
import { productVariants } from "../../../../../db/schema";
import { sql, eq, and, isNull } from "drizzle-orm";
import { z } from "zod";

const sortItemSchema = z.object({
  value: z.string(),
  sortOrder: z.number(),
});

const updateSortOrderSchema = z.object({
  colors: z.array(sortItemSchema),
  sizes: z.array(sortItemSchema),
});

export const GET: APIRoute = async ({ params }) => {
  try {
    const { id: productId } = params;
    if (!productId) {
      return new Response(
        JSON.stringify({
          error: "Product ID is required",
        }),
        { status: 400 }
      );
    }

    // Get all non-deleted variants for the product
    const variants = await db
      .select({
        color: productVariants.color,
        size: productVariants.size,
        colorSortOrder: productVariants.colorSortOrder,
        sizeSortOrder: productVariants.sizeSortOrder,
      })
      .from(productVariants)
      .where(
        and(
          eq(productVariants.productId, productId),
          isNull(productVariants.deletedAt)
        )
      );

    // Extract unique colors with their sort orders
    const colorMap = new Map<string, number>();
    const sizeMap = new Map<string, number>();

    variants.forEach((variant) => {
      if (variant.color && !colorMap.has(variant.color)) {
        colorMap.set(variant.color, variant.colorSortOrder || 0);
      }
      if (variant.size && !sizeMap.has(variant.size)) {
        sizeMap.set(variant.size, variant.sizeSortOrder || 0);
      }
    });

    // Convert to sorted arrays
    const colors = Array.from(colorMap.entries())
      .map(([value, sortOrder]) => ({ value, sortOrder }))
      .sort((a, b) => a.sortOrder - b.sortOrder);

    const sizes = Array.from(sizeMap.entries())
      .map(([value, sortOrder]) => ({ value, sortOrder }))
      .sort((a, b) => a.sortOrder - b.sortOrder);

    return new Response(
      JSON.stringify({
        colors,
        sizes,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error("Error getting variant sort order:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 }
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
        { status: 400 }
      );
    }

    const json = await request.json();
    const data = updateSortOrderSchema.parse(json);

    // Update color sort orders
    for (const color of data.colors) {
      await db
        .update(productVariants)
        .set({
          colorSortOrder: color.sortOrder,
          updatedAt: sql`unixepoch()`,
        })
        .where(
          and(
            eq(productVariants.productId, productId),
            eq(productVariants.color, color.value),
            isNull(productVariants.deletedAt)
          )
        );
    }

    // Update size sort orders
    for (const size of data.sizes) {
      await db
        .update(productVariants)
        .set({
          sizeSortOrder: size.sortOrder,
          updatedAt: sql`unixepoch()`,
        })
        .where(
          and(
            eq(productVariants.productId, productId),
            eq(productVariants.size, size.value),
            isNull(productVariants.deletedAt)
          )
        );
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: "Sort order updated successfully",
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error("Error updating variant sort order:", error);

    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({
          error: "Invalid sort order data",
          details: error.errors,
        }),
        { status: 400 }
      );
    }

    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 }
    );
  }
};
