import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import {
  ADMIN_PATH_TO_GROUPS,
  INVALIDATION_GROUPS,
  getOptionalExecutionContext,
  invalidateApiAndStorefrontGroups,
} from "../utils/cache-invalidation";
import { ValidationError } from "../utils/api-error";
import { ok } from "../utils/api-response";
import {
  errorResponses,
  messageResponse,
  successEnvelope,
} from "../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();

const groupSchema = z.object({
  label: z.string(),
  description: z.string(),
});

const getGroupsRoute = createRoute({
  method: "get",
  path: "/groups",
  tags: ["Cache"],
  summary: "List public cache domains",
  responses: {
    200: {
      description: "Public cache domains and mutation-path mapping",
      content: {
        "application/json": {
          schema: successEnvelope(
            z.object({
              groups: z.record(z.string(), groupSchema),
              pathMapping: z.record(z.string(), z.array(z.string())),
            }),
          ),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(getGroupsRoute, async (c) =>
  ok(c, {
    groups: INVALIDATION_GROUPS,
    pathMapping: ADMIN_PATH_TO_GROUPS,
  }),
);

const clearAllRoute = createRoute({
  method: "post",
  path: "/clear",
  tags: ["Cache"],
  summary: "Purge every public cache domain",
  responses: {
    200: {
      description: "Public caches purged",
      content: { "application/json": { schema: messageResponse } },
    },
    ...errorResponses,
  },
});

app.openapi(clearAllRoute, async (c) => {
  await invalidateApiAndStorefrontGroups(Object.keys(INVALIDATION_GROUPS), c.env, {
    cleanupExecutionCtx: getOptionalExecutionContext(c),
  });
  return ok(c, { message: "All public cache domains purged" });
});

const clearGroupRoute = createRoute({
  method: "post",
  path: "/clear-group",
  tags: ["Cache"],
  summary: "Purge selected public cache domains",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ groups: z.array(z.string()).min(1) }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Selected public caches purged",
      content: {
        "application/json": {
          schema: successEnvelope(
            z.object({
              message: z.string(),
              groups: z.array(z.string()),
            }),
          ),
        },
      },
    },
    ...errorResponses,
  },
});

app.openapi(clearGroupRoute, async (c) => {
  const groups = [
    ...new Set(
      c.req.valid("json").groups.filter((group) => group in INVALIDATION_GROUPS),
    ),
  ];
  if (groups.length === 0) {
    throw new ValidationError("No valid cache domains specified");
  }

  await invalidateApiAndStorefrontGroups(groups, c.env, {
    cleanupExecutionCtx: getOptionalExecutionContext(c),
  });
  return ok(c, {
    message: `Purged public cache domains: ${groups.join(", ")}`,
    groups,
  });
});

export { app as cacheControlRoutes };
