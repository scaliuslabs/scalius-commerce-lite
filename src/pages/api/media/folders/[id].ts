import type { APIRoute } from "astro";
import { db } from "../../../../db";
import { media, mediaFolders } from "../../../../db/schema";
import { eq } from "drizzle-orm";

// DELETE - Delete a folder and move its files to root
export const DELETE: APIRoute = async ({ params }) => {
  try {
    const { id } = params;

    if (!id) {
      return new Response(
        JSON.stringify({
          error: "Folder ID is required",
        }),
        { status: 400 },
      );
    }

    // Move all files in this folder to root (null folder)
    await db
      .update(media)
      .set({ folderId: null, updatedAt: new Date() })
      .where(eq(media.folderId, id as string));

    // Soft delete the folder
    await db
      .update(mediaFolders)
      .set({ deletedAt: new Date() })
      .where(eq(mediaFolders.id, id as string));

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error deleting folder:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to delete folder",
      }),
      { status: 500 },
    );
  }
};
