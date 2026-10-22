// URL redirects (Online store -> Navigation -> URL redirects): list, add and
// delete. A product's URL handle change writes its own (products routes).
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  createUrlRedirect,
  deleteUrlRedirect,
  listUrlRedirects,
  URL_REDIRECT_LIST_MAX,
  URL_REDIRECT_PATH_MAX,
} from "@scalius/core/modules/products";
import { ok, created } from "../../utils/api-response";
import { conflictResponse, errorResponses, successEnvelope } from "../../schemas/responses";

const app = new OpenAPIHono<{ Bindings: Env }>();
const TAGS = ["Admin - URL redirects"];

const UrlRedirectResource = z.object({
  id: z.string(),
  fromPath: z.string().openapi({ description: "The old address, a path on the store (/products/old-name)." }),
  toPath: z.string().openapi({ description: "Where it leads, a path on the store." }),
  createdAt: z.string(),
}).openapi("UrlRedirect");

app.openapi(createRoute({
  method: "get",
  path: "/",
  operationId: "dashboard.url_redirects.list",
  tags: TAGS,
  summary: "List URL redirects",
  description: `The newest ${URL_REDIRECT_LIST_MAX} redirects, optionally those whose old or new path contains \`search\`; \`truncated\` says more exist.`,
  request: { query: z.object({ search: z.string().trim().max(URL_REDIRECT_PATH_MAX).optional() }) },
  responses: {
    200: {
      description: "URL redirects",
      content: { "application/json": { schema: successEnvelope(z.object({ redirects: z.array(UrlRedirectResource), truncated: z.boolean() })) } },
    },
    ...errorResponses,
  },
}), async (c) => ok(c, await listUrlRedirects(c.get("db"), { search: c.req.valid("query").search })));

app.openapi(createRoute({
  method: "post",
  path: "/",
  operationId: "dashboard.url_redirects.create",
  tags: TAGS,
  summary: "Add a URL redirect",
  description: "Makes an old store address lead to another. A target that itself redirects is followed (one hop), redirects that led to the old address now lead to the new one, and an existing redirect from the same address is re-pointed.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            fromPath: z.string().trim().min(1).max(2048),
            toPath: z.string().trim().min(1).max(2048),
          }).strict(),
        },
      },
    },
  },
  responses: {
    201: { description: "The redirect", content: { "application/json": { schema: successEnvelope(z.object({ redirect: UrlRedirectResource })) } } },
    ...errorResponses,
    409: conflictResponse,
  },
}), async (c) => created(c, { redirect: await createUrlRedirect(c.get("db"), c.req.valid("json")) }));

app.openapi(createRoute({
  method: "delete",
  path: "/{id}",
  operationId: "dashboard.url_redirects.delete",
  tags: TAGS,
  summary: "Delete a URL redirect",
  request: { params: z.object({ id: z.string().min(1).max(64) }) },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: successEnvelope(z.object({ id: z.string() })) } } },
    ...errorResponses,
  },
}), async (c) => {
  const { id } = c.req.valid("param");
  await deleteUrlRedirect(c.get("db"), id);
  return ok(c, { id });
});

export { app as adminUrlRedirectRoutes };
