import type { APIRoute } from "astro";
import { db } from "../../../db";
import { categories, collections, products } from "../../../db/schema";
import { sql, inArray, eq, isNull } from "drizzle-orm";
import { z } from "zod";

const bulkDeleteSchema = z.object({
  categoryIds: z.array(z.string()),
  permanent: z.boolean().default(false),
});

export const POST: APIRoute = async ({ request }) => {
  try {
    const json = await request.json();
    const data = bulkDeleteSchema.parse(json);

    if (data.categoryIds.length === 0) {
      return new Response(
        JSON.stringify({
          error: "No category IDs provided",
        }),
        { status: 400 },
      );
    }

    // Check if ANY products (active or soft-deleted) reference these categories
    const referencedProducts = await db
      .select({
        id: products.id,
        name: products.name,
        categoryId: products.categoryId,
      })
      .from(products)
      .where(inArray(products.categoryId, data.categoryIds))
      .limit(5) // Limit to avoid huge responses
      .all();

    if (referencedProducts.length > 0) {
      const categoryCount = new Set(referencedProducts.map((p) => p.categoryId))
        .size;
      const productCount = referencedProducts.length;

      return new Response(
        JSON.stringify({
          error: `Cannot delete ${categoryCount === 1 ? "category" : "categories"} because ${productCount} product${productCount === 1 ? "" : "s"} ${productCount === 1 ? "is" : "are"} still assigned to ${categoryCount === 1 ? "it" : "them"}.`,
          suggestion:
            "Please delete the products permanently or move them to another category first.",
          affectedProducts: referencedProducts.map((p) => ({
            id: p.id,
            name: p.name,
          })),
        }),
        { status: 400 },
      );
    }

    if (data.permanent) {
      // Update collections to remove references to deleted categories from config
      // Since categoryIds are now in the config JSON, we need to update each collection individually
      const affectedCollections = await db
        .select()
        .from(collections)
        .where(isNull(collections.deletedAt))
        .all();

      for (const collection of affectedCollections) {
        try {
          const config = JSON.parse(collection.config);
          if (Array.isArray(config.categoryIds)) {
            const updatedCategoryIds = config.categoryIds.filter(
              (id: string) => !data.categoryIds.includes(id)
            );
            if (updatedCategoryIds.length !== config.categoryIds.length) {
              // Category IDs were removed, update the collection
              config.categoryIds = updatedCategoryIds;
              await db
                .update(collections)
                .set({ config: JSON.stringify(config) })
                .where(eq(collections.id, collection.id));
            }
          }
        } catch (error) {
          console.error(`Error updating collection ${collection.id}:`, error);
        }
      }

      // Permanently delete categories (now safe since no products reference them)
      await db
        .delete(categories)
        .where(inArray(categories.id, data.categoryIds));
    } else {
      // Soft delete categories
      await db
        .update(categories)
        .set({
          deletedAt: sql`unixepoch()`,
        })
        .where(inArray(categories.id, data.categoryIds));
    }


    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error bulk deleting categories:", error);

    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({
          error: "Invalid request data",
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
