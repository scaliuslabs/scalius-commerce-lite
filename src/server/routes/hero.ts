import { Hono } from "hono";

import { heroSliders } from "@/db/schema";
import { eq, or, and, isNull } from "drizzle-orm";
import { cacheMiddleware } from "../middleware/cache";

// Create a Hono app for hero routes
const app = new Hono<{ Bindings: Env }>();

// Apply cache middleware with longer TTL for hero content
app.use(
  "*",
  cacheMiddleware({
    ttl: 3600000,
    keyPrefix: "api:hero:",
    varyByQuery: false,
    methods: ["GET"],
  }),
);

// Helper function to convert Unix timestamp to Date
const unixToDate = (timestamp: number | null): Date | null => {
  if (!timestamp) return null;
  return new Date(timestamp * 1000);
};

// Get all active hero sliders (public)
app.get("/sliders", async (c) => {
  try {
    const db = c.get("db");
    // Get user agent from request to determine device type
    const userAgent = c.req.header("user-agent") || "";
    const isMobile = userAgent.includes("Mobile");

    // Check if client only wants a specific type
    const requestedType = c.req.query("type");

    // Build the query conditions
    let typeCondition;
    if (requestedType === "desktop" || requestedType === "mobile") {
      // If specific type is requested, return only that type
      typeCondition = eq(heroSliders.type, requestedType);
    } else if (isMobile) {
      // If mobile device, prioritize mobile sliders
      typeCondition = or(
        eq(heroSliders.type, "mobile"),
        eq(heroSliders.type, "desktop"),
      );
    } else {
      // For desktop devices, prioritize desktop sliders
      typeCondition = or(
        eq(heroSliders.type, "desktop"),
        eq(heroSliders.type, "mobile"),
      );
    }

    // Get active sliders
    const sliders = await db
      .select()
      .from(heroSliders)
      .where(
        and(
          typeCondition,
          eq(heroSliders.isActive, true),
          isNull(heroSliders.deletedAt),
        ),
      );

    // Process the results
    const desktopSlider = sliders.find((slider) => slider.type === "desktop");
    const mobileSlider = sliders.find((slider) => slider.type === "mobile");

    // Parse the JSON strings into arrays
    const desktopImages = desktopSlider ? JSON.parse(desktopSlider.images) : [];
    const mobileImages = mobileSlider ? JSON.parse(mobileSlider.images) : [];

    // Format dates
    const formatSlider = (slider: (typeof sliders)[0] | undefined) => {
      if (!slider) return null;

      // Handle possible invalid timestamp values
      let createdAt = null;
      let updatedAt = null;

      try {
        const createdDate = unixToDate(slider.createdAt as unknown as number);
        if (createdDate instanceof Date && !isNaN(createdDate.getTime())) {
          createdAt = createdDate.toISOString();
        }
      } catch (error) {
        console.warn(`Invalid createdAt timestamp for slider ${slider.id}`);
      }

      try {
        const updatedDate = unixToDate(slider.updatedAt as unknown as number);
        if (updatedDate instanceof Date && !isNaN(updatedDate.getTime())) {
          updatedAt = updatedDate.toISOString();
        }
      } catch (error) {
        console.warn(`Invalid updatedAt timestamp for slider ${slider.id}`);
      }

      return {
        id: slider.id,
        type: slider.type,
        images: JSON.parse(slider.images),
        isActive: slider.isActive,
        createdAt,
        updatedAt,
      };
    };

    // Add headers for device detection (useful for client caching)
    c.header("X-Device-Type", isMobile ? "mobile" : "desktop");

    // If specific type was requested, return only that slider
    if (requestedType === "desktop") {
      return c.json({
        slider: formatSlider(desktopSlider),
        images: desktopImages,
      });
    } else if (requestedType === "mobile") {
      return c.json({
        slider: formatSlider(mobileSlider),
        images: mobileImages,
      });
    }

    // Return both sliders with the appropriate images for the device type
    return c.json({
      desktop: formatSlider(desktopSlider),
      mobile: formatSlider(mobileSlider),
      // Return the appropriate images based on device type
      images:
        isMobile && mobileImages.length > 0 ? mobileImages : desktopImages,
      // Also include device detection for frontend use
      isMobile,
    });
  } catch (error) {
    console.error("Error fetching hero sliders:", error);
    return c.json({ error: "Failed to fetch hero sliders" }, 500);
  }
});

// Get hero slider by ID (public)
app.get("/sliders/:id", async (c) => {
  try {
    const db = c.get("db");
    const id = c.req.param("id");

    const slider = await db
      .select()
      .from(heroSliders)
      .where(
        and(
          eq(heroSliders.id, id),
          eq(heroSliders.isActive, true),
          isNull(heroSliders.deletedAt),
        ),
      )
      .get();

    if (!slider) {
      return c.json({ error: "Hero slider not found" }, 404);
    }

    // Parse the images JSON
    const images = JSON.parse(slider.images);

    // Handle possible invalid timestamp values
    let createdAt = null;
    let updatedAt = null;

    try {
      const createdDate = unixToDate(slider.createdAt as unknown as number);
      if (createdDate instanceof Date && !isNaN(createdDate.getTime())) {
        createdAt = createdDate.toISOString();
      }
    } catch (error) {
      console.warn(`Invalid createdAt timestamp for slider ${slider.id}`);
    }

    try {
      const updatedDate = unixToDate(slider.updatedAt as unknown as number);
      if (updatedDate instanceof Date && !isNaN(updatedDate.getTime())) {
        updatedAt = updatedDate.toISOString();
      }
    } catch (error) {
      console.warn(`Invalid updatedAt timestamp for slider ${slider.id}`);
    }

    // Format the response
    return c.json({
      slider: {
        id: slider.id,
        type: slider.type,
        images,
        isActive: slider.isActive,
        createdAt,
        updatedAt,
      },
    });
  } catch (error) {
    console.error("Error fetching hero slider:", error);
    return c.json({ error: "Failed to fetch hero slider" }, 500);
  }
});

// Export the hero routes
export { app as heroRoutes };
