import type { APIRoute } from "astro";
import { createLocation } from "@/lib/delivery-locations";
import { z } from "zod";
import { db } from "@/db";
import { deliveryLocations } from "@/db/schema";
import { and, eq, isNull, sql, like, inArray } from "drizzle-orm";

// Validate location data
const locationSchema = z.object({
  name: z.string().min(1, "Name is required"),
  type: z.enum(["city", "zone", "area"]),
  parentId: z.string().nullish(),
  externalIds: z.record(z.string(), z.union([z.string(), z.number()])),
  metadata: z.record(z.string(), z.any()),
  isActive: z.boolean().optional(),
  sortOrder: z.number().optional(),
});

// GET /api/settings/delivery-locations - List locations
export const GET: APIRoute = async ({ url }) => {
  try {
    const type = url.searchParams.get("type") as
      | "city"
      | "zone"
      | "area"
      | null;
    const parentId = url.searchParams.get("parentId");
    const search = url.searchParams.get("search");
    const page = parseInt(url.searchParams.get("page") || "1");
    const limit = parseInt(url.searchParams.get("limit") || "100");
    const offset = (page - 1) * limit;

    let conditions = [isNull(deliveryLocations.deletedAt)];

    if (type) {
      conditions.push(eq(deliveryLocations.type, type));
    }

    if (parentId) {
      conditions.push(eq(deliveryLocations.parentId, parentId));
    }

    if (search && search.trim() !== "") {
      conditions.push(like(deliveryLocations.name, `%${search.trim()}%`));
    }

    const query = db
      .select()
      .from(deliveryLocations)
      .where(and(...conditions))
      .orderBy(deliveryLocations.sortOrder)
      .limit(limit)
      .offset(offset);

    const locations = await query;

    // Get total count for pagination
    const countResult = await db
      .select({ count: sql`count(*)` })
      .from(deliveryLocations)
      .where(and(...conditions));

    const totalCount = Number(countResult[0]?.count || 0);

    // Parse JSON strings to objects
    const formattedLocations = locations.map((location) => ({
      ...location,
      externalIds: JSON.parse(location.externalIds),
      metadata: JSON.parse(location.metadata),
      // Include human-readable name and ID format to help debug
      displayName: `${location.name} (ID: ${location.id.slice(0, 8)}...)`,
    }));

    return new Response(
      JSON.stringify({
        data: formattedLocations,
        pagination: {
          total: totalCount,
          page,
          limit,
          totalPages: Math.ceil(totalCount / limit),
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Error fetching delivery locations:", error);
    return new Response(
      JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch delivery locations",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};

// POST /api/settings/delivery-locations - Create a new location
export const POST: APIRoute = async ({ request }) => {
  try {
    const data = await request.json();

    // Validate the input
    const parsedData = locationSchema.parse(data);

    // Create the location
    const newLocation = await createLocation(parsedData);

    return new Response(JSON.stringify(newLocation), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error creating delivery location:", error);

    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({
          error: "Validation failed",
          details: error.errors,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : "Failed to create delivery location",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};

// DELETE /api/settings/delivery-locations - Bulk delete locations
export const DELETE: APIRoute = async ({ request }) => {
  try {
    const { ids } = await request.json();

    if (!Array.isArray(ids) || ids.length === 0) {
      return new Response(
        JSON.stringify({ error: "An array of location IDs is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Soft delete by setting deletedAt
    await db
      .update(deliveryLocations)
      .set({ deletedAt: new Date() })
      .where(
        and(
          inArray(deliveryLocations.id, ids as string[]),
          isNull(deliveryLocations.deletedAt),
        ),
      );

    return new Response(
      JSON.stringify({
        success: true,
        message: `${ids.length} locations deleted successfully.`,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Error bulk deleting delivery locations:", error);
    return new Response(
      JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : "Failed to bulk delete delivery locations",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
