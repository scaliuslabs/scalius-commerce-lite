import { Hono } from "hono";
import { widgets } from "@/db/schema";
import { eq, isNull, and, asc } from "drizzle-orm";
import { cacheMiddleware } from "../middleware/cache";
import type { Widget } from "@/db/schema";

const app = new Hono<{ Bindings: Env }>();

app.use(
  "/active/homepage",
  cacheMiddleware({
    // Increased TTL to 1 hour (3600s).
    // This allows browser/CDN caching (max-age=300) and reduces Redis/DB load.
    ttl: 3600,
    keyPrefix: "api:widgets:active-homepage:",
    varyByQuery: false,
    methods: ["GET"],
  }),
);

app.use(
  "/:id",
  cacheMiddleware({
    // Increased TTL to 1 hour (3600s).
    // This allows browser/CDN caching (max-age=300) and reduces Redis/DB load.
    ttl: 3600,
    keyPrefix: "api:widgets:single:",
    varyByQuery: false,
    methods: ["GET"],
  }),
);

app.get("/:id", async (c) => {
  try {
    const db = c.get("db");
    const widgetId = c.req.param("id");

    if (!widgetId) {
      return c.json({ error: "Widget ID is required" }, 400);
    }

    const widget = (await db
      .select()
      .from(widgets)
      .where(
        and(
          eq(widgets.id, widgetId),
          eq(widgets.isActive, true),
          isNull(widgets.deletedAt),
        ),
      )
      .get()) as Widget | undefined;

    if (!widget) {
      return c.json({ error: "Widget not found" }, 404);
    }

    const convertTimestampToISO = (timestamp: any): string | null => {
      if (timestamp === null || typeof timestamp === "undefined") return null;

      let dateObj: Date | null = null;
      if (timestamp instanceof Date) {
        dateObj = timestamp;
      } else if (typeof timestamp === "number") {
        if (timestamp > 0) {
          dateObj = new Date(timestamp * 1000);
        } else {
          return null;
        }
      } else if (typeof timestamp === "string") {
        const numTimestamp = Number(timestamp);
        if (!isNaN(numTimestamp) && numTimestamp > 0) {
          dateObj = new Date(numTimestamp * 1000);
        } else if (!isNaN(Date.parse(timestamp))) {
          dateObj = new Date(timestamp);
        } else {
          return null;
        }
      }

      if (dateObj && !isNaN(dateObj.getTime())) {
        return dateObj.toISOString();
      }
      return null;
    };

    const formattedWidget = {
      ...widget,
      createdAt: convertTimestampToISO(widget.createdAt),
      updatedAt: convertTimestampToISO(widget.updatedAt),
      deletedAt: convertTimestampToISO(widget.deletedAt),
    };

    return c.json({
      success: true,
      widget: formattedWidget,
    });
  } catch (error) {
    console.error("Error fetching widget:", error);
    if (error instanceof Error) {
      console.error(error.stack);
    }
    return c.json({ error: "Failed to fetch widget" }, 500);
  }
});

// Get active widgets for the homepage
app.get("/active/homepage", async (c) => {
  try {
    const db = c.get("db");
    const activeWidgets = (await db
      .select()
      .from(widgets)
      .where(
        and(
          eq(widgets.isActive, true),
          eq(widgets.displayTarget, "homepage"),
          isNull(widgets.deletedAt),
        ),
      )
      .orderBy(asc(widgets.placementRule), asc(widgets.sortOrder))) as Widget[];

    const formattedWidgets = activeWidgets.map((widget) => {
      const convertTimestampToISO = (timestamp: any): string | null => {
        if (timestamp === null || typeof timestamp === "undefined") return null;

        let dateObj: Date | null = null;
        if (timestamp instanceof Date) {
          dateObj = timestamp;
        } else if (typeof timestamp === "number") {
          if (timestamp > 0) {
            dateObj = new Date(timestamp * 1000);
          } else {
            return null;
          }
        } else if (typeof timestamp === "string") {
          const numTimestamp = Number(timestamp);
          if (!isNaN(numTimestamp) && numTimestamp > 0) {
            dateObj = new Date(numTimestamp * 1000);
          } else if (!isNaN(Date.parse(timestamp))) {
            dateObj = new Date(timestamp);
          } else {
            return null;
          }
        }

        if (dateObj && !isNaN(dateObj.getTime())) {
          return dateObj.toISOString();
        }
        return null;
      };

      return {
        ...widget,
        createdAt: convertTimestampToISO(widget.createdAt),
        updatedAt: convertTimestampToISO(widget.updatedAt),
        deletedAt: convertTimestampToISO(widget.deletedAt),
      };
    });

    return c.json({ widgets: formattedWidgets });
  } catch (error) {
    console.error("Error fetching active homepage widgets:", error);
    if (error instanceof Error) {
      console.error(error.stack);
    }
    return c.json({ error: "Failed to fetch active homepage widgets" }, 500);
  }
});

// Export the widget routes
export { app as widgetRoutes };
