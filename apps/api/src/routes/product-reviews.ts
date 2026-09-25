// Public product review routes (Wave B design §7.1): GET /products/{id}/reviews
// is a keyset page of a buyer-visible product's published reviews with its
// summary. Mounted at /products after the product router (public catalog
// family); cached under the store's cache generation like every /products
// read (`/api/v1/products` prefix in @scalius/shared/public-api-cache-routes).
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getPublicProductReviews, PUBLIC_REVIEW_PAGE_SIZE, PUBLIC_REVIEW_SORTS } from "@scalius/core/modules/catalog";
import { ok } from "../utils/api-response";
import { errorResponses, successEnvelope } from "../schemas/responses";
import { productReviewsSchema } from "../schemas/reviews";
import { NotFoundError } from "../utils/api-error";

const app = new OpenAPIHono<{ Bindings: Env }>();

app.openapi(createRoute({
  method: "get",
  path: "/{id}/reviews",
  tags: ["Products"],
  summary: "A product's published reviews: the summary and one page (Most recent, Highest or Lowest first)",
  request: {
    params: z.object({ id: z.string().trim().min(1).max(128) }),
    query: z.object({
      sort: z.enum(PUBLIC_REVIEW_SORTS).optional(),
      rating: z.coerce.number().int().min(1).max(5).optional().openapi({ description: "Only reviews with this many stars." }),
      cursor: z.string().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(PUBLIC_REVIEW_PAGE_SIZE.max).optional(),
    }),
  },
  responses: {
    200: { description: "Reviews", content: { "application/json": { schema: successEnvelope(productReviewsSchema) } } },
    ...errorResponses,
  },
}), async (c) => {
  const reviews = await getPublicProductReviews(c.get("db"), c.req.valid("param").id, c.req.valid("query"));
  if (!reviews) throw new NotFoundError("Reviews not found");
  return ok(c, reviews);
});

export { app as productReviewRoutes };
