import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { heroSliders } from "@scalius/database/schema";
import { eq, or, and, isNull } from "drizzle-orm";
import { cacheMiddleware } from "../middleware/cache";
import { NotFoundError } from "../utils/api-error";

// Create an OpenAPIHono app for hero routes
const app = new OpenAPIHono<{ Bindings: Env }>();

// Apply cache middleware with longer TTL for hero content
app.use(
  "*",
  cacheMiddleware({
    ttl: 3600000,
    keyPrefix: "api:hero:",
    varyByQuery: false,
    methods: ["GET"]
  }),
);

// Helper function to convert Unix timestamp to Date
const unixToDate = (timestamp: number | null): Date | null => {
  if (!timestamp) return null;
  return new Date(timestamp * 1000);
};

// GET /hero/sliders — get all active hero sliders
const listSlidersRoute = createRoute({
  method: "get",
  path: "/sliders",
  tags: ["Hero"],
  summary: "Get all active hero sliders",
  request: {
    query: z.object({
      type: z.enum(["desktop", "mobile"]).optional().openapi({ description: "Slider type filter" })
    })
  },
  responses: {
    200: {
      description: "Hero slider data"
      
    },
    500: {
      description: "Server error"
    }
  }
});

app.openapi(listSlidersRoute, async (c) => {
  const db = c.get("db");
  // Get user agent from request to determine device type
  const userAgent = c.req.header("user-agent") || "";
  const isMobile = userAgent.includes("Mobile");

  // Check if client only wants a specific type
  const { type: requestedType } = c.req.valid("query");

  // Build the query conditions
  let typeCondition;
  if (requestedType === "desktop" || requestedType === "mobile") {
    typeCondition = eq(heroSliders.type, requestedType);
  } else if (isMobile) {
    typeCondition = or(
      eq(heroSliders.type, "mobile"),
      eq(heroSliders.type, "desktop"),
    );
  } else {
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
      updatedAt
    };
  };

  // Add headers for device detection (useful for client caching)
  c.header("X-Device-Type", isMobile ? "mobile" : "desktop");

  // If specific type was requested, return only that slider
  if (requestedType === "desktop") {
    return c.json({
      slider: formatSlider(desktopSlider),
      images: desktopImages
    }, 200);
  } else if (requestedType === "mobile") {
    return c.json({
      slider: formatSlider(mobileSlider),
      images: mobileImages
    }, 200);
  }

  // Return both sliders with the appropriate images for the device type
  return c.json({
    desktop: formatSlider(desktopSlider),
    mobile: formatSlider(mobileSlider),
    images:
      isMobile && mobileImages.length > 0 ? mobileImages : desktopImages,
    isMobile
  }, 200);
});

// GET /hero/sliders/:id — get hero slider by ID
const getSliderByIdRoute = createRoute({
  method: "get",
  path: "/sliders/{id}",
  tags: ["Hero"],
  summary: "Get hero slider by ID",
  responses: {
    200: {
      description: "Hero slider details"
    },
    404: {
      description: "Slider not found"
    },
    500: {
      description: "Server error"
    }
  }
});

app.openapi(getSliderByIdRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");

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
    throw new NotFoundError("Hero slider not found");
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
      updatedAt
    }
  }, 200);
});

// Export the hero routes
export { app as heroRoutes };
