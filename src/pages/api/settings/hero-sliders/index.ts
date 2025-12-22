import type { APIRoute } from "astro";
import { db } from "@/db";
import { heroSliders } from "@/db/schema";
import { nanoid } from "nanoid";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { isNull } from "drizzle-orm";

const sliderImageSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  title: z.string(),
  link: z.string(),
});

const createHeroSliderSchema = z.object({
  type: z.enum(["desktop", "mobile"]),
  images: z.array(sliderImageSchema),
  isActive: z.boolean().optional(),
});

// Get all hero sliders
export const GET: APIRoute = async () => {
  try {
    const data = await db
      .select()
      .from(heroSliders)
      .where(isNull(heroSliders.deletedAt));

    // Parse the images JSON string for each slider
    const parsedData = data.map((slider) => ({
      ...slider,
      images: JSON.parse(slider.images),
    }));

    return new Response(JSON.stringify({ success: true, data: parsedData }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error fetching sliders:", error);
    return new Response(
      JSON.stringify({ success: false, error: "Internal Server Error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

// Create a new hero slider
export const POST: APIRoute = async ({ request }) => {
  try {
    const json = await request.json();
    const data = createHeroSliderSchema.parse(json);

    // Check if a slider of this type already exists
    const existingSlider = await db
      .select()
      .from(heroSliders)
      .where(sql`type = ${data.type} AND deleted_at IS NULL`)
      .get();

    if (existingSlider) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `A ${data.type} slider already exists`,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const sliderId = "slider_" + nanoid();

    const [slider] = await db
      .insert(heroSliders)
      .values({
        id: sliderId,
        type: data.type,
        images: JSON.stringify(data.images),
        isActive: data.isActive ?? true,
        createdAt: sql`CURRENT_TIMESTAMP`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .returning();

    // Parse the images JSON string before sending response
    const responseData = {
      ...slider,
      images: JSON.parse(slider.images),
    };

    return new Response(JSON.stringify({ success: true, data: responseData }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error creating slider:", error);
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
