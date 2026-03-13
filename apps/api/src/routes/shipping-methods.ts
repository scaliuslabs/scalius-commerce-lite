import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { shippingMethods as shippingMethodsTable } from "@scalius/database/schema";
import { eq, isNull, asc, and } from "drizzle-orm";
import { cacheMiddleware } from "../middleware/cache";

const app = new OpenAPIHono<{ Bindings: Env }>();

// Apply cache middleware
app.use(
  "*",
  cacheMiddleware({
    ttl: 300000, // 5 minutes
    keyPrefix: "api:shipping-methods:",
    varyByQuery: false,
    methods: ["GET"],
  }),
);

// Helper function to convert Unix timestamp to Date
const unixToDate = (timestamp: number | null): Date | null => {
  if (!timestamp) return null;
  return new Date(timestamp * 1000);
};

// GET /shipping-methods — list all active shipping methods
const listShippingMethodsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Shipping Methods"],
  summary: "List all active shipping methods",
  responses: {
    200: {
      description: "Shipping methods list",
      content: { "application/json": { schema: z.object({ shippingMethods: z.array(z.any()) }) } },
    },
    500: {
      description: "Server error",
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
    },
  },
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
      updatedAt: shippingMethodsTable.updatedAt,
    })
    .from(shippingMethodsTable)
    .where(
      and(
        eq(shippingMethodsTable.isActive, 1 as unknown as boolean),
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
      unixToDate(method.createdAt as unknown as number)?.toISOString() ||
      null,
    updatedAt:
      unixToDate(method.updatedAt as unknown as number)?.toISOString() ||
      null,
  }));

  return c.json({ shippingMethods: formattedMethods }, 200);
});

export { app as shippingMethodRoutes };
