// src/pages/api/products/bulk-delete.ts
import type { APIRoute } from "astro";
import { db } from "../../../db";
import { products, orderItems, discountProducts, productVariants, productImages } from "../../../db/schema";
import { sql, inArray } from "drizzle-orm";
import { z } from "zod";
import { triggerReindex, deleteFromIndex } from "@/lib/search/index";

const bulkDeleteSchema = z.object({
  productIds: z.array(z.string()),
  permanent: z.boolean().default(false),
});

export const POST: APIRoute = async ({ request }) => {
  try {
    const json = await request.json();
    const data = bulkDeleteSchema.parse(json);
    const { productIds, permanent } = data;

    if (productIds.length === 0) {
      return new Response(
        JSON.stringify({ error: "No product IDs provided" }),
        { status: 400 },
      );
    }

    if (permanent) {
      // Pre-deletion checks for permanent deletion
      const [orderCheck] = await db
        .select({ count: sql<number>`count(*)` })
        .from(orderItems)
        .where(inArray(orderItems.productId, productIds));

      if (orderCheck.count > 0) {
        return new Response(
          JSON.stringify({
            error: "Cannot delete products. One or more products are part of existing orders.",
          }),
          { status: 409 },
        );
      }

      const [discountCheck] = await db
        .select({ count: sql<number>`count(*)` })
        .from(discountProducts)
        .where(inArray(discountProducts.productId, productIds));
        
      if (discountCheck.count > 0) {
        return new Response(
          JSON.stringify({
            error: "Cannot delete products. One or more products are linked to discounts.",
          }),
          { status: 409 },
        );
      }

      // If checks pass, proceed with permanent deletion in a transaction
      await db.transaction(async (tx) => {
        await tx.delete(productVariants).where(inArray(productVariants.productId, productIds));
        await tx.delete(productImages).where(inArray(productImages.productId, productIds));
        await tx.delete(products).where(inArray(products.id, productIds));
      });

    } else {
      // Soft delete products
      await db
        .update(products)
        .set({ deletedAt: sql`unixepoch()` })
        .where(inArray(products.id, productIds));
    }

    deleteFromIndex({ productIds }).catch((error) => {
      console.error("Error deleting products from search index:", error);
      triggerReindex().catch((reindexError) => {
        console.error(
          "Background reindexing failed after bulk product deletion:",
          reindexError,
        );
      });
    });

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error bulk deleting products:", error);

    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({ error: "Invalid request data", details: error.errors }),
        { status: 400 },
      );
    }

    return new Response(
      JSON.stringify({ error: "An unexpected internal server error occurred." }),
      { status: 500 },
    );
  }
};