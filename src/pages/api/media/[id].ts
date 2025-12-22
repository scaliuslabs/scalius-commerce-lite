import type { APIRoute } from "astro";
import { db } from "../../../db";
import { media } from "../../../db/schema";
import { deleteFile } from "../../../lib/storage";
import { eq } from "drizzle-orm";

export const PATCH: APIRoute = async ({ params, request }) => {
  try {
    const { id } = params;
    const body = await request.json();

    // Get the file from database
    const [file] = await db
      .select()
      .from(media)
      .where(eq(media.id, id as string));

    if (!file) {
      return new Response(
        JSON.stringify({
          error: "File not found",
        }),
        { status: 404 }
      );
    }

    // Update file metadata
    const updates: any = { updatedAt: new Date() };
    
    if (body.filename !== undefined) {
      updates.filename = body.filename;
    }
    
    if (body.folderId !== undefined) {
      updates.folderId = body.folderId || null;
    }

    const [updatedFile] = await db
      .update(media)
      .set(updates)
      .where(eq(media.id, id as string))
      .returning();

    return new Response(
      JSON.stringify({
        file: updatedFile,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error("Error updating file:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to update file",
      }),
      { status: 500 }
    );
  }
};

export const DELETE: APIRoute = async ({ params }) => {
  try {
    const { id } = params;

    // Get the file from database
    const [file] = await db
      .select()
      .from(media)
      .where(eq(media.id, id as string));

    if (!file) {
      return new Response(
        JSON.stringify({
          error: "File not found",
        }),
        { status: 404 }
      );
    }

    // Delete from R2
    const key = file.url.split("/").pop()!;
    await deleteFile(key);

    // Delete from database
    await db.delete(media).where(eq(media.id, id as string));

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error deleting file:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to delete file",
      }),
      { status: 500 }
    );
  }
}; 