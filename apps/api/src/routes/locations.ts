import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { deliveryLocations } from "@scalius/database/schema";
import { eq, and, isNull, asc } from "drizzle-orm";
import { cacheMiddleware } from "../middleware/cache";
import { ValidationError } from "../utils/api-error";

import { ok } from "../utils/api-response";
const app = new OpenAPIHono<{ Bindings: Env }>();

// Apply cache middleware - locations change infrequently
app.use(
  "*",
  cacheMiddleware({
    ttl: 600, // 10 minutes
    keyPrefix: "api:locations:",
    varyByQuery: true,
    methods: ["GET"]
  }),
);

// Helper function to format location data
const formatLocation = (location: { id: string; name: string; type: string; parentId: string | null; isActive: boolean; sortOrder: number }) => ({
  id: location.id,
  name: location.name,
  type: location.type,
  parentId: location.parentId,
  isActive: location.isActive,
  sortOrder: location.sortOrder
});

// GET /locations/cities — get all active cities
const listCitiesRoute = createRoute({
  method: "get",
  path: "/cities",
  tags: ["Locations"],
  summary: "Get all active cities",
  responses: {
    200: {
      description: "City list"
    },
    500: {
      description: "Server error"
    }
  }
});

app.openapi(listCitiesRoute, async (c) => {
  const db = c.get("db");
  const cities = await db
    .select()
    .from(deliveryLocations)
    .where(
      and(
        eq(deliveryLocations.type, "city"),
        isNull(deliveryLocations.deletedAt),
        eq(deliveryLocations.isActive, true),
      ),
    )
    .orderBy(asc(deliveryLocations.sortOrder), asc(deliveryLocations.name));

  return ok(c, cities.map(formatLocation));
});

// GET /locations/zones — get all active zones for a given city
const listZonesRoute = createRoute({
  method: "get",
  path: "/zones",
  tags: ["Locations"],
  summary: "Get all active zones for a given city",
  request: {
    query: z.object({
      cityId: z.string().openapi({ description: "City ID to get zones for" })
    })
  },
  responses: {
    200: {
      description: "Zone list"
    },
    400: {
      description: "Bad request"
    },
    500: {
      description: "Server error"
    }
  }
});

app.openapi(listZonesRoute, async (c) => {
  const { cityId } = c.req.valid("query");

  const db = c.get("db");
  const zones = await db
    .select()
    .from(deliveryLocations)
    .where(
      and(
        eq(deliveryLocations.type, "zone"),
        eq(deliveryLocations.parentId, cityId),
        isNull(deliveryLocations.deletedAt),
        eq(deliveryLocations.isActive, true),
      ),
    )
    .orderBy(asc(deliveryLocations.sortOrder), asc(deliveryLocations.name));

  return ok(c, zones.map(formatLocation));
});

// GET /locations/areas — get all active areas for a given zone
const listAreasRoute = createRoute({
  method: "get",
  path: "/areas",
  tags: ["Locations"],
  summary: "Get all active areas for a given zone",
  request: {
    query: z.object({
      zoneId: z.string().openapi({ description: "Zone ID to get areas for" })
    })
  },
  responses: {
    200: {
      description: "Area list"
    },
    400: {
      description: "Bad request"
    },
    500: {
      description: "Server error"
    }
  }
});

app.openapi(listAreasRoute, async (c) => {
  const { zoneId } = c.req.valid("query");

  const db = c.get("db");
  const areas = await db
    .select()
    .from(deliveryLocations)
    .where(
      and(
        eq(deliveryLocations.type, "area"),
        eq(deliveryLocations.parentId, zoneId),
        isNull(deliveryLocations.deletedAt),
        eq(deliveryLocations.isActive, true),
      ),
    )
    .orderBy(asc(deliveryLocations.sortOrder), asc(deliveryLocations.name));

  return ok(c, areas.map(formatLocation));
});

export { app as locationRoutes };
