// src/pages/api/products/[id]/permanent.ts
import type { APIRoute } from "astro";
import { db } from "../../../../db";
import {
  products,
  productVariants,
  productImages,
  orderItems,
  discountProducts,
} from "../../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { deleteFromIndex, triggerReindex } from "@/lib/search/index";

export const DELETE: APIRoute = async ({ params }) => {
  const { id } = params;
  if (!id) {
    return new Response(JSON.stringify({ error: "Product ID is required" }), {
      status: 400,
    });
  }

  try {
    // Pre-deletion check: Is the product in any orders?
    const [orderCheck] = await db
      .select({ count: sql<number>`count(*)` })
      .from(orderItems)
      .where(eq(orderItems.productId, id));

    if (orderCheck.count > 0) {
      return new Response(
        JSON.stringify({
          error: "Cannot delete product. It is part of one or more existing orders.",
        }),
        { status: 409 }, // 409 Conflict is more appropriate here
      );
    }

    // Pre-deletion check: Is the product linked to any discounts?
    const [discountCheck] = await db
      .select({ count: sql<number>`count(*)` })
      .from(discountProducts)
      .where(eq(discountProducts.productId, id));
      
    if (discountCheck.count > 0) {
      return new Response(
        JSON.stringify({
          error: "Cannot delete product. It is linked to one or more discounts.",
        }),
        { status: 409 },
      );
    }

    // If checks pass, proceed with deletion
    await db.transaction(async (tx) => {
      await tx.delete(productVariants).where(eq(productVariants.productId, id));
      await tx.delete(productImages).where(eq(productImages.productId, id));
      await tx.delete(products).where(eq(products.id, id));
    });

    deleteFromIndex({ productIds: [id] }).catch((error) => {
      console.error(
        "Error deleting product from search index during permanent delete:",
        error,
      );
      triggerReindex().catch((reindexError) => {
        console.error(
          "Background reindexing failed after permanent product deletion:",
          reindexError,
        );
      });
    });

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error permanently deleting product:", error);
    return new Response(
      JSON.stringify({
        error: "An unexpected internal server error occurred.",
      }),
      { status: 500 },
    );
  }
};