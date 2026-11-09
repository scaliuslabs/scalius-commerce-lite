import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { deps } from "@scalius/core/cache-deps";

import type { Database } from "@scalius/database/client";
import { placeAddressFieldSql, places } from "@scalius/database/schema";
import { PLACE_ADDRESS_COUNTRY, deliveryHierarchyLevel } from "@scalius/shared/places";
import { eq, and, isNull, asc, count, type SQL } from "drizzle-orm";
import { rankPlaces } from "@scalius/shared/place-search";
import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";
const app = new OpenAPIHono<{ Bindings: Env }>();
// Every read here is of Bangladesh's places (City, Thana, Area: the address
// adapter's fields, by level): one key covers them all.
app.use("*", async (_c, next) => {
  deps.locations();
  await next();
});

const publicDeliveryLocationSchema = z.object({
  id: z.string().max(128),
  name: z.string().max(120),
  type: z.enum(["city", "zone", "area"]),
  parentId: z.string().max(128).nullable(),
  isActive: z.boolean(),
  sortOrder: z.number().int().min(-100_000).max(100_000),
});

const locationSummaryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z.string().trim().max(120).optional().default(""),
});

const locationSummaryEnvelope = successEnvelope(z.object({
  locations: z.array(publicDeliveryLocationSchema).max(100),
  pagination: z.object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  }),
}));

/** The columns a buyer's picker reads, with the place's address field. */
const publicColumns = {
  id: places.id,
  name: places.name,
  type: placeAddressFieldSql,
  parentId: places.parentId,
  isActive: places.isActive,
  sortOrder: places.sortOrder,
};

/**
 * Live, active places of one address field: Bangladesh's cities, or the
 * children of one place (a child is in its parent's country, so the parent
 * index alone finds them).
 */
const ofField = (field: "city" | "zone" | "area", parentId?: string) => [
  ...(parentId === undefined ? [eq(places.countryCode, PLACE_ADDRESS_COUNTRY)] : [eq(places.parentId, parentId)]),
  eq(places.level, deliveryHierarchyLevel(field)),
  isNull(places.deletedAt),
  eq(places.isActive, true),
];

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
    .select(publicColumns)
    .from(places)
    .where(and(...ofField("city")))
    .orderBy(asc(places.sortOrder), asc(places.name));

  return ok(c, cities.map(formatLocation));
});

/**
 * One page of a field's places matching `search`. A field's places under one
 * parent are a bounded list (Bangladesh: at most a few hundred), so a search
 * reads them all and ranks them with the shared place matcher, which finds an
 * English name from Bangla typing and an older spelling from the new one.
 */
async function placeSummaryPage(
  db: Database,
  scope: SQL[],
  { page, limit, search }: { page: number; limit: number; search: string },
) {
  const where = and(...scope);
  if (search) {
    const rows = await db.select(publicColumns).from(places).where(where)
      .orderBy(asc(places.sortOrder), asc(places.name)).limit(PLACE_SEARCH_SCOPE_LIMIT);
    const matches = rankPlaces(rows, search);
    return {
      locations: matches.slice((page - 1) * limit, page * limit).map(formatLocation),
      pagination: { page, limit, total: matches.length, totalPages: Math.ceil(matches.length / limit) },
    };
  }
  const [counts, rows] = await db.batch([
    db.select({ total: count() }).from(places).where(where),
    db.select(publicColumns).from(places).where(where)
      .orderBy(asc(places.sortOrder), asc(places.name))
      .limit(limit).offset((page - 1) * limit),
  ]);
  const total = Number(counts[0]?.total ?? 0);
  return {
    locations: rows.map(formatLocation),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/** More places than any one parent holds (Bangladesh's largest: 367 areas). */
const PLACE_SEARCH_SCOPE_LIMIT = 2_000;

const listCitySummariesRoute = createRoute({
  method: "get",
  path: "/cities/summaries",
  operationId: "storefront.locations.city_summaries",
  tags: ["Locations"],
  summary: "Search bounded active city summaries",
  request: { query: locationSummaryQuerySchema },
  responses: {
    200: { description: "Paginated city summaries", content: { "application/json": { schema: locationSummaryEnvelope } } },
    500: errorResponses[500],
  },
});

app.openapi(listCitySummariesRoute, async (c) => {
  const db = c.get("db");
  const query = c.req.valid("query");
  return ok(c, await placeSummaryPage(db, ofField("city"), query));
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
    .select(publicColumns)
    .from(places)
    .where(and(...ofField("zone", cityId)))
    .orderBy(asc(places.sortOrder), asc(places.name));

  return ok(c, zones.map(formatLocation));
});

const listZoneSummariesRoute = createRoute({
  method: "get",
  path: "/zones/summaries",
  operationId: "storefront.locations.zone_summaries",
  tags: ["Locations"],
  summary: "Search bounded active zone summaries for a city",
  request: { query: locationSummaryQuerySchema.extend({
    cityId: z.string().trim().min(1).max(128),
  }) },
  responses: {
    200: { description: "Paginated zone summaries", content: { "application/json": { schema: locationSummaryEnvelope } } },
    400: errorResponses[400],
    500: errorResponses[500],
  },
});

app.openapi(listZoneSummariesRoute, async (c) => {
  const db = c.get("db");
  const query = c.req.valid("query");
  return ok(c, await placeSummaryPage(db, ofField("zone", query.cityId), query));
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
    .select(publicColumns)
    .from(places)
    .where(and(...ofField("area", zoneId)))
    .orderBy(asc(places.sortOrder), asc(places.name));

  return ok(c, areas.map(formatLocation));
});

const listAreaSummariesRoute = createRoute({
  method: "get",
  path: "/areas/summaries",
  operationId: "storefront.locations.area_summaries",
  tags: ["Locations"],
  summary: "Search bounded active area summaries for a zone",
  request: { query: locationSummaryQuerySchema.extend({
    zoneId: z.string().trim().min(1).max(128),
  }) },
  responses: {
    200: { description: "Paginated area summaries", content: { "application/json": { schema: locationSummaryEnvelope } } },
    400: errorResponses[400],
    500: errorResponses[500],
  },
});

app.openapi(listAreaSummariesRoute, async (c) => {
  const db = c.get("db");
  const query = c.req.valid("query");
  return ok(c, await placeSummaryPage(db, ofField("area", query.zoneId), query));
});

export { app as locationRoutes };
