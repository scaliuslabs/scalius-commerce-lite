import type { APIRoute } from "astro";
import { db } from "../../../../../../db";
import { productVariants } from "../../../../../../db/schema";
import { sql } from "drizzle-orm";
import { nanoid } from "nanoid";

export const POST: APIRoute = async ({ params }) => {
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

    // Get the variant to duplicate
    const [existingVariant] = await db
      .select()
      .from(productVariants)
      .where(
        sql`${productVariants.id} = ${variantId} AND ${productVariants.productId} = ${productId} AND ${productVariants.deletedAt} IS NULL`,
      )
      .limit(1);

    if (!existingVariant) {
      return new Response(
        JSON.stringify({
          error: "Variant not found",
        }),
        { status: 404 },
      );
    }

    // Generate a unique SKU by appending a suffix
    let newSku = `${existingVariant.sku}-COPY`;
    let counter = 1;

    // Check if SKU exists, keep incrementing until we find a unique one
    while (true) {
      const existing = await db
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(
          sql`${productVariants.sku} = ${newSku} AND ${productVariants.deletedAt} IS NULL`,
        )
        .get();

      if (!existing) break;

      counter++;
      newSku = `${existingVariant.sku}-COPY${counter}`;
    }

    // Create duplicate variant
    const [newVariant] = await db
      .insert(productVariants)
      .values({
        id: "var_" + nanoid(),
        productId,
        size: existingVariant.size,
        color: existingVariant.color,
        weight: existingVariant.weight,
        sku: newSku,
        price: existingVariant.price,
        stock: existingVariant.stock,
        discountType: existingVariant.discountType,
        discountPercentage: existingVariant.discountPercentage,
        discountAmount: existingVariant.discountAmount,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      })
      .returning();

    return new Response(JSON.stringify(newVariant), {
      status: 201,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Error duplicating variant:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 },
    );
  }
};
