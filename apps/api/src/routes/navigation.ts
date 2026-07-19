import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  getNavigationPlacementManifest,
  getPublishedNavigationPlacements,
  getPublishedNavigationMenuTree,
  listPublishedNavigationMenuItems,
} from "@scalius/core/modules/navigation";
import { cacheMiddleware } from "../middleware/cache";
import { CACHE_TTLS } from "../utils/cache-ttls";
import { NotFoundError } from "../utils/api-error";

import { ok } from "../utils/api-response";
import { conflictResponse, successEnvelope, errorResponses } from "../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();

const publicNavigationLeafSchema = z.object({
  id: z.string(),
  title: z.string(),
  href: z.string().optional(),
  openInNewTab: z.boolean().optional(),
});
const publicNavigationChildSchema = publicNavigationLeafSchema.extend({
  subMenu: z.array(publicNavigationLeafSchema).optional(),
});
const publicNavigationItemSchema = publicNavigationLeafSchema.extend({
  subMenu: z.array(publicNavigationChildSchema).optional(),
});

// Apply cache middleware to all routes
app.use(
  "*",
  cacheMiddleware({
    ttl: CACHE_TTLS.STANDARD,
    keyPrefix: "api:navigation:",
    varyByQuery: true,
    methods: ["GET"]
  }),
);

// GET /navigation — get navigation menu items
const getNavigationRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Navigation"],
  summary: "Get navigation menu items",
  request: {
    query: z.object({
      type: z.enum(["header", "footer", "all"]).optional().default("all").openapi({ description: "Navigation type" })
    })
  },
  responses: {
    200: {
      description: "Navigation data",
      content: { "application/json": { schema: successEnvelope(z.object({
        navigation: z.record(z.string(), z.unknown()),
      })) } },
    },
    404: errorResponses[404],
    500: errorResponses[500],
  }
});

app.openapi(getNavigationRoute, async (c) => {
  const { type } = c.req.valid("query");
  const placements = await getPublishedNavigationPlacements(c.get("db"));
  const navigationConfig: Record<string, unknown> = {};
  if (type === "header" || type === "all") {
    navigationConfig.header = placements.find((placement) => (
      placement.surface === "header" && placement.slot === "primary"
    ))?.items ?? [];
  }
  if (type === "footer" || type === "all") {
    navigationConfig.footer = placements
      .filter((placement) => placement.surface === "footer" && placement.slot === "column")
      .map((placement) => ({
        id: placement.id,
        title: placement.labelOverride || placement.menuName,
        links: placement.items,
      }));
  }

  return ok(c, { navigation: navigationConfig });
});

const getPlacementManifestRoute = createRoute({
  method: "get",
  path: "/placements",
  tags: ["Navigation"],
  summary: "Get the current published navigation placement manifest",
  responses: {
    200: {
      description: "Published navigation placements",
      content: { "application/json": { schema: successEnvelope(z.object({
        placements: z.array(z.record(z.string(), z.unknown())),
      })) } },
    },
    500: errorResponses[500],
  },
});

app.openapi(getPlacementManifestRoute, async (c) => {
  c.header("Cache-Control", "no-store");
  return ok(c, { placements: await getNavigationPlacementManifest(c.get("db")) });
});

const publishedMenuQuerySchema = z.object({
  revision: z.coerce.number().int().positive(),
  dependencyRevision: z.coerce.number().int().positive(),
});

const getPublishedMenuRoute = createRoute({
  method: "get",
  path: "/menus/{menuId}",
  tags: ["Navigation"],
  summary: "Get one bounded published menu tree",
  request: {
    params: z.object({ menuId: z.string().min(1) }),
    query: publishedMenuQuerySchema,
  },
  responses: {
    200: {
      description: "Published menu tree",
      content: { "application/json": { schema: successEnvelope(z.object({
        id: z.string(),
        name: z.string(),
        handle: z.string(),
        publishedRevision: z.number().int().positive(),
        dependencyRevision: z.number().int().positive(),
        checksum: z.string(),
        items: z.array(publicNavigationItemSchema),
      })) } },
    },
    404: errorResponses[404],
    409: conflictResponse,
    500: errorResponses[500],
  },
});

app.openapi(getPublishedMenuRoute, async (c) => {
  const { menuId } = c.req.valid("param");
  const query = c.req.valid("query");
  const menu = await getPublishedNavigationMenuTree(c.get("db"), menuId, { maxItems: 150 });
  if (
    menu.publishedRevision !== query.revision
    || menu.dependencyRevision !== query.dependencyRevision
  ) {
    throw new NotFoundError("This navigation revision is no longer current.");
  }
  return ok(c, menu);
});

const getPublishedMenuItemsRoute = createRoute({
  method: "get",
  path: "/menus/{menuId}/items",
  tags: ["Navigation"],
  summary: "Get one parent-paged published menu projection",
  request: {
    params: z.object({ menuId: z.string().min(1) }),
    query: publishedMenuQuerySchema.extend({
      parentId: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      cursor: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Published menu item page",
      content: { "application/json": { schema: successEnvelope(z.object({
        menu: z.record(z.string(), z.unknown()),
        parentId: z.string().nullable(),
        items: z.array(publicNavigationLeafSchema.extend({
          position: z.number().int(),
          childCount: z.number().int().nonnegative(),
        })),
        nextCursor: z.string().nullable(),
      })) } },
    },
    404: errorResponses[404],
    500: errorResponses[500],
  },
});

app.openapi(getPublishedMenuItemsRoute, async (c) => {
  const { menuId } = c.req.valid("param");
  const query = c.req.valid("query");
  let cursor: { position: number; id: string } | undefined;
  if (query.cursor) {
    try {
      const normalized = query.cursor.replaceAll("-", "+").replaceAll("_", "/");
      const decoded = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")));
      if (!Number.isInteger(decoded?.position) || typeof decoded?.id !== "string") throw new Error();
      cursor = decoded;
    } catch {
      throw new NotFoundError("Invalid navigation cursor.");
    }
  }
  const result = await listPublishedNavigationMenuItems(c.get("db"), menuId, {
    parentId: query.parentId ?? null,
    limit: query.limit,
    cursor,
  });
  if (
    result.menu.publishedRevision !== query.revision
    || result.menu.dependencyRevision !== query.dependencyRevision
  ) {
    throw new NotFoundError("This navigation revision is no longer current.");
  }
  const nextCursor = result.nextCursor
    ? btoa(JSON.stringify(result.nextCursor)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "")
    : null;
  return ok(c, { ...result, nextCursor });
});

// GET /navigation/:id — get navigation menu items by ID
const getNavigationByIdRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Navigation"],
  summary: "Get navigation menu by ID",
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Navigation menu data",
      content: { "application/json": { schema: successEnvelope(z.object({
        menu: z.object({
          id: z.string(),
          name: z.string(),
          items: z.array(publicNavigationItemSchema),
        }),
      })) } },
    },
    404: errorResponses[404],
    500: errorResponses[500],
  }
});

app.openapi(getNavigationByIdRoute, async (c) => {
  const { id } = c.req.valid("param");
  const menu = await getPublishedNavigationMenuTree(c.get("db"), id);
  return ok(c, {
    menu: { id: menu.id, name: menu.name, items: menu.items },
  });
});

// Export the navigation routes
export { app as navigationRoutes };
