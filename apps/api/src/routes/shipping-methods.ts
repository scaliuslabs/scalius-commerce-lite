import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { shippingMethods as shippingMethodsTable } from "@scalius/database/schema";
import { eq, isNull, asc, and } from "drizzle-orm";
import { cacheMiddleware } from "../middleware/cache";

import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";
import { CACHE_TTLS } from "../utils/cache-ttls";
const app = new OpenAPIHono<{ Bindings: Env }>();

// Apply cache middleware
app.use(
  "*",
  cacheMiddleware({
    ttl: CACHE_TTLS.SHORT,
    keyPrefix: "api:shipping-methods:",
    varyByQuery: false,
    methods: ["GET"]
  }),
);

// GET /shipping-methods — list all active shipping methods
const listShippingMethodsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Shipping Methods"],
  summary: "List all active shipping methods",
  responses: {
    200: {
      description: "Shipping methods list",
      content: { "application/json": { schema: successEnvelope(z.object({
        shippingMethods: z.array(z.object({
          id: z.string(),
          name: z.string(),
          fee: z.number(),
          description: z.string().nullable(),
          isActive: z.boolean(),
          sortOrder: z.number(),
          createdAt: z.string().nullable(),
          updatedAt: z.string().nullable(),
        }).passthrough()),
      })) } },
    },
    500: errorResponses[500],
  }
});

app.openapi(listShippingMethodsRoute, async (c) => {
  const db = c.get("db");
  const methods = await db
    .select({
      id: shippingMethodsTable.id,
      name: shippingMethodsTable.name,
      fee: shippingMethodsTable.fee,
      description: shippingMethodsTable.description,
      isActive: shippingMethodsTable.isActive,
      sortOrder: shippingMethodsTable.sortOrder,
      createdAt: shippingMethodsTable.createdAt,
      updatedAt: shippingMethodsTable.updatedAt
    })
    .from(shippingMethodsTable)
    .where(
      and(
        eq(shippingMethodsTable.isActive, true),
        isNull(shippingMethodsTable.deletedAt),
      ),
    )
    .orderBy(
      asc(shippingMethodsTable.sortOrder),
      asc(shippingMethodsTable.name),
    );

  const formattedMethods = methods.map((method) => ({
    ...method,
    createdAt:
      method.createdAt instanceof Date ? method.createdAt.toISOString() : null,
    updatedAt:
      method.updatedAt instanceof Date ? method.updatedAt.toISOString() : null
  }));

  return ok(c, { shippingMethods: formattedMethods });
});

export { app as shippingMethodRoutes };
