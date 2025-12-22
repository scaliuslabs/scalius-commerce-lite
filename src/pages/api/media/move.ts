import type { APIRoute } from "astro";
import { db } from "../../../db";
import { media } from "../../../db/schema";
import { inArray } from "drizzle-orm";

// POST - Move files to a folder
export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { fileIds, folderId } = body;

    if (!Array.isArray(fileIds) || fileIds.length === 0) {
      return new Response(
        JSON.stringify({
          error: "File IDs are required",
        }),
        { status: 400 },
      );
    }

    // Update files to move them to the specified folder (or null for root)
    await db
      .update(media)
      .set({ folderId: folderId || null, updatedAt: new Date() })
      .where(inArray(media.id, fileIds));

    return new Response(
      JSON.stringify({
        success: true,
        message: `Moved ${fileIds.length} file(s)`,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    console.error("Error moving files:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to move files",
      }),
      { status: 500 },
    );
  }
};
