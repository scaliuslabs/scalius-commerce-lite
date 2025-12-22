import type { APIRoute } from "astro";
import { db } from "../../../../db";
import { pages } from "../../../../db/schema";
import { eq } from "drizzle-orm";

export const POST: APIRoute = async ({ params }) => {
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

    // Check if page exists and is deleted
    const page = await db.select().from(pages).where(eq(pages.id, id)).get();

    if (!page) {
      return new Response(
        JSON.stringify({
          error: "Page not found",
        }),
        { status: 404 },
      );
    }

    if (!page.deletedAt) {
      return new Response(
        JSON.stringify({
          error: "Page is not deleted",
        }),
        { status: 400 },
      );
    }

    // Restore page
    await db
      .update(pages)
      .set({
        deletedAt: null,
      })
      .where(eq(pages.id, id));

    // Get the updated page with formatted dates
    const updatedPage = await db
      .select()
      .from(pages)
      .where(eq(pages.id, id))
      .get();

    if (updatedPage) {
      const formattedPage = {
        ...updatedPage,
        createdAt: updatedPage.createdAt
          ? new Date(Number(updatedPage.createdAt) * 1000).toISOString()
          : null,
        updatedAt: updatedPage.updatedAt
          ? new Date(Number(updatedPage.updatedAt) * 1000).toISOString()
          : null,
        deletedAt: null,
        publishedAt: updatedPage.publishedAt
          ? new Date(Number(updatedPage.publishedAt) * 1000).toISOString()
          : null,
      };

      return new Response(
        JSON.stringify({ success: true, page: formattedPage }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error restoring page:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 },
    );
  }
};
