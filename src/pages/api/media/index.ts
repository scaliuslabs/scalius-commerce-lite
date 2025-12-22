import type { APIRoute } from "astro";
import { db } from "../../../db";
import { media } from "../../../db/schema";
import { desc, isNull, sql, like } from "drizzle-orm";

export const GET: APIRoute = async ({ request }) => {
  try {
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get("page") || "1");
    const limit = parseInt(url.searchParams.get("limit") || "10");
    const offset = (page - 1) * limit;
    const searchQuery = url.searchParams.get("search") || "";
    const folderId = url.searchParams.get("folderId");

    const conditions = [isNull(media.deletedAt)];
    if (searchQuery) {
      conditions.push(like(media.filename, `%${searchQuery}%`));
    }

    // Filter by folder
    // If folderId is "all" or undefined, show ALL files from all folders
    // If folderId is "root" or empty string, show only root files (folderId = null)
    // Otherwise, show files in specific folder
    if (folderId !== undefined && folderId !== "all") {
      if (folderId === "" || folderId === "root" || folderId === "null") {
        conditions.push(isNull(media.folderId));
      } else {
        conditions.push(sql`${media.folderId} = ${folderId}`);
      }
    }

    // Get total count
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(media)
      .where(sql.join(conditions, sql` AND `));

    // Get paginated results
    const files = await db
      .select()
      .from(media)
      .where(sql.join(conditions, sql` AND `))
      .orderBy(desc(media.createdAt))
      .limit(limit)
      .offset(offset);

    return new Response(
      JSON.stringify({
        files,
        pagination: {
          total: count,
          page,
          limit,
          totalPages: Math.ceil(count / limit),
        },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    console.error("Error fetching media:", error);
    return new Response(
      JSON.stringify({
        error: "Internal server error",
      }),
      { status: 500 },
    );
  }
};
