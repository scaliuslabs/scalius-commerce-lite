// src/pages/api/admin/settings/meta-conversions/logs.ts
import type { APIRoute } from "astro";
import { db } from "@/db";
import { metaConversionsLogs } from "@/db/schema";
import { desc, count } from "drizzle-orm";
import {
  getLogRetentionHours,
  getCleanupCheckIntervalHours,
  manualLogCleanup,
} from "@/lib/meta/conversions-api";

// GET: Fetch Meta Conversions logs with pagination
export const GET: APIRoute = async ({ url }) => {
  try {
    const searchParams = url.searchParams;
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "20");
    const offset = (page - 1) * limit;

    // Get total count
    const totalResult = await db
      .select({ count: count(metaConversionsLogs.id) })
      .from(metaConversionsLogs)
      .get();

    const total = totalResult?.count ?? 0;

    // Get paginated logs
    const logs = await db
      .select()
      .from(metaConversionsLogs)
      .orderBy(desc(metaConversionsLogs.createdAt))
      .limit(limit)
      .offset(offset)
      .all();

    // Get retention information
    const retentionHours = getLogRetentionHours();
    const cleanupIntervalHours = getCleanupCheckIntervalHours();

    return new Response(
      JSON.stringify({
        data: logs,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
        retention: {
          hours: retentionHours,
          cleanupIntervalHours,
          nextCleanupMessage: `Logs older than ${retentionHours} hours are automatically cleaned up every ${cleanupIntervalHours} hours.`,
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Error fetching Meta Conversions logs:", error);
    return new Response(
      JSON.stringify({ error: "Failed to fetch Meta Conversions logs" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};

// DELETE: Clear all Meta Conversions logs
export const DELETE: APIRoute = async () => {
  try {
    await db.delete(metaConversionsLogs);

    return new Response(
      JSON.stringify({ message: "All logs cleared successfully" }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Error clearing Meta Conversions logs:", error);
    return new Response(
      JSON.stringify({ error: "Failed to clear Meta Conversions logs" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};

// POST: Manual cleanup of old logs
export const POST: APIRoute = async () => {
  try {
    const result = await manualLogCleanup();

    if (result.success) {
      return new Response(JSON.stringify({ message: result.message }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } else {
      return new Response(JSON.stringify({ error: result.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  } catch (error) {
    console.error("Error during manual log cleanup:", error);
    return new Response(
      JSON.stringify({ error: "Manual log cleanup failed" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};
