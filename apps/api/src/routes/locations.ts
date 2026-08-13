import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { deliveryLocations } from "@scalius/database/schema";
import { eq, and, isNull, asc } from "drizzle-orm";
import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";
const app = new OpenAPIHono<{ Bindings: Env }>();

const publicDeliveryLocationSchema = z.object({
  id: z.string().max(128),
  name: z.string().max(120),
  type: z.enum(["city", "zone", "area"]),
  parentId: z.string().max(128).nullable(),
  isActive: z.boolean(),
  sortOrder: z.number().int().min(-100_000).max(100_000),
});

// Helper function to format location data
const formatLocation = (location: { id: string; name: string; type: "city" | "zone" | "area"; parentId: string | null; isActive: boolean; sortOrder: number }) => ({
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
  operationId: "storefront.locations.cities",
  tags: ["Locations"],
  summary: "Get all active cities",
  responses: {
    200: {
      description: "City list",
      content: { "application/json": { schema: successEnvelope(z.array(publicDeliveryLocationSchema).max(1_000)) } },
    },
    500: errorResponses[500],
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
  operationId: "storefront.locations.zones",
  tags: ["Locations"],
  summary: "Get all active zones for a given city",
  request: {
    query: z.object({
      cityId: z.string().trim().min(1).max(128).openapi({ description: "City ID to get zones for" })
    })
  },
  responses: {
    200: {
      description: "Zone list",
      content: { "application/json": { schema: successEnvelope(z.array(publicDeliveryLocationSchema).max(1_000)) } },
    },
    400: errorResponses[400],
    500: errorResponses[500],
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
  operationId: "storefront.locations.areas",
  tags: ["Locations"],
  summary: "Get all active areas for a given zone",
  request: {
    query: z.object({
      zoneId: z.string().trim().min(1).max(128).openapi({ description: "Zone ID to get areas for" })
    })
  },
  responses: {
    200: {
      description: "Area list",
      content: { "application/json": { schema: successEnvelope(z.array(publicDeliveryLocationSchema).max(1_000)) } },
    },
    400: errorResponses[400],
    500: errorResponses[500],
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
