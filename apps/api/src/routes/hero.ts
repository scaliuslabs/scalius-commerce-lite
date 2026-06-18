import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";

import { heroSliders } from "@scalius/database/schema";
import { eq, or, and, isNull } from "drizzle-orm";
import { cacheMiddleware } from "../middleware/cache";
import { NotFoundError } from "../utils/api-error";

import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";
import { CACHE_TTLS } from "../utils/cache-ttls";

const heroImageSchema = z.object({ url: z.string(), alt: z.string().nullable(), sortOrder: z.number() }).passthrough();
type HeroImage = z.infer<typeof heroImageSchema>;

const parseHeroImages = (imagesJson: string | null | undefined): HeroImage[] => {
  try {
    return imagesJson ? (JSON.parse(imagesJson) as HeroImage[]) : [];
  } catch {
    return [];
  }
};

const formatHeroTimestamp = (value: unknown): string | null => {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }

  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;

  const date = Number.isFinite(numericValue)
    ? new Date(numericValue > 1_000_000_000_000 ? numericValue : numericValue * 1000)
    : new Date(String(value));

  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

// Create an OpenAPIHono app for hero routes
const app = new OpenAPIHono<{ Bindings: Env }>();

function shouldCacheHeroRequest(c: Context): boolean {
  const normalizedPath = c.req.path.replace(/\/$/, "");
  if (!normalizedPath.endsWith("/hero/sliders")) {
    return true;
  }

  const type = c.req.query("type");
  return type === "desktop" || type === "mobile";
}

// Apply cache middleware with longer TTL for deterministic hero content.
// The untyped slider list varies by User-Agent, so cache only explicit
// `?type=desktop|mobile` list reads plus path-scoped slider detail reads.
app.use(
  "*",
  cacheMiddleware({
    ttl: CACHE_TTLS.STANDARD,
    keyPrefix: "api:hero:",
    varyByQuery: true,
    methods: ["GET"],
    cacheCondition: shouldCacheHeroRequest,
  }),
);

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
      description: "Hero slider data",
      content: { "application/json": { schema: successEnvelope(z.object({
        desktop: z.object({
          id: z.string(),
          type: z.string(),
          images: z.array(heroImageSchema),
          isActive: z.boolean(),
          createdAt: z.string().nullable(),
          updatedAt: z.string().nullable(),
        }).nullable().optional(),
        mobile: z.object({
          id: z.string(),
          type: z.string(),
          images: z.array(heroImageSchema),
          isActive: z.boolean(),
          createdAt: z.string().nullable(),
          updatedAt: z.string().nullable(),
        }).nullable().optional(),
        slider: z.object({ id: z.string(), type: z.string(), images: z.array(heroImageSchema), isActive: z.boolean() }).passthrough().nullable().optional(),
        images: z.array(heroImageSchema),
        isMobile: z.boolean().optional(),
      }).passthrough()) } },
    },
    500: errorResponses[500],
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
  const desktopImages = parseHeroImages(desktopSlider?.images);
  const mobileImages = parseHeroImages(mobileSlider?.images);

  // Format dates
  const formatSlider = (slider: (typeof sliders)[0] | undefined) => {
    if (!slider) return null;

    return {
      id: slider.id,
      type: slider.type,
      images: parseHeroImages(slider.images),
      isActive: slider.isActive,
      createdAt: formatHeroTimestamp(slider.createdAt),
      updatedAt: formatHeroTimestamp(slider.updatedAt),
    };
  };

  // Add headers for device detection (useful for client caching)
  c.header("X-Device-Type", isMobile ? "mobile" : "desktop");

  // If specific type was requested, return only that slider
  if (requestedType === "desktop") {
    return ok(c, {
      slider: formatSlider(desktopSlider),
      images: desktopImages
    });
  } else if (requestedType === "mobile") {
    return ok(c, {
      slider: formatSlider(mobileSlider),
      images: mobileImages
    });
  }

  // Return both sliders with the appropriate images for the device type
  return ok(c, {
    desktop: formatSlider(desktopSlider),
    mobile: formatSlider(mobileSlider),
    images:
      isMobile && mobileImages.length > 0 ? mobileImages : desktopImages,
    isMobile
  });
});

// GET /hero/sliders/:id — get hero slider by ID
const getSliderByIdRoute = createRoute({
  method: "get",
  path: "/sliders/{id}",
  tags: ["Hero"],
  summary: "Get hero slider by ID",
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Hero slider details",
      content: { "application/json": { schema: successEnvelope(z.object({
        slider: z.object({
          id: z.string(),
          type: z.string(),
          images: z.array(heroImageSchema),
          isActive: z.boolean(),
          createdAt: z.string().nullable(),
          updatedAt: z.string().nullable(),
        }),
      })) } },
    },
    404: errorResponses[404],
    500: errorResponses[500],
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
  const images = parseHeroImages(slider.images);

  // Format the response
  return ok(c, {
    slider: {
      id: slider.id,
      type: slider.type,
      images,
      isActive: slider.isActive,
      createdAt: formatHeroTimestamp(slider.createdAt),
      updatedAt: formatHeroTimestamp(slider.updatedAt),
    }
  });
});

// Export the hero routes
export { app as heroRoutes };
