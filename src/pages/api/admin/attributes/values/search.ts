import type { APIRoute } from "astro";
import { db } from "@/db";
import { productAttributeValues, productAttributes } from "@/db/schema";
import { sql } from "drizzle-orm";

export const GET: APIRoute = async ({ url }) => {
  try {
    const searchParams = new URL(url).searchParams;
    const query = searchParams.get("q");
    const limit = parseInt(searchParams.get("limit") || "10");

    if (!query || query.trim().length < 1) {
      return new Response(JSON.stringify({ values: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Search for all attribute values that match the query
    // Join with productAttributes to ensure we only get values from non-deleted attributes
    const results = await db
      .select({
        value: productAttributeValues.value,
      })
      .from(productAttributeValues)
      .innerJoin(
        productAttributes,
        sql`${productAttributeValues.attributeId} = ${productAttributes.id}`,
      )
      .where(
        sql`${productAttributeValues.value} LIKE ${`%${query.trim()}%`} 
        AND ${productAttributes.deletedAt} IS NULL`,
      )
      .groupBy(productAttributeValues.value) // Get unique values
      .limit(limit);

    // Extract just the values and sort them
    const values = results
      .map((row) => row.value)
      .filter((value) => value && value.trim().length > 0) // Remove empty values
      .sort((a, b) => {
        // Prioritize exact matches and shorter values
        const queryLower = query.toLowerCase();
        const aLower = a.toLowerCase();
        const bLower = b.toLowerCase();

        if (aLower === queryLower && bLower !== queryLower) return -1;
        if (bLower === queryLower && aLower !== queryLower) return 1;
        if (aLower.startsWith(queryLower) && !bLower.startsWith(queryLower))
          return -1;
        if (bLower.startsWith(queryLower) && !aLower.startsWith(queryLower))
          return 1;

        return a.length - b.length; // Shorter values first
      });

    return new Response(JSON.stringify({ values }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error searching attribute values:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to search attribute values",
        values: [],
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};
