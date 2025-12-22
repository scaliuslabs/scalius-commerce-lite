import type { APIRoute } from "astro";
import { db } from "../../../../db";
import { pages } from "../../../../db/schema";
import { eq } from "drizzle-orm";

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

    // Check if page exists
    const page = await db.select().from(pages).where(eq(pages.id, id)).get();

    if (!page) {
      return new Response(
        JSON.stringify({
          error: "Page not found",
        }),
        { status: 404 },
      );
    }

    // Format the page data before deletion for the response
    const formattedPage = {
      id: page.id,
      title: page.title,
      createdAt: page.createdAt
        ? new Date(Number(page.createdAt) * 1000).toISOString()
        : null,
      updatedAt: page.updatedAt
        ? new Date(Number(page.updatedAt) * 1000).toISOString()
        : null,
      deletedAt: page.deletedAt
        ? new Date(Number(page.deletedAt) * 1000).toISOString()
        : null,
    };

    // Permanently delete page
    await db.delete(pages).where(eq(pages.id, id));

    return new Response(
      JSON.stringify({
        success: true,
        message: "Page permanently deleted",
        deletedPage: formattedPage,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    console.error("Error permanently deleting page:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 },
    );
  }
};
