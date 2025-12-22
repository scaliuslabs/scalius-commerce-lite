import type { APIRoute } from "astro";
import { getLocationById } from "@/lib/delivery-locations";
import { z } from "zod";
import { db } from "@/db";
import { deliveryLocations } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";

// Validate location update data
const updateLocationSchema = z.object({
  name: z.string().min(1, "Name is required").optional(),
  parentId: z.string().nullish().optional(),
  externalIds: z
    .record(z.string(), z.union([z.string(), z.number()]))
    .optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().optional(),
});

// GET /api/settings/delivery-locations/:id - Get a single location
export const GET: APIRoute = async ({ params }) => {
  try {
    const { id } = params;

    if (!id) {
      return new Response(
        JSON.stringify({ error: "Location ID is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const location = await getLocationById(id);

    if (!location) {
      return new Response(JSON.stringify({ error: "Location not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify(location), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error fetching delivery location:", error);
    return new Response(
      JSON.stringify({
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch delivery location",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};

// PUT /api/settings/delivery-locations/:id - Update a location
export const PUT: APIRoute = async ({ params, request }) => {
  try {
    const id = params.id;

    if (!id) {
      return new Response(
        JSON.stringify({ error: "Location ID is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const data = await request.json();

    // Validate the input
    const parsedData = updateLocationSchema.parse(data);

    // Format the data for update
    const updateData: any = {};

    if (parsedData.name !== undefined) {
      updateData.name = parsedData.name;
    }

    if (parsedData.parentId !== undefined) {
      updateData.parentId = parsedData.parentId;
    }

    if (parsedData.externalIds !== undefined) {
      updateData.externalIds = JSON.stringify(parsedData.externalIds);
    }

    if (parsedData.metadata !== undefined) {
      updateData.metadata = JSON.stringify(parsedData.metadata);
    }

    if (parsedData.isActive !== undefined) {
      updateData.isActive = parsedData.isActive;
    }

    if (parsedData.sortOrder !== undefined) {
      updateData.sortOrder = parsedData.sortOrder;
    }

    // Always update the updatedAt timestamp
    updateData.updatedAt = new Date();

    // Update the location
    await db
      .update(deliveryLocations)
      .set(updateData)
      .where(
        and(eq(deliveryLocations.id, id), isNull(deliveryLocations.deletedAt)),
      );

    // Fetch the updated location
    const updatedLocation = await db
      .select()
      .from(deliveryLocations)
      .where(
        and(eq(deliveryLocations.id, id), isNull(deliveryLocations.deletedAt)),
      )
      .then((res) => res[0]);

    if (!updatedLocation) {
      return new Response(JSON.stringify({ error: "Location not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Parse JSON strings to objects before returning
    return new Response(
      JSON.stringify({
        ...updatedLocation,
        externalIds: JSON.parse(updatedLocation.externalIds),
        metadata: JSON.parse(updatedLocation.metadata),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("Error updating location:", error);

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
          error instanceof Error ? error.message : "Failed to update location",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};

// DELETE /api/settings/delivery-locations/:id - Delete a location
export const DELETE: APIRoute = async ({ params }) => {
  try {
    const id = params.id;

    if (!id) {
      return new Response(
        JSON.stringify({ error: "Location ID is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Soft delete by setting deletedAt
    await db
      .update(deliveryLocations)
      .set({ deletedAt: new Date() })
      .where(
        and(eq(deliveryLocations.id, id), isNull(deliveryLocations.deletedAt)),
      );

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error deleting location:", error);
    return new Response(
      JSON.stringify({
        error:
          error instanceof Error ? error.message : "Failed to delete location",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
