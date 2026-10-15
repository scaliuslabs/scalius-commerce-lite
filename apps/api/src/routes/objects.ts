import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { listPublicObjects } from "@scalius/core/modules/objects";
import { OBJECT_HANDLE_PATTERN, OBJECT_SECTION_RECORDS_MAX, parseObjectTypeHandle } from "@scalius/shared/plugins/objects";
import { NotFoundError } from "../utils/api-error";
import { ok } from "../utils/api-response";
import { errorResponses, successEnvelope } from "../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();
const route = createRoute({
  method: "get", path: "/{type}", operationId: "storefront.objects.list", tags: ["Objects"],
  summary: "List published records of a public object type",
  request: {
    params: z.object({ type: z.string().max(150).refine((value) => parseObjectTypeHandle(value) !== null, "Use a qualified object type, such as custom.testimonial.") }),
    query: z.object({
      handle: z.string().regex(OBJECT_HANDLE_PATTERN).optional(),
      limit: z.coerce.number().int().min(1).max(OBJECT_SECTION_RECORDS_MAX).default(OBJECT_SECTION_RECORDS_MAX),
    }).strict(),
  },
  responses: {
    200: { description: "Published records in merchant order; private reference fields are omitted.", content: { "application/json": { schema: successEnvelope(z.object({
      fields: z.record(z.string(), z.string()),
      records: z.array(z.object({ id: z.string(), handle: z.string().nullable(), data: z.record(z.string(), z.unknown()) })).max(OBJECT_SECTION_RECORDS_MAX),
    })) } } },
    400: errorResponses[400], 404: errorResponses[404], 500: errorResponses[500],
  },
});
app.openapi(route, async (c) => {
  const data = await listPublicObjects(c.get("db"), c.req.valid("param").type, c.req.valid("query"));
  if (!data) throw new NotFoundError("Object type not found");
  return ok(c, data);
});
export { app as publicObjectRoutes };
