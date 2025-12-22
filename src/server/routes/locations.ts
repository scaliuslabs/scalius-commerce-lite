import { Hono } from "hono";

import { deliveryLocations } from "@/db/schema";
import { eq, and, isNull, asc } from "drizzle-orm";
import { cacheMiddleware } from "../middleware/cache";

const app = new Hono<{ Bindings: Env }>();

// Apply cache middleware - locations change infrequently
app.use(
  "*",
  cacheMiddleware({
    ttl: 0,
    keyPrefix: "api:locations:",
    varyByQuery: true, // Cache based on query params (cityId, zoneId)
    methods: ["GET"],
  }),
);

// Helper function to format location data
const formatLocation = (location: any) => ({
  id: location.id,
  name: location.name,
  type: location.type,
  parentId: location.parentId,
  // Avoid sending potentially large/sensitive data if not needed
  // externalIds: location.externalIds ? JSON.parse(location.externalIds) : {},
  // metadata: location.metadata ? JSON.parse(location.metadata) : {},
  isActive: location.isActive,
  sortOrder: location.sortOrder,
});

// GET all active cities
app.get("/cities", async (c) => {
  try {
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

    return c.json({ success: true, data: cities.map(formatLocation) });
  } catch (error) {
    console.error("Error fetching cities:", error);
    return c.json({ success: false, error: "Failed to fetch cities" }, 500);
  }
});

// GET all active zones for a given city
app.get("/zones", async (c) => {
  const cityId = c.req.query("cityId");
  if (!cityId) {
    return c.json(
      { success: false, error: "cityId parameter is required" },
      400,
    );
  }

  try {
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

    return c.json({ success: true, data: zones.map(formatLocation) });
  } catch (error) {
    console.error("Error fetching zones:", error);
    return c.json({ success: false, error: "Failed to fetch zones" }, 500);
  }
});

// GET all active areas for a given zone
app.get("/areas", async (c) => {
  const zoneId = c.req.query("zoneId");
  if (!zoneId) {
    return c.json(
      { success: false, error: "zoneId parameter is required" },
      400,
    );
  }

  try {
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

    return c.json({ success: true, data: areas.map(formatLocation) });
  } catch (error) {
    console.error("Error fetching areas:", error);
    return c.json({ success: false, error: "Failed to fetch areas" }, 500);
  }
});

export { app as locationRoutes };
