import { Hono } from "hono";

import { shippingMethods as shippingMethodsTable } from "@/db/schema"; 
import { eq, isNull, asc, and } from "drizzle-orm";
import { cacheMiddleware } from "../middleware/cache";

const app = new Hono<{ Bindings: Env }>();

// Apply cache middleware
app.use(
  "*",
  cacheMiddleware({
    ttl: 0,
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

app.get("/", async (c) => {
  try {
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

    return c.json({ shippingMethods: formattedMethods });
  } catch (error) {
    console.error("Error fetching shipping methods:", error);
    return c.json({ error: "Failed to fetch shipping methods" }, 500);
  }
});

export { app as shippingMethodRoutes };
