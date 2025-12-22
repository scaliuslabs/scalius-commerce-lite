import type { APIRoute } from "astro";
import { db } from "@/db";
import { collections } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { z } from "zod";

const updateCollectionSchema = z.object({
  name: z
    .string()
    .min(3, "Collection name must be at least 3 characters")
    .max(100, "Collection name must be less than 100 characters")
    .optional(),
  type: z.enum(["collection1", "collection2"]).optional(),
  isActive: z.boolean().optional(),
  config: z
    .object({
      categoryIds: z.array(z.string()).optional().default([]),
      productIds: z.array(z.string()).optional().default([]),
      featuredProductId: z.string().optional(),
      maxProducts: z.number().int().min(1).max(24).optional().default(8),
      title: z.string().optional(),
      subtitle: z.string().optional(),
    })
    .optional(),
});

export const GET: APIRoute = async ({ params }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(
        JSON.stringify({ message: "Collection ID is required" }),
        {
          status: 400,
        },
      );
    }

    const collection = await db
      .select()
      .from(collections)
      .where(and(eq(collections.id, id), isNull(collections.deletedAt)))
      .limit(1)
      .then((rows) => rows[0]);

    if (!collection) {
      return new Response(JSON.stringify({ message: "Collection not found" }), {
        status: 404,
      });
    }

    return new Response(JSON.stringify(collection), {
      status: 200,
    });
  } catch (error) {
    console.error("Error fetching collection:", error);
    return new Response(
      JSON.stringify({ message: "Error fetching collection" }),
      { status: 500 },
    );
  }
};

export const PUT: APIRoute = async ({ request, params }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(
        JSON.stringify({ message: "Collection ID is required" }),
        {
          status: 400,
        },
      );
    }

    const json = await request.json();
    const data = updateCollectionSchema.parse(json);

    const updateData: any = {
      updatedAt: new Date(),
    };

    if (data.name !== undefined) updateData.name = data.name;
    if (data.type !== undefined) updateData.type = data.type;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;
    if (data.config !== undefined)
      updateData.config = JSON.stringify(data.config);

    const collection = await db
      .update(collections)
      .set(updateData)
      .where(eq(collections.id, id))
      .returning()
      .get();

    return new Response(JSON.stringify(collection), {
      status: 200,
    });
  } catch (error) {
    console.error("Error updating collection:", error);
    if (error instanceof z.ZodError) {
      return new Response(JSON.stringify({ errors: error.errors }), {
        status: 400,
      });
    }
    return new Response(
      JSON.stringify({ message: "Error updating collection" }),
      { status: 500 },
    );
  }
};

export const DELETE: APIRoute = async ({ params }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(
        JSON.stringify({ message: "Collection ID is required" }),
        {
          status: 400,
        },
      );
    }

    // First check if collection exists
    const existingCollection = await db
      .select()
      .from(collections)
      .where(and(eq(collections.id, id), isNull(collections.deletedAt)))
      .limit(1)
      .then((rows) => rows[0]);

    if (!existingCollection) {
      return new Response(JSON.stringify({ message: "Collection not found" }), {
        status: 404,
      });
    }

    // Perform the soft delete
    await db
      .update(collections)
      .set({
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(collections.id, id));

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error deleting collection:", error);
    return new Response(
      JSON.stringify({
        message: "Error deleting collection",
        error: error instanceof Error ? error.message : String(error),
      }),
      { status: 500 },
    );
  }
};
