import type { APIRoute } from "astro";
import { db } from "../../../../db";
import { mediaFolders } from "../../../../db/schema";
import { desc, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";

// GET - List all folders
export const GET: APIRoute = async () => {
  try {
    const folders = await db
      .select()
      .from(mediaFolders)
      .where(isNull(mediaFolders.deletedAt))
      .orderBy(desc(mediaFolders.createdAt));

    return new Response(
      JSON.stringify({
        folders,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    console.error("Error fetching folders:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 },
    );
  }
};

// POST - Create a new folder
export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const { name, parentId } = body;

    if (!name || typeof name !== "string") {
      return new Response(
        JSON.stringify({
          error: "Folder name is required",
        }),
        { status: 400 },
      );
    }

    const now = new Date();

    const [folder] = await db
      .insert(mediaFolders)
      .values({
        id: "folder_" + nanoid(),
        name,
        parentId: parentId || null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return new Response(
      JSON.stringify({
        folder,
      }),
      {
        status: 201,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    console.error("Error creating folder:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to create folder",
      }),
      { status: 500 },
    );
  }
};

