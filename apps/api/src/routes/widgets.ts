import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getActiveWidgetById, getActiveHomepageWidgets } from "@scalius/core/modules/widgets";
import { cacheMiddleware } from "../middleware/cache";
import { CACHE_TTLS } from "../utils/cache-ttls";
import { NotFoundError } from "../utils/api-error";

import { ok } from "../utils/api-response";
import { successEnvelope, errorResponses } from "../schemas/responses";
import { publicWidgetSchema } from "../schemas/entities";
const app = new OpenAPIHono<{ Bindings: Env }>();

app.use(
  "/:id",
  cacheMiddleware({
    ttl: CACHE_TTLS.STANDARD,
    keyPrefix: "api:widgets:single:",
    varyByQuery: false,
    methods: ["GET"],
    cacheCondition: (c) => !c.req.path.endsWith("/widgets/active/homepage"),
  }),
);

// GET /widgets/:id — get widget by ID
const getWidgetByIdRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Widgets"],
  summary: "Get widget by ID",
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Widget details",
      content: { "application/json": { schema: successEnvelope(z.object({
        widget: publicWidgetSchema,
      })) } },
    },
    400: errorResponses[400],
    404: errorResponses[404],
    500: errorResponses[500],
  }
});

app.openapi(getWidgetByIdRoute, async (c) => {
  const db = c.get("db");
  const { id: widgetId } = c.req.valid("param");

  const widget = await getActiveWidgetById(db, widgetId);
  if (!widget) {
    throw new NotFoundError("Widget not found");
  }

  return ok(c, { widget });
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
      content: { "application/json": { schema: successEnvelope(z.object({
        widgets: z.array(publicWidgetSchema),
      })) } },
    },
    500: errorResponses[500],
  }
});

app.openapi(getActiveHomepageWidgetsRoute, async (c) => {
  const db = c.get("db");
  const activeWidgets = await getActiveHomepageWidgets(db);
  c.header("Cache-Control", "no-store, max-age=0");
  return ok(c, { widgets: activeWidgets });
});

// Export the widget routes
export { app as widgetRoutes };
