import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { widgets } from "@scalius/database/schema";
import { eq, isNull, and, asc } from "drizzle-orm";
import { cacheMiddleware } from "../middleware/cache";
import type { Widget } from "@scalius/database/schema";
import { NotFoundError } from "../utils/api-error";

const app = new OpenAPIHono<{ Bindings: Env }>();

app.use(
  "/active/homepage",
  cacheMiddleware({
    ttl: 3600,
    keyPrefix: "api:widgets:active-homepage:",
    varyByQuery: false,
    methods: ["GET"],
  }),
);

app.use(
  "/:id",
  cacheMiddleware({
    ttl: 3600,
    keyPrefix: "api:widgets:single:",
    varyByQuery: false,
    methods: ["GET"],
  }),
);

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

// GET /widgets/:id — get widget by ID
const getWidgetByIdRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Widgets"],
  summary: "Get widget by ID",
  request: {
    params: z.object({
      id: z.string().openapi({ description: "Widget ID" }),
    }),
  },
  responses: {
    200: {
      description: "Widget details",
      content: { "application/json": { schema: z.object({ success: z.literal(true), widget: z.any() }) } },
    },
    400: {
      description: "Bad request",
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
    },
    404: {
      description: "Widget not found",
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
    },
    500: {
      description: "Server error",
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
    },
  },
});

app.openapi(getWidgetByIdRoute, async (c) => {
  const db = c.get("db");
  const { id: widgetId } = c.req.valid("param");

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
    throw new NotFoundError("Widget not found");
  }

  const formattedWidget = {
    ...widget,
    createdAt: convertTimestampToISO(widget.createdAt),
    updatedAt: convertTimestampToISO(widget.updatedAt),
    deletedAt: convertTimestampToISO(widget.deletedAt),
  };

  return c.json({
    success: true as const,
    widget: formattedWidget,
  }, 200);
});

// GET /widgets/active/homepage — get active widgets for the homepage
const getActiveHomepageWidgetsRoute = createRoute({
  method: "get",
  path: "/active/homepage",
  tags: ["Widgets"],
  summary: "Get active widgets for the homepage",
  responses: {
    200: {
      description: "Active homepage widgets",
      content: { "application/json": { schema: z.object({ widgets: z.array(z.any()) }) } },
    },
    500: {
      description: "Server error",
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
    },
  },
});

app.openapi(getActiveHomepageWidgetsRoute, async (c) => {
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

  const formattedWidgets = activeWidgets.map((widget) => ({
    ...widget,
    createdAt: convertTimestampToISO(widget.createdAt),
    updatedAt: convertTimestampToISO(widget.updatedAt),
    deletedAt: convertTimestampToISO(widget.deletedAt),
  }));

  return c.json({ widgets: formattedWidgets }, 200);
});

// Export the widget routes
export { app as widgetRoutes };
