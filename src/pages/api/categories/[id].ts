import type { APIRoute } from "astro";
import { db } from "../../../db";
import { categories, products } from "../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { triggerReindex, deleteFromIndex } from "@/lib/search/index";

const updateCategorySchema = z.object({
  name: z
    .string()
    .min(3, "Category name must be at least 3 characters")
    .max(100, "Category name must be less than 100 characters"),
  description: z.string().nullable(),
  slug: z
    .string()
    .min(3, "Slug must be at least 3 characters")
    .max(100, "Slug must be less than 100 characters")
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid slug format"),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  image: z
    .object({
      id: z.string(),
      url: z.string(),
      filename: z.string(),
      size: z.number(),
      createdAt: z
        .date()
        .or(z.string())
        .transform((val) => (val instanceof Date ? val : new Date(val))),
    })
    .nullable(),
});

export const PUT: APIRoute = async ({ request, params }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(
        JSON.stringify({
          error: "Category ID is required",
        }),
        { status: 400 },
      );
    }

    const json = await request.json();
    const data = updateCategorySchema.parse(json);

    // Check if category exists
    const existingCategory = await db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.id, id))
      .get();

    if (!existingCategory) {
      return new Response(
        JSON.stringify({
          error: "Category not found",
        }),
        { status: 404 },
      );
    }

    // Check if slug is unique (excluding current category and soft-deleted categories)
    const existingSlug = await db
      .select({ id: categories.id })
      .from(categories)
      .where(
        sql`${categories.slug} = ${data.slug} AND ${categories.deletedAt} IS NULL`,
      )
      .get();

    if (existingSlug && existingSlug.id !== id) {
      return new Response(
        JSON.stringify({
          error: "A category with this slug already exists",
        }),
        { status: 400 },
      );
    }

    // Update category
    await db
      .update(categories)
      .set({
        name: data.name,
        description: data.description,
        slug: data.slug,
        imageUrl: data.image?.url || null,
        metaTitle: data.metaTitle,
        metaDescription: data.metaDescription,
        updatedAt: sql`unixepoch()`,
      })
      .where(eq(categories.id, id));

    // Trigger reindexing in the background
    // We don't await this to avoid delaying the response
    triggerReindex().catch((error) => {
      console.error(
        "Background reindexing failed after category update:",
        error,
      );
    });

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Error updating category:", error);

    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({
          error: "Invalid category data",
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
    const { id } = params;
    if (!id) {
      return new Response(
        JSON.stringify({
          error: "Category ID is required",
        }),
        { status: 400 },
      );
    }

    // Check if any products (active or soft-deleted) reference this category
    const referencedProducts = await db
      .select({
        id: products.id,
        name: products.name,
      })
      .from(products)
      .where(eq(products.categoryId, id))
      .limit(5) // Limit to avoid huge responses
      .all();

    if (referencedProducts.length > 0) {
      const productCount = referencedProducts.length;

      return new Response(
        JSON.stringify({
          error: `Cannot delete category because ${productCount} product${productCount === 1 ? "" : "s"} ${productCount === 1 ? "is" : "are"} still assigned to it.`,
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

    // Soft delete the category
    await db
      .update(categories)
      .set({
        deletedAt: sql`unixepoch()`,
      })
      .where(eq(categories.id, id));

    // Delete from search index directly instead of full reindexing
    // This is more efficient for single item deletions
    deleteFromIndex({ categoryIds: [id] }).catch((error) => {
      console.error("Error deleting category from search index:", error);
      // Fall back to full reindexing if direct deletion fails
      triggerReindex().catch((reindexError) => {
        console.error(
          "Background reindexing failed after category deletion:",
          reindexError,
        );
      });
    });

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error deleting category:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 },
    );
  }
};
