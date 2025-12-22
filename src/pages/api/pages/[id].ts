import type { APIRoute } from "astro";
import { db } from "../../../db";
import { pages } from "../../../db/schema";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { triggerReindex, deleteFromIndex } from "@/lib/search/index";

const updatePageSchema = z.object({
  id: z.string(),
  title: z.string().min(3).max(100),
  slug: z
    .string()
    .min(3)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  content: z.string(),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  isPublished: z.boolean(),
  publishedAt: z
    .date()
    .or(z.string())
    .nullable()
    .optional()
    .transform((val) =>
      val instanceof Date ? val : val ? new Date(val) : null,
    ),
  sortOrder: z.number(),
  hideHeader: z.boolean(),
  hideFooter: z.boolean(),
  hideTitle: z.boolean(),
});

export const GET: APIRoute = async ({ params }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(
        JSON.stringify({
          error: "Page ID is required",
        }),
        { status: 400 },
      );
    }

    const page = await db.select().from(pages).where(eq(pages.id, id)).get();

    if (!page) {
      return new Response(
        JSON.stringify({
          error: "Page not found",
        }),
        { status: 404 },
      );
    }

    // Return page as-is with Unix timestamps
    // Frontend will handle conversion with unixToDate utility
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Error fetching page:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 },
    );
  }
};

export const PUT: APIRoute = async ({ request, params }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(
        JSON.stringify({
          error: "Page ID is required",
        }),
        { status: 400 },
      );
    }

    const json = await request.json();
    const data = updatePageSchema.parse(json);

    // Check if page exists
    const existingPage = await db
      .select({ id: pages.id })
      .from(pages)
      .where(eq(pages.id, id))
      .get();

    if (!existingPage) {
      return new Response(
        JSON.stringify({
          error: "Page not found",
        }),
        { status: 404 },
      );
    }

    // Check if slug is unique (excluding current page)
    const existingSlug = await db
      .select({ id: pages.id })
      .from(pages)
      .where(
        sql`${pages.slug} = ${data.slug} AND ${pages.id} != ${id} AND ${pages.deletedAt} IS NULL`,
      )
      .get();

    if (existingSlug) {
      return new Response(
        JSON.stringify({
          error: "A page with this slug already exists",
        }),
        { status: 400 },
      );
    }

    // Determine publishedAt value
    let publishedAt = null;
    if (data.isPublished) {
      publishedAt = data.publishedAt
        ? Math.floor(data.publishedAt.getTime() / 1000)
        : Math.floor(Date.now() / 1000);
    }

    // Update page
    await db
      .update(pages)
      .set({
        title: data.title,
        content: data.content,
        slug: data.slug,
        metaTitle: data.metaTitle,
        metaDescription: data.metaDescription,
        isPublished: data.isPublished,
        hideHeader: data.hideHeader,
        hideFooter: data.hideFooter,
        hideTitle: data.hideTitle,
        publishedAt: publishedAt ? sql`${publishedAt}` : null,
        sortOrder: data.sortOrder,
        updatedAt: sql`unixepoch()`,
      })
      .where(eq(pages.id, id));

    // Trigger reindexing in the background
    // We don't await this to avoid delaying the response
    triggerReindex().catch((error) => {
      console.error("Background reindexing failed after page update:", error);
    });

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Error updating page:", error);

    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({
          error: "Invalid page data",
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
          error: "Page ID is required",
        }),
        { status: 400 },
      );
    }

    // Soft delete the page
    await db
      .update(pages)
      .set({
        deletedAt: sql`unixepoch()`,
      })
      .where(eq(pages.id, id));

    // Delete from search index directly instead of full reindexing
    // This is more efficient for single item deletions
    deleteFromIndex({ pageIds: [id] }).catch((error) => {
      console.error("Error deleting page from search index:", error);
      // Fall back to full reindexing if direct deletion fails
      triggerReindex().catch((reindexError) => {
        console.error(
          "Background reindexing failed after page deletion:",
          reindexError,
        );
      });
    });

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error deleting page:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 },
    );
  }
};
