import type { APIRoute } from "astro";
import { db } from "@/db";
import { heroSliders } from "@/db/schema";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";

const sliderImageSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  title: z.string(),
  link: z.string(),
});

const updateHeroSliderSchema = z.object({
  type: z.enum(["desktop", "mobile"]).optional(),
  images: z.array(sliderImageSchema).optional(),
  isActive: z.boolean().optional(),
});

// Get a single hero slider
export const GET: APIRoute = async ({ params }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(
        JSON.stringify({ success: false, error: "ID is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const slider = await db
      .select()
      .from(heroSliders)
      .where(and(eq(heroSliders.id, id), isNull(heroSliders.deletedAt)))
      .get();

    if (!slider) {
      return new Response(
        JSON.stringify({ success: false, error: "Slider not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Parse the images JSON string
    const responseData = {
      ...slider,
      images: JSON.parse(slider.images),
    };

    return new Response(JSON.stringify({ success: true, data: responseData }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error fetching slider:", error);
    return new Response(
      JSON.stringify({ success: false, error: "Internal Server Error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

// Update a hero slider
export const PUT: APIRoute = async ({ request, params }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(
        JSON.stringify({ success: false, error: "ID is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const json = await request.json();
    const data = updateHeroSliderSchema.parse(json);

    // If images are provided, stringify them
    const updateData = {
      ...data,
      images: data.images ? JSON.stringify(data.images) : undefined,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    };

    const [slider] = await db
      .update(heroSliders)
      .set(updateData)
      .where(and(eq(heroSliders.id, id), isNull(heroSliders.deletedAt)))
      .returning();

    if (!slider) {
      return new Response(
        JSON.stringify({ success: false, error: "Slider not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Parse the images JSON string before sending response
    const responseData = {
      ...slider,
      images: JSON.parse(slider.images),
    };

    return new Response(JSON.stringify({ success: true, data: responseData }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error updating slider:", error);
    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Invalid data",
          details: error.errors,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ success: false, error: "Internal Server Error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

// Delete a hero slider (soft delete)
export const DELETE: APIRoute = async ({ params }) => {
  try {
    const { id } = params;
    if (!id) {
      return new Response(
        JSON.stringify({ success: false, error: "ID is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const [slider] = await db
      .update(heroSliders)
      .set({
        deletedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(and(eq(heroSliders.id, id), isNull(heroSliders.deletedAt)))
      .returning();

    if (!slider) {
      return new Response(
        JSON.stringify({ success: false, error: "Slider not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Parse the images JSON string before sending response
    const responseData = {
      ...slider,
      images: JSON.parse(slider.images),
    };

    return new Response(JSON.stringify({ success: true, data: responseData }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error deleting slider:", error);
    return new Response(
      JSON.stringify({ success: false, error: "Internal Server Error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
